/*
 * Integration test for the X Video Downloader extension.
 *
 * Runs BOTH execution contexts of x.js against the real GraphQL payload and
 * the real client bundle captured in x.com.har, sharing one emulated Chrome
 * platform (messaging + downloads) so the cross-context protocol is exercised
 * for real. There is no storage: completion travels back as the reply to the
 * message that started the download.
 *
 * The content-script sandbox deliberately has NO `performance` object: the
 * extension must not depend on resource timing, whose 250-entry buffer
 * overflows on x.com long before a user clicks anything.
 *
 * Scenarios:
 *   A) the normal path: bundle -> operation id + app bearer -> media
 *   B) the client bundle cannot be read      -> failure feedback
 *   C) the operation id was rotated (404)     -> re-discover and retry
 *   D) an interrupted download                -> failure feedback
 *   E) a quoted video post                    -> two buttons, each resolving
 *      its OWN post, never the parent's
 *
 * Plus the invariants that are easy to lose in a refactor: a mutation must
 * not inject a second button, and a second click must not start a second
 * download.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HAR = process.argv[2] ||
  'C:\\Users\\tulio\\.minimax\\v2\\assets\\2026\\10\\26\\16-07-52-141-asset_20261026-160752-141_fda9d7e5b86e_28b749eb-x.com.har';
const EXT = path.join(__dirname, '..');
const TWEET_ID = '2114572412054274285';
const QUOTE_ID = '2114572412054274286';
const EXPECT_MP4 =
  'https://video.twimg.com/amplify_video/2114572381842714624/vid/avc1/962x720/zyHZvTSE7AOz7BIc.mp4';

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

/* ---------------- HAR ---------------- */

const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
const gqlEntry = har.log.entries.find((e) => e.request.url.includes('/TweetResultByRestId?'));
const mainEntry = har.log.entries.find((e) => /\/main\.[a-f0-9]+\.js$/.test(e.request.url));
if (!gqlEntry || !mainEntry) throw new Error('HAR missing required entries');

const gqlBody = Buffer.from(gqlEntry.response.content.text, 'base64').toString('utf8');
const mainJs = mainEntry.response.content.text;
const bundleUrl = mainEntry.request.url;

// the app bearer the real client sends, as it appears in the client build
const BEARER = mainJs.match(/"Bearer (AAAAAAA[A-Za-z0-9%_-]+)"/)[1];
console.log('HAR bundle: ' + bundleUrl.split('/').pop() + '  app bearer: ' + BEARER.slice(0, 28) + '…');

/* ---------------- tiny DOM ---------------- */

function matchOne(el, part) {
  const m = /^([a-zA-Z]*)(.*)$/.exec(part);
  const tag = m[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const a of m[2].match(/\[[^\]]+\]/g) || []) {
    const eq = /^\[([\w-]+)(\^?=)?"?([^"\]]*)"?\]$/.exec(a);
    if (!eq) continue;
    const name = eq[1], op = eq[2], val = eq[3];
    const have = el.getAttribute(name);
    if (have == null) return false;
    if (op === '=') { if (String(have) !== val) return false; }
    else if (op === '^=') { if (!String(have).startsWith(val)) return false; }
  }
  return true;
}

const matchSel = (el, sel) => sel.split(',').some((p) => matchOne(el, p.trim()));

function collect(node, sel, out) {
  for (const c of node.children || []) {
    if (matchSel(c, sel)) out.push(c);
    collect(c, sel, out);
  }
}

function El(tag, attrs, opts) {
  opts = opts || {};
  const self = {
    tagName: tag.toUpperCase(),
    attrs: Object.assign({}, attrs),
    children: [],
    style: { cssText: '' },
    textContent: '',
    innerText: opts.text || '',
    value: opts.value,
    listeners: {},
    parent: null,
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    get isConnected() { return !!this.parent; },
    get parentElement() { return this.parent; },
    matches(s) { return matchSel(this, s); },
    closest(s) {
      let n = this;
      while (n) { if (n.matches && n.matches(s)) return n; n = n.parent; }
      return null;
    },
    querySelector(s) { return this.querySelectorAll(s)[0] || null; },
    querySelectorAll(s) { const o = []; collect(this, s, o); return o; },
    attachShadow() { const sh = makeShadow(); this.shadow = sh; return sh; },
  };
  for (const c of opts.children || []) self.appendChild(c);
  return self;
}

function makeShadow() {
  const cache = {};
  return {
    set innerHTML(v) { this._h = v; },
    get innerHTML() { return this._h; },
    querySelector(s) { return (cache[s] = cache[s] || El('div', {})); },
  };
}

/* A post: handle link, tweet text, video, action bar, and a timestamp that
 * lives inside the permalink (as it does on x.com). With `quote`, the post
 * also embeds a quoted post that has a video of its own. */
