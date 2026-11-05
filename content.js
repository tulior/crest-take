/*
 * Crest Take content script.
 *
 * Owns:
 *   - DOM injection and per-post state
 *   - operation metadata discovery
 *   - authenticated GraphQL metadata request
 *   - MP4 selection
 *
 * Does not call chrome.downloads.
 */
(() => {
  'use strict';

  const shared = globalThis.XDLShared;
  if (!shared) return;

  const {
    POST_SELECTOR,
    VIDEO_SELECTOR,
    DOWNLOAD_ATTR,
    findQueryId,
    findBearerToken,
    hasGraphQLErrors,
    selectBestMp4,
    makeFilename,
  } = shared;

  const OP = 'TweetResultByRestId';
  const EMPTY_OBJECT = encodeURIComponent('{}');
  const ATTR_SELECTOR = `[${DOWNLOAD_ATTR}]`;

  class XdlError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Operation metadata                                                  */
  /* ------------------------------------------------------------------ */

  let opCache = null;
  let opPromise = null;
  let opGeneration = 0;

  function invalidateOperation() {
    opGeneration += 1;
    opCache = null;
    opPromise = null;
  }

  // Stable linear partition: inspect main bundles first, other assets in DOM order.
  // Fresh-document URLs are resolved against x.com rather than this tab's path.
  function orderedBundleUrls(scripts, baseUrl) {
    const seen = new Set();
    const main = [];
    const other = [];
    for (const script of scripts) {
      const raw = typeof script === 'string'
        ? script
        : script.getAttribute('src') || script.src;
      let parsed;
      try {
        parsed = new URL(raw, baseUrl);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:' ||
          (parsed.hostname !== 'abs.twimg.com' && parsed.hostname !== 'x.com') ||
          !parsed.pathname.endsWith('.js')) continue;
      const url = parsed.href;
      if (seen.has(url)) continue;
      seen.add(url);
      (parsed.pathname.includes('/main.') ? main : other).push(url);
    }
    return main.concat(other);
  }

  async function currentDocumentBundleUrls() {
    try {
      const response = await fetch('https://x.com/', {
        credentials: 'include',
        cache: 'reload',
      });
      if (!response.ok) return [];
      const html = await response.text();
      // HTML is parsed only as data. Its scripts are neither loaded nor executed.
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      return orderedBundleUrls(parsed.querySelectorAll('script[src]'), 'https://x.com/');
    } catch {
      return [];
    }
  }

  async function scanBundles(urls, seen, found, staleQid, cacheMode) {
    for (const url of urls) {
      if (found.qid && found.token) break;
      if (seen.has(url)) continue;
      seen.add(url);
      let text = '';
      try {
        const response = await fetch(url, {
          credentials: new URL(url).hostname === 'x.com' ? 'include' : 'omit',
          cache: cacheMode,
        });
        if (!response.ok) continue;
        text = await response.text();
      } catch {
        continue;
      }
      if (!found.qid) {
        const candidate = findQueryId(text);
        if (candidate && candidate !== staleQid) found.qid = candidate;
      }
      if (!found.token) found.token = findBearerToken(text);
    }
  }

  async function discoverOperation(fresh = false, staleQid = '') {
    const loaded = orderedBundleUrls(
      document.querySelectorAll('script[src]'), document.baseURI,
    );
    const seen = new Set();
    const found = { qid: '', token: '' };

    if (fresh) {
      // A rotated operation may live in a newly deployed bundle that is not
      // referenced by the still-open tab. Inspect the current page's list first.
      const current = await currentDocumentBundleUrls();
      await scanBundles(current, seen, found, staleQid, 'reload');
      if (!found.qid || !found.token) {
        await scanBundles(loaded, seen, found, staleQid, 'reload');
      }
    } else {
      await scanBundles(loaded, seen, found, '', 'force-cache');
    }

    if (!found.qid || !found.token) {
      throw new XdlError('operation-unavailable');
    }
    return found;
  }

  function findOperation(fresh = false, staleQid = '') {
    if (!fresh && opCache) return Promise.resolve(opCache);
    if (opPromise) return opPromise;

    const generation = opGeneration;
    const promise = discoverOperation(fresh, staleQid)
      .then((operation) => {
        if (generation === opGeneration) opCache = operation;
        return operation;
      })
      .finally(() => {
        if (opPromise === promise) opPromise = null;
      });

    opPromise = promise;
    return promise;
  }

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? match[1] : '';
  }

  async function fetchMetadata(statusId) {
    const attemptedQueryIds = new Set();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) invalidateOperation();

      let operation;
      try {
        operation = await findOperation(attempt > 0, [...attemptedQueryIds][0] || '');
      } catch {
        throw new XdlError('operation-unavailable');
      }

      if (!operation?.qid || !operation?.token) {
        throw new XdlError('operation-unavailable');
      }

      if (attempt > 0 && attemptedQueryIds.has(operation.qid)) {
        invalidateOperation();
        throw new XdlError('query-stale');
      }

      attemptedQueryIds.add(operation.qid);

      const csrfToken = getCsrfToken();
      if (!csrfToken) throw new XdlError('csrf-unavailable');

      const variables = {
        tweetId: statusId,
        includePromotedContent: true,
        withBirdwatchNotes: true,
        withVoice: true,
        withCommunity: true,
      };

      const url =
        'https://x.com/i/api/graphql/' +
        encodeURIComponent(operation.qid) +
        '/' +
        OP +
        '?variables=' +
        encodeURIComponent(JSON.stringify(variables)) +
        '&features=' +
        EMPTY_OBJECT +
        '&fieldToggles=' +
        EMPTY_OBJECT;

      let response;
      try {
        response = await fetch(url, {
          credentials: 'include',
          headers: {
            authorization: 'Bearer ' + operation.token,
            'x-csrf-token': csrfToken,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
          },
        });
      } catch {
        throw new XdlError('metadata-network');
      }

      if (response.status === 404) {
        invalidateOperation();
        if (attempt === 0) continue;
        throw new XdlError('query-stale');
      }

      if (!response.ok) {
        throw new XdlError(
          response.status === 403 ? 'metadata-auth' : 'metadata-http',
        );
      }

      let json;
      try {
        json = await response.json();
      } catch {
        throw new XdlError('metadata-json');
      }

      if (hasGraphQLErrors(json)) {
        throw new XdlError('metadata-errors');
      }

      return json;
    }

    throw new XdlError('query-stale');
  }

  /* ------------------------------------------------------------------ */
  /* DOM scope helpers                                                   */
  /* ------------------------------------------------------------------ */

  function own(scope, selector) {
    const result = [];
    for (const node of scope.querySelectorAll(selector)) {
      if (node.closest(POST_SELECTOR) === scope) result.push(node);
    }
    return result;
  }

  function statusIdFor(scope) {
    for (const time of own(scope, 'time')) {
      const anchor = time.closest('a');
      const href = anchor?.getAttribute('href') || '';
      const match = href.match(/\/status\/(\d+)(?:[\/?#]|$)/);
      if (match) return match[1];
    }

    for (const anchor of own(scope, 'a[href*="/status/"]')) {
      if (anchor.closest('[data-testid="tweetText"]')) continue;
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/\/status\/(\d+)(?:[\/?#]|$)/);
      if (match) return match[1];
    }

    return '';
  }

  function handleFromHref(href) {
    if (!href) return '';

    try {
      const path = new URL(href, location.href).pathname;
      const match = path.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  function authorFor(scope) {
    for (const anchor of own(
      scope,
      '[data-testid="User-Name"] a[role="link"]',
    )) {
      const handle = handleFromHref(anchor.getAttribute('href'));
      if (handle) return handle;    }

    for (const anchor of own(scope, 'a[role="link"]')) {
      const handle = handleFromHref(anchor.getAttribute('href'));
      if (handle) return handle;
    }

    return 'unknown';
  }

  function textFor(scope) {
    const node = own(scope, '[data-testid="tweetText"]')[0];
    if (!node) return '';
    return node.innerText || node.textContent || '';
  }

  function metaFor(scope) {
    return {
      id: statusIdFor(scope),
      handle: authorFor(scope),
      text: textFor(scope),
    };
  }

  function preferredHost(scope) {
    const group = own(scope, '[role="group"]')[0];
    if (group) return group;

    const time = own(scope, 'time')[0];
    if (!time) return null;

    const anchor = time.closest('a');
    return anchor?.parentElement || time.parentElement || null;
  }

  /* ------------------------------------------------------------------ */
  /* UI state                                                            */
  /* ------------------------------------------------------------------ */

  const stateByScope = new WeakMap();
  const controlState = new WeakMap();
  const pendingByRequest = new Map();

  function setBusy(state) {
    state.button.disabled = true;
    state.button.setAttribute('aria-busy', 'true');
    state.button.setAttribute('aria-label', 'Download video');
    state.button.textContent = '…';
    state.button.title = 'Download video';
    state.button.style.color = '#1d9bf0';
  }

  function finishSuccess(state) {
    state.status = 'SUCCEEDED';
    state.requestId = '';
    state.button.disabled = false;
    state.button.removeAttribute('aria-busy');
    state.button.setAttribute('aria-label', 'Download video');
    state.button.textContent = '✓';
    state.button.title = 'Download complete';
    state.button.style.color = '#00ba7c';
  }

  function finishFailure(state) {
    state.status = 'FAILED';
    state.requestId = '';
    state.button.disabled = false;
    state.button.removeAttribute('aria-busy');
    state.button.setAttribute('aria-label', 'Download video');
    state.button.textContent = '✕';
    state.button.title = 'Download failed; click to retry';
    state.button.style.color = '#f4212e';
  }

  function clearEntry(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.acceptTimer !== null) {
      clearTimeout(entry.acceptTimer);
      entry.acceptTimer = null;
    }
  }

  function applyTerminal(requestId, success) {
    const entry = pendingByRequest.get(requestId);
    if (!entry) return;

    pendingByRequest.delete(requestId);
    clearEntry(entry);
    // On terminal UI receipt, delete the durable request and reverse index.
    // Stale unacknowledged records are handled by worker-side pruning.
    void chrome.runtime.sendMessage({ type: 'XDL_ACK', requestId }).catch(() => {});

    const state = entry.state;
    if (!state || state.requestId !== requestId) return;

    if (success) finishSuccess(state);
    else finishFailure(state);
  }

  async function queryStatus(requestId) {
    try {
      return await chrome.runtime.sendMessage({
        type: 'XDL_QUERY',
        requestId,
      });
    } catch {
      return null;
    }
  }

  function startPolling(entry) {
    const tick = async () => {
      entry.timer = null;
      if (!pendingByRequest.has(entry.requestId)) return;

      const response = await queryStatus(entry.requestId);
      if (!pendingByRequest.has(entry.requestId)) return;

      if (response && typeof response.state === 'string') {
        if (
          response.state === 'TRANSFERRING' ||
          response.state === 'STARTING'
        ) {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
        } else if (response.state === 'SUCCEEDED') {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
          applyTerminal(entry.requestId, true);
          return;
        } else if (response.state === 'FAILED') {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
          applyTerminal(entry.requestId, false);
          return;
        }
      }

      if (!pendingByRequest.has(entry.requestId)) return;

      // Durable terminal-change notifications are primary. Poll infrequently
      // after acceptance so missed events still reconcile authoritatively.
      const delay = entry.accepted ? 12_000 : 500;
      entry.timer = setTimeout(tick, delay);
    };

    entry.timer = setTimeout(tick, 250);
  }

  function armAcceptTimeout(entry) {
    entry.acceptTimer = setTimeout(async () => {
      entry.acceptTimer = null;

      if (!pendingByRequest.has(entry.requestId) || entry.accepted) return;

      const response = await queryStatus(entry.requestId);
      if (!pendingByRequest.has(entry.requestId) || entry.accepted) return;

      if (
        response &&
        (response.state === 'TRANSFERRING' ||
          response.state === 'STARTING')
      ) {
        entry.accepted = true;
        return;
      }

      if (response && response.state === 'SUCCEEDED') {
        entry.accepted = true;
        applyTerminal(entry.requestId, true);
        return;
      }

      if (response && response.state === 'FAILED') {
        entry.accepted = true;
        applyTerminal(entry.requestId, false);
        return;
      }

      /*
       * No confirmed acceptance. Do not retry automatically with a new
       * request id; that could duplicate a transfer whose response was lost.
       */
      pendingByRequest.delete(entry.requestId);
      clearEntry(entry);

      const state = entry.state;
      if (state && state.requestId === entry.requestId) {
        finishFailure(state);
      }
    }, 10_000);
  }

  function createControl(scope, identityId) {
    const button = document.createElement('button');
    button.setAttribute(DOWNLOAD_ATTR, '1');
    button.type = 'button';
    button.textContent = '⬇';
    button.title = 'Download video';
    button.setAttribute('aria-label', 'Download video');
    button.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:32px;height:32px;margin-left:8px;border:0;border-radius:9999px;' +
      'background:#1d9bf022;color:#1d9bf0;font-size:15px;line-height:1;' +
      'cursor:pointer';

    const state = {
      scope,
      button,
      identityId: identityId || '',
      status: 'READY',
      requestId: '',
      token: 0,
    };

    controlState.set(button, state);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void activate(state);
    });

    const host = preferredHost(scope) || scope;
    host.appendChild(button);

    return state;
  }

  function ensureScope(scope) {
    if (!(scope instanceof Element) || !scope.isConnected) return;

    let ownControls = own(scope, ATTR_SELECTOR);
    const hasVideo = own(scope, VIDEO_SELECTOR).length > 0;

    let state = stateByScope.get(scope);
    const currentId = statusIdFor(scope);

    if (!hasVideo) {
      for (const control of ownControls) control.remove();

      if (
        state &&
        state.status !== 'RESOLVING' &&
        state.status !== 'TRANSFERRING'
      ) {
        stateByScope.delete(scope);
      }

      return;
    }

    /*
     * A virtualized article may be reused for another status id. Detach the
     * old control before choosing a replacement.
     */
    if (
      state &&
      state.identityId &&
      currentId &&
      state.identityId !== currentId
    ) {
      if (state.button && state.button.isConnected) state.button.remove();
      stateByScope.delete(scope);
      state = null;
      ownControls = own(scope, ATTR_SELECTOR);
    }

    let chosen = state;

    for (const control of ownControls) {
      const candidate = controlState.get(control);
      if (!candidate) continue;

      if (
        candidate.identityId &&
        currentId &&
        candidate.identityId !== currentId
      ) {
        continue;
      }

      if (!chosen) {
        chosen = candidate;
      } else if (
        chosen.status === 'READY' ||
        chosen.status === 'SUCCEEDED' ||
        chosen.status === 'FAILED'
      ) {
        if (
          candidate.status === 'RESOLVING' ||
          candidate.status === 'TRANSFERRING'
        ) {
          chosen = candidate;
        }
      }
    }

    if (
      chosen &&
      chosen.identityId &&
      currentId &&
      chosen.identityId !== currentId
    ) {
      if (chosen.button) chosen.button.remove();
      if (stateByScope.get(scope) === chosen) stateByScope.delete(scope);
      chosen = null;
    }

    /*
     * Exactly one control: remove every own control except the chosen one.
     */
    for (const control of own(scope, ATTR_SELECTOR)) {
      if (!chosen || control !== chosen.button) control.remove();
    }

    if (!chosen) {
      chosen = createControl(scope, currentId);
      if (!chosen) return;
    } else if (!chosen.identityId && currentId) {
      chosen.identityId = currentId;
    }

    stateByScope.set(scope, chosen);

    const host = preferredHost(scope) || scope;
    if (chosen.button.parentElement !== host) {
      host.appendChild(chosen.button);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Activation state machine                                            */
  /* ------------------------------------------------------------------ */

  async function activate(state) {
    if (
      state.status === 'RESOLVING' ||
      state.status === 'TRANSFERRING'
    ) {
      return;
    }

    if (!state.button.isConnected || !state.scope.isConnected) return;

    const attempt = ++state.token;
    state.status = 'RESOLVING';
    state.requestId = '';
    setBusy(state);

    let requestId = '';

    try {
      const initial = metaFor(state.scope);
      if (!initial.id) throw new XdlError('missing-post-id');

      const json = await fetchMetadata(initial.id);

      if (
        state.token !== attempt ||
        !state.button.isConnected ||
        !state.scope.isConnected
      ) {
        return;
      }

      const latest = metaFor(state.scope);
      if (!latest.id || latest.id !== initial.id) {
        throw new XdlError('post-changed');
      }

      const best = selectBestMp4(json);
      if (!best) throw new XdlError('no-mp4');

      const filename = makeFilename(latest);

      requestId = crypto.randomUUID();
      state.requestId = requestId;
      state.status = 'TRANSFERRING';
      state.button.textContent = '…';
      state.button.setAttribute('aria-busy', 'true');

      const entry = {
        requestId,
        state,
        accepted: false,
        timer: null,
        acceptTimer: null,
      };

      pendingByRequest.set(requestId, entry);
      startPolling(entry);
      armAcceptTimeout(entry);

      let response = null;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'XDL_DOWNLOAD',
          requestId,
          url: best.url,
          filename,
        });
      } catch {
        /*
         * Ambiguous transport failure. The polling path will query by the
         * same request id. It never creates a second request id automatically.
         */
      }

      if (!pendingByRequest.has(requestId)) return;
      if (state.token !== attempt || state.requestId !== requestId) return;

      if (response && typeof response === 'object') {
        const responseState =
          typeof response.state === 'string' ? response.state : '';

        if (
          responseState === 'TRANSFERRING' ||
          responseState === 'STARTING'
        ) {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
        } else if (responseState === 'SUCCEEDED') {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
          applyTerminal(requestId, true);
          return;
        } else if (
          responseState === 'FAILED' ||
          response.ok === false
        ) {
          entry.accepted = true;
          if (entry.acceptTimer !== null) {
            clearTimeout(entry.acceptTimer);
            entry.acceptTimer = null;
          }
          applyTerminal(requestId, false);
          return;
        }
      }
    } catch {
      if (state.token !== attempt) return;

      if (requestId && pendingByRequest.has(requestId)) {
        applyTerminal(requestId, false);
      } else {
        finishFailure(state);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mutation-aware injection                                            */
  /* ------------------------------------------------------------------ */

  const scopesToProcess = new Set();
  let flushTimer = null;

  function scheduleScope(scope) {
    if (!(scope instanceof Element) || !scope.isConnected) return;

    scopesToProcess.add(scope);

    if (flushTimer !== null) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;

      const batch = [...scopesToProcess];
      scopesToProcess.clear();

      for (const candidate of batch) {
        if (candidate.isConnected) ensureScope(candidate);
      }
    }, 150);
  }

  function processNode(node) {
    if (!node) return;

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) processNode(child);
      return;
    }

    let element = null;
    if (node.nodeType === Node.ELEMENT_NODE) {
      element = node;
    } else if (node.parentElement) {
      element = node.parentElement;
    }

    if (!element) return;

    if (element.isConnected) {
      const nearest = element.closest(POST_SELECTOR);
      if (nearest) scheduleScope(nearest);
    }

    if (element.matches?.(POST_SELECTOR)) scheduleScope(element);

    if (element.querySelectorAll) {
      for (const post of element.querySelectorAll(POST_SELECTOR)) {
        scheduleScope(post);
      }
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target =
        record.target.nodeType === Node.ELEMENT_NODE
          ? record.target
          : record.target.parentElement;

      if (target?.isConnected) {
        const nearest = target.closest(POST_SELECTOR);
        if (nearest) scheduleScope(nearest);
      }

      if (record.type === 'childList') {
        for (const node of record.addedNodes) processNode(node);
      }
    }
  });

  function initialScan() {
    for (const scope of document.querySelectorAll(POST_SELECTOR)) {
      ensureScope(scope);
    }
  }

  function boot() {
    const root = document.documentElement;
    if (!root) return;

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid', 'href', 'role'],
    });

    initialScan();
  }

  if (document.documentElement) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (
      !message ||
      message.type !== 'XDL_STATE' ||
      typeof message.requestId !== 'string'
    ) {
      return;
    }

    if (
      message.state === 'TRANSFERRING' ||
      message.state === 'STARTING'
    ) {
      const entry = pendingByRequest.get(message.requestId);
      if (entry && !entry.accepted) {
        entry.accepted = true;
        if (entry.acceptTimer !== null) {
          clearTimeout(entry.acceptTimer);
          entry.acceptTimer = null;
        }
      }
      return;
    }

    if (message.state === 'SUCCEEDED') {
      applyTerminal(message.requestId, true);
    } else if (message.state === 'FAILED') {
      applyTerminal(message.requestId, false);
    }
  });
})();
