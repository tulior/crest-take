/*
 * Crest Take — Manifest V3.
 *
 * One behaviour: put a download button on every video post, and save that
 * post's best MP4 when it is clicked. One file, two execution contexts — the
 * content script owns the DOM and the GraphQL call, the service worker owns
 * Chrome's download manager. Chrome forces that split: chrome.downloads exists
 * only in a worker, the DOM only in a page.
 *
 * Protocol, from an observed x.com GraphQL exchange:
 *
 *   GET https://x.com/i/api/graphql/<queryId>/TweetResultByRestId
 *       ?variables={"tweetId":…,"includePromotedContent":true,
 *                   "withBirdwatchNotes":true,"withVoice":true,"withCommunity":true}
 *       &features={}&fieldToggles={}
 *
 *   The credential is the browser's own session cookie PLUS the app-level
 *   Bearer token that the web client ships in its own bundle. That Bearer is
 *   the gate: with a valid session but no Authorization header the endpoint
 *   answers 403, and no amount of feature switches or transaction ids makes
 *   it accept the call. It is read out of the client build at runtime, never
 *   hardcoded. x-csrf-token echoes the page's ct0 cookie and must match the
 *   cookie that rides along with the request.
 *
 *   features and fieldToggles may be empty: the endpoint accepts them empty
 *   and still returns the full media set. The client sends a large switch
 *   set, but none of it is required.
 *
 *   <queryId> is a build hash X rotates, so it is never hardcoded either: it
 *   comes from the client bundle's operation registry. A rotated id is
 *   answered with 404 "Query not found", which is how it is detected.
 *
 *   Media is at legacy.extended_entities.media[]; the highest-bitrate video/mp4
 *   variant wins, and animated_gif media is served as an mp4 too.
 */