function buildPost(handle, id, text, withQuote) {
  const scope = El('article', { 'data-testid': 'tweet' });
  const permalink = El('a', { href: '/' + handle + '/status/' + id });
  permalink.appendChild(El('time', {}));
  const handleLink = El('a', { href: '/' + handle, role: 'link' });
  const textEl = El('span', { 'data-testid': 'tweetText' }, { text });
  const group = El('div', { role: 'group' });
  const video = El('video', {});
  for (const n of [permalink, handleLink, textEl, group, video]) scope.appendChild(n);

  let quoted = null;
  if (withQuote) {
    // the quote is its own scope, holding its own handle, text and video
    const q = buildPost('otherhandle', QUOTE_ID, 'Cita citada', false);
    quoted = El('div', { 'data-testid': 'quoteTweet' });
    for (const c of q.scope.children) quoted.appendChild(c);
    scope.appendChild(quoted);
  }
  return { scope, group, video, quoted };
}

function buildDom(withQuote) {
  const body = El('body', {});
  const doc = {
    body,
    cookie: 'ct0=test-csrf-token-value; guest_id=v1%3A123',
    createElement: (t) => El(t, {}),
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
  };

  const post = buildPost('Rayo_Libertario', TWEET_ID,
    'Maldita sea, es demasiado bueno para dejarlo pasar', withQuote);
  body.appendChild(post.scope);

  const script = El('script', { src: bundleUrl });
  script.src = bundleUrl;
  body.appendChild(script);

  doc.__post = post;
  return doc;
}

/* ---------------- emulated Chrome platform ---------------- */

function makePlatform() {
  const specs = [];
  const messageListeners = [];
  const changedListeners = [];

  const runtime = {
    onMessage: { addListener: (f) => messageListeners.push(f) },
    sendMessage(msg) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        for (const f of messageListeners) f(msg, { tab: { id: 42 } }, done);
        setTimeout(() => done(undefined), 30000); // nobody answered
      });
    },
  };

  const downloads = {
    download(opts, cb) {
      specs.push(opts);
      setImmediate(() => cb(specs.length));
    },
    onChanged: { addListener: (f) => changedListeners.push(f) },
  };

  return { runtime, downloads, specs, changedListeners };
}

/* ---------------- boot both contexts ---------------- */