(() => {
  'use strict';

  /* ==================== service worker ==================== */
  if (typeof document === 'undefined') {
    const waiting = new Map(); // downloadId -> reply
    chrome.runtime.onMessage.addListener((m, s, reply) => {
      chrome.downloads.download(
        { url: m.url, filename: m.filename, conflictAction: 'uniquify' },
        (id) => (id == null ? reply(false) : waiting.set(id, reply))
      );
      return true; // the reply carries the outcome, sent once Chrome finishes
    });
    // Chrome's download lifecycle is the only authority on success.
    chrome.downloads.onChanged.addListener((d) => {
      if (!d.state || d.state.current === 'in_progress') return;
      waiting.get(d.id)?.(d.state.current === 'complete');
      waiting.delete(d.id);
    });
    return;
  }

  /* ==================== content script ==================== */
  const OP = 'TweetResultByRestId';
  const POST = 'article[data-testid="tweet"],[data-testid="quoteTweet"]';
  const VID = 'video,[data-testid="videoPlayer"],[data-testid="videoComponent"]';
  const EMPTY = encodeURIComponent('{}');

  let opP; // the resolved operation

  const csrf = () => (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || '';
  // a node's own post is the nearest one it sits in, so a quoted video is
  // never mistaken for the parent's
  const own = (sc, sel) => [...sc.querySelectorAll(sel)].filter((n) => n.closest(POST) === sc);
  const clean = (s = '') =>
    s.replace(/https?:\/\/\S+/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/@\w+/g, '').replace(/#(\w+)/g, '$1').replace(/\s+/g, ' ')
      .trim().slice(0, 80) || 'video';

  /* ---------- the operation, discovered live ---------- */
  const QRE = new RegExp('queryId:"([\\w-]{12,40})",operationName:"' + OP + '"');
  const TRE = /"Bearer (AAAAAAA[A-Za-z0-9%_-]+)"/;

  // One pass over the page's own bundles: the operation id and the app
  // bearer both live in the client build, and abs.twimg.com serves them
  // with access-control-allow-origin: *, so no host permission is needed.
  async function discover() {
    const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.src)
      .sort((a, b) => (b.includes('/main.') ? 1 : 0) - (a.includes('/main.') ? 1 : 0));
    let qid = null, token = null;
    for (const s of srcs) {
      const text = await fetch(s).then((r) => r.text()).catch(() => '');
      if (!text) continue;
      qid ||= text.match(QRE)?.[1];
      token ||= text.match(TRE)?.[1];
      if (qid && token) break;
    }
    if (!qid || !token) throw new Error('operation unavailable');
    return { qid, token };
  }

  // discovered once; a failure clears the cache so the next click tries again
  const findOp = () => (opP ??= discover().catch((e) => { opP = null; throw e; }));

  /* ---------- one media resolution ---------- */
  async function gql(id) {
    for (let a = 0; a < 2; a++) {
      const o = await findOp().catch(() => null);
      if (!o) return {};
      const vars = {
        tweetId: id,
        includePromotedContent: true,
        withBirdwatchNotes: true,
        withVoice: true,
        withCommunity: true,
      };
      const url =
        'https://x.com/i/api/graphql/' + o.qid + '/' + OP +
        '?variables=' + encodeURIComponent(JSON.stringify(vars)) +
        '&features=' + EMPTY + '&fieldToggles=' + EMPTY;
      const r = await fetch(url, {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + o.token,
          'x-csrf-token': csrf(),
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
        },
      }).catch(() => null);
      if (!r) return {};
      if (r.status === 404) { opP = null; continue; } // the query id was rotated
      if (!r.ok) return {};
      const j = await r.json().catch(() => ({}));
      if (!j.errors) return j;
    }
    return {};
  }

  const mediaOf = (j) =>
    (j?.data?.tweetResult?.result?.legacy?.extended_entities?.media || [])
      .flatMap((m) => (m.video_info?.variants || [])
        .filter((v) => /mp4/i.test(v.content_type) && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        .at(0))
      .filter(Boolean)
      .map((v) => v.url);

  /* ---------- the post behind a scope ---------- */
  function meta(sc) {
    const t = own(sc, 'time')[0];
    const a = own(sc, 'a[role="link"][href^="/"]').find((x) =>
      /^\/[\w]{1,15}$/.test(x.getAttribute('href'))
    );
    const x = own(sc, '[data-testid="tweetText"]')[0];
    return {
      id: t?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || '',
      handle: a?.getAttribute('href').slice(1) || 'unknown',
      text: clean(x?.innerText),
    };
  }

  /* ---------- the action ---------- */
  async function grab(sc, b) {
    if (b.disabled) return; // the button is the lock
    const m = meta(sc);
    if (!m.id) return;
    b.disabled = true;
    b.textContent = '…';

    const urls = mediaOf(await gql(m.id));
    const done = await Promise.all(urls.map((u, i) => {
      const name =
        'x-videos/' + m.handle + '_' + m.text +
        (urls.length > 1 ? '_' + (i + 1) : '') + '.mp4';
      return chrome.runtime.sendMessage({ t: 'dl', url: u, filename: name })
        .catch(() => false);
    }));

    b.disabled = false;
    b.textContent = done.length && done.every(Boolean) ? '✓' : '✕';
    b.style.color = done.length && done.every(Boolean) ? '#00ba7c' : '#f4212e';
  }

  /* ---------- the button ---------- */
  function inject() {
    for (const sc of document.querySelectorAll(POST)) {
      if (sc.querySelector('[data-xdl]') || !own(sc, VID).length) continue;
      // an action bar if the post has one, otherwise its timestamp
      const t = own(sc, 'time')[0];
      const host = own(sc, '[role="group"]')[0] || t?.closest('a')?.parentElement;
      if (!host) continue;

      const b = document.createElement('button');
      b.setAttribute('data-xdl', '1');
      b.type = 'button';
      b.textContent = '⬇';
      b.title = 'Download video';
      b.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;' +
        'margin-left:8px;border:0;border-radius:9999px;background:#1d9bf022;color:#1d9bf0;' +
        'font-size:15px;cursor:pointer';
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); grab(sc, b); };
      host.appendChild(b);
    }
  }

  // posts render lazily and virtualize, so watch for new ones
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(inject, 200);
  }).observe(document.body, { childList: true, subtree: true });

  inject();
})();