function boot(withQuote, mode) {
  const fetched = [];
  let staleLeft = mode === 'stale';
  const fetchStub = async (url, opts) => {
    fetched.push({ url: String(url), opts: opts || {} });
    const u = String(url);
    if (u.includes('/i/api/graphql/')) {
      if (staleLeft) { staleLeft = false; return { ok: false, status: 404, json: async () => ({ message: 'Query not found' }) }; }
      if (mode === 'error') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(gqlBody) };
    }
    if (u.includes('/main.') && u.endsWith('.js')) {
      if (mode === 'nobundle') return { ok: false, status: 404, text: async () => { throw new Error('blocked'); } };
      return { ok: true, status: 200, text: async () => mainJs };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const plat = makePlatform();

  /* ---- service worker ---- */
  const swChrome = { runtime: plat.runtime, downloads: plat.downloads };
  class SWGlobalScope {}
  const swCtx = vm.createContext({
    console, setTimeout, clearTimeout, setImmediate, URL, fetch: fetchStub,
    ServiceWorkerGlobalScope: SWGlobalScope, chrome: swChrome, self: {},
  });
  Object.setPrototypeOf(swCtx, SWGlobalScope.prototype);
  swCtx.self = swCtx;
  vm.runInContext(fs.readFileSync(path.join(EXT, 'x.js'), 'utf8'), swCtx, { filename: 'x.js' });

  /* ---- content script (no `performance`: resource timing must not be used) ---- */
  const doc = buildDom(withQuote);
  let observer = null;
  const csCtx = vm.createContext({
    console, setTimeout, clearTimeout, setImmediate, URL, fetch: fetchStub,
    document: doc,
    MutationObserver: class { constructor(cb) { this.cb = cb; observer = this; } observe() {} disconnect() {} },
    chrome: { runtime: plat.runtime }, self: {},
  });
  csCtx.self = csCtx;
  csCtx.window = csCtx;
  vm.runInContext(fs.readFileSync(path.join(EXT, 'x.js'), 'utf8'), csCtx, { filename: 'x.js' });

  return { plat, doc, fetched, mutate: () => observer && observer.cb() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- scenario ---------------- */

async function scenario(name, outcome) {
  console.log('\n--- scenario ' + name + ' ---');
  const { plat, doc, fetched, mutate } = boot(false, null);

  await wait(30);

  const btn = doc.__post.group.querySelector('[data-xdl]');
  check('download button injected on the video post', !!btn);
  if (!btn) return;
  check('button starts idle', btn.textContent === '⬇', btn.textContent);

  btn.onclick({ preventDefault() {}, stopPropagation() {} });
  await wait(200);

  check('button shows pending while the download runs', btn.textContent === '…', btn.textContent);
  check('button is disabled while pending', btn.disabled === true);

  check('chrome.downloads.download called', plat.specs.length === 1, JSON.stringify(plat.specs));
  const spec = plat.specs[0];
  check('download url is the highest-bitrate mp4',
    spec && spec.url.split('?')[0] === EXPECT_MP4, spec && spec.url);
  check('filename lands under x-videos/',
    spec && /^x-videos\/Rayo_Libertario_.*\.mp4$/.test(spec.filename), spec && spec.filename);
  check('filename is sanitized',
    spec && !/https?:\/\//.test(spec.filename) && !/[<>:"/\\|?*]/.test(spec.filename.replace('x-videos/', '')),
    spec && spec.filename);

  const gqlFetches = fetched.filter((f) => f.url.includes('/i/api/graphql/'));
  const calls = gqlFetches.map((f) => f.url);
  check('exactly one graphql request', calls.length === 1, String(calls.length));
  check('graphql op is TweetResultByRestId', calls[0] && calls[0].includes('/TweetResultByRestId?'));
  check('graphql carries the tweet id', calls[0] && calls[0].includes(encodeURIComponent(TWEET_ID)));
  check('graphql carries the full variable set',
    calls[0] && /includePromotedContent|withBirdwatchNotes/.test(decodeURIComponent(calls[0])));
  check('graphql carries x-csrf-token from the ct0 cookie',
    gqlFetches[0] && gqlFetches[0].opts.headers && gqlFetches[0].opts.headers['x-csrf-token'] === 'test-csrf-token-value',
    gqlFetches[0] && JSON.stringify(gqlFetches[0].opts.headers));
  check('graphql sends credentials so the session cookie rides along',
    gqlFetches[0] && gqlFetches[0].opts.credentials === 'include');
  check('graphql sends the app bearer from the client bundle',
    gqlFetches[0] && gqlFetches[0].opts.headers.authorization === 'Bearer ' + BEARER,
    gqlFetches[0] && gqlFetches[0].opts.headers.authorization);
  check('the bearer is not hardcoded in the source',
    !fs.readFileSync(path.join(EXT, 'x.js'), 'utf8').includes(BEARER));
  check('features and fieldToggles are sent empty',
    calls[0] && calls[0].includes('features=%7B%7D') && calls[0].includes('fieldToggles=%7B%7D'),
    calls[0]);
  check('no REST statuses/show.json call', !fetched.some((f) => f.url.includes('statuses/show.json')));
  check('no v1.1 video API call', !fetched.some((f) => f.url.includes('video/1.1/show.json')));
  check('no transaction id is needed or sent',
    !gqlFetches[0] || !gqlFetches[0].opts.headers['x-client-transaction-id']);
  check('query id is the registry value', calls[0] && calls[0].includes('/graphql/a-Xpq8PjX9K6U5cmc1f05A/'));
  check('the client bundle was read once',
    fetched.filter((f) => f.url.endsWith('.js')).length === 1,
    String(fetched.filter((f) => f.url.endsWith('.js')).length));

  /* ---- invariants that a refactor can silently lose ---- */
  mutate();                       // a DOM mutation re-runs injection
  await wait(300);
  check('a mutation does not inject a second button',
    doc.__post.group.querySelectorAll('[data-xdl]').length === 1,
    String(doc.__post.group.querySelectorAll('[data-xdl]').length));

  btn.onclick({ preventDefault() {}, stopPropagation() {} }); // click again mid-flight
  await wait(100);
  check('a second click does not start a second download', plat.specs.length === 1, String(plat.specs.length));

  /* ---- Chrome's download lifecycle decides the feedback ---- */
  plat.changedListeners.forEach((f) => f({ id: 1, state: { current: 'in_progress' } }));
  await wait(60);
  check('still pending while in progress', btn.textContent === '…', btn.textContent);

  plat.changedListeners.forEach((f) =>
    f({ id: 1, state: { current: outcome }, error: { current: 'SERVER_BAD_CONTENT' } })
  );
  await wait(150);

  if (outcome === 'complete') {
    check('button shows saved after Chrome reports complete', btn.textContent === '✓', btn.textContent);
    check('button is clickable again', btn.disabled === false);
  } else {
    check('button shows failed after Chrome interrupts', btn.textContent === '✕', btn.textContent);
    check('button is clickable again', btn.disabled === false);
  }
}

/* ---------------- quoted post ---------------- */

async function quoteScenario() {
  console.log('\n--- scenario E: quoted post with its own video ---');
  const { plat, doc, fetched } = boot(true, null);
  await wait(30);

  const outer = doc.__post.group.querySelector('[data-xdl]');
  const quoted = doc.__post.scope.querySelector('[data-testid="quoteTweet"]');
  const inner = quoted.querySelector('[data-xdl]');

  check('the parent post got a button', !!outer);
  check('the quoted post got its own button', !!inner);
  if (!outer || !inner) return;
  check('the two buttons are distinct', outer !== inner);

  // the quoted video must resolve to the QUOTED post, not the parent
  inner.onclick({ preventDefault() {}, stopPropagation() {} });
  await wait(250);

  const calls = fetched.filter((f) => f.url.includes('/i/api/graphql/')).map((f) => f.url);
  check('the quoted button resolves the quoted post id',
    calls.length === 1 && calls[0].includes(encodeURIComponent(QUOTE_ID)), calls[0]);
  check('the quoted button does not resolve the parent id',
    !calls[0] || !calls[0].includes(encodeURIComponent(TWEET_ID)), calls[0]);
  check('the quoted download is named after the quoted author',
    plat.specs[0] && /^x-videos\/otherhandle_.*\.mp4$/.test(plat.specs[0].filename),
    plat.specs[0] && plat.specs[0].filename);

  // and the parent's video must still resolve the parent post
  outer.onclick({ preventDefault() {}, stopPropagation() {} });
  await wait(250);
  const calls2 = fetched.filter((f) => f.url.includes('/i/api/graphql/')).map((f) => f.url);
  check('the parent button resolves the parent post id',
    calls2.length === 2 && calls2[1].includes(encodeURIComponent(TWEET_ID)), calls2[1]);
  check('the parent download is named after the parent author',
    plat.specs[1] && /^x-videos\/Rayo_Libertario_.*\.mp4$/.test(plat.specs[1].filename),
    plat.specs[1] && plat.specs[1].filename);
}

/* ---------------- failure modes ---------------- */

async function failureScenario(name, mode, label) {
  console.log('\n--- scenario F: ' + name + ' ---');
  const { plat, doc } = boot(false, mode);
  await wait(30);

  const btn = doc.__post.group.querySelector('[data-xdl]');
  check('button injected', !!btn);
  if (!btn) return;

  btn.onclick({ preventDefault() {}, stopPropagation() {} });
  await wait(500);

  check('no download was started', plat.specs.length === 0, String(plat.specs.length));
  check('the button reports failure', btn.textContent === '✕', btn.textContent);
  check('the button is usable again', btn.disabled === false);
}

/* ---------------- manifest ---------------- */

function manifestChecks() {
  console.log('\n--- manifest ---');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const perms = manifest.permissions || [];
  check('manifest v3', manifest.manifest_version === 3);
  check('the downloads permission is the only one', perms.length === 1 && perms[0] === 'downloads', perms.join(','));
  check('no storage permission', !perms.includes('storage'));
  check('no host permissions at all', !manifest.host_permissions, JSON.stringify(manifest.host_permissions));
  check('the service worker is x.js', manifest.background.service_worker === 'x.js');
  check('the content script is x.js', manifest.content_scripts[0].js.join() === 'x.js');
  check('the content script matches x.com only',
    manifest.content_scripts[0].matches.join() === 'https://x.com/*',
    manifest.content_scripts[0].matches.join(','));
  // the product name must not carry the platform's mark
  check('the display name carries no platform mark',
    !/(\bx\b|twitter|tweet)/i.test(manifest.name), manifest.name);
  check('short_name fits the 12-character limit', (manifest.short_name || '').length <= 12, manifest.short_name);

  // the extension must ship exactly its two source files, at any depth
  const src = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'test' || e.name === 'docs') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json)$/.test(e.name)) src.push(e.name);
    }
  })(EXT);
  check('the extension ships exactly manifest.json and x.js', src.sort().join() === 'manifest.json,x.js', src.join(','));
}

/* ---------------- run ---------------- */

(async () => {
  manifestChecks();
  await scenario('A: bundle -> operation id + bearer -> media', 'complete');
  await scenario('D: download interrupted -> failure feedback', 'interrupted');
  await quoteScenario();
  await failureScenario('the client bundle cannot be read', 'nobundle');
  await failureScenario('graphql returns an error', 'error');

  console.log('\n--- scenario C: the operation id was rotated ---');
  {
    const { plat, doc, fetched } = boot(false, 'stale');
    await wait(30);
    const btn = doc.__post.group.querySelector('[data-xdl]');
    check('button injected', !!btn);
    if (btn) {
      btn.onclick({ preventDefault() {}, stopPropagation() {} });
      await wait(500);
      const calls = fetched.filter((f) => f.url.includes('/i/api/graphql/')).map((f) => f.url);
      check('it re-discovered the operation and retried', calls.length === 2, String(calls.length));
      check('the retry succeeded', plat.specs.length === 1, String(plat.specs.length));
    }
  }

  console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
})();
