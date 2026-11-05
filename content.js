(() => {
  'use strict';
  const INSTALL_GUARD = '__crestTakeInstalledV2__';
  if (globalThis[INSTALL_GUARD]) return;
  globalThis[INSTALL_GUARD] = true;
  const Core = globalThis.CrestTakeCore;
  const OPERATION_NAME = 'TweetResultByRestId';
  const POST_SELECTOR = 'article[data-testid="tweet"],[data-testid="quoteTweet"]';
  const VIDEO_SELECTOR =
    'video,[data-testid="videoPlayer"],[data-testid="videoComponent"]';
  const CONTROL_SELECTOR = 'button[data-crest-take-control="1"]';
  // These are runtime value-shape patterns from the supplied observed client
  // bundle, not embedded query IDs or credentials.
  const QUERY_ID_RE =
    /queryId:"([\w-]{12,40})",operationName:"TweetResultByRestId"/;
  const BEARER_RE = /"Bearer (AAAAAAA[A-Za-z0-9%_-]+)"/;
  const states = new Map();
  const buttonOwners = new WeakMap();
  const pendingScopes = new Set();
  let operationCache = null;
  let discoveryPromise = null;
  let forcedDiscoveryPromise = null;
  let forcedDiscoveryQid = null;
  let operationGeneration = 0;
  let mutationTimer = 0;
  function nearestPost(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.(POST_SELECTOR) ?? null;
  }
  function ownElements(scope, selector) {
    return [...scope.querySelectorAll(selector)]
      .filter((node) => nearestPost(node) === scope);
  }
  function ownStatusId(scope) {
    for (const time of ownElements(scope, 'time')) {
      const anchor = time.closest('a[href]');
      if (!anchor || nearestPost(anchor) !== scope) continue;
      const match = anchor
        .getAttribute('href')
        ?.match(/(?:^|\/)status\/([0-9]+)(?=$|[/?#])/u);
      if (match) return match[1];
    }
    return '';
  }
  function ownPostMeta(scope) {
    const author = ownElements(scope, 'a[role="link"][href^="/"]')
      .find((anchor) => /^\/([A-Za-z0-9_]{1,15})$/u.test(
        anchor.getAttribute('href') || ''
      ));
    const authorMatch = author?.getAttribute('href')?.match(
      /^\/([A-Za-z0-9_]{1,15})$/u
    );
    const textNode = ownElements(scope, '[data-testid="tweetText"]')[0];
    return {
      id: ownStatusId(scope),
      handle: authorMatch?.[1] || 'unknown',
      text: textNode?.innerText ?? textNode?.textContent ?? '',
    };
  }
  function orderedBundleUrls() {
    const seen = new Set();
    const main = [];
    const other = [];
    // querySelectorAll preserves document order. The stable partition puts
    // main bundles first without an O(n log n) sort.
    for (const script of document.querySelectorAll('script[src]')) {
      let url;
      try {
        url = new URL(script.src, document.baseURI);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:') continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      if (/\/main(?:[.-]|$)/iu.test(url.pathname)) {
        main.push(url.href);
      } else {
        other.push(url.href);
      }
    }
    return main.concat(other);
  }
  async function discoverOperation() {
    let qid = null;
    let token = null;
    for (const assetUrl of orderedBundleUrls()) {
      let text;
      try {
        const response = await fetch(assetUrl, {
          credentials: 'omit',
          cache: 'no-cache',
        });
        if (!response.ok) continue;
        text = await response.text();
      } catch {
        continue;
      }
      if (!text) continue;
      qid ||= text.match(QUERY_ID_RE)?.[1] ?? null;
      token ||= text.match(BEARER_RE)?.[1] ?? null;
      if (qid && token) {
        return Object.freeze({ qid, token });
      }
    }
    throw new Error('operation-unavailable');
  }
  function findOperation() {
    if (operationCache) return Promise.resolve(operationCache);
    if (discoveryPromise) return discoveryPromise;
    const generation = operationGeneration;
    let promise;
    promise = discoverOperation()
      .then((operation) => {
        if (operationGeneration === generation) {
          operationCache = operation;
        }
        return operation;
      })
      .finally(() => {
        if (discoveryPromise === promise) discoveryPromise = null;
      });
    discoveryPromise = promise;
    return promise;
  }
  function invalidateOperation(qid) {
    operationGeneration += 1;
    if (operationCache?.qid === qid) operationCache = null;
    // An in-flight discovery must not repopulate a cache invalidated by a 404.
    discoveryPromise = null;
    if (forcedDiscoveryQid === qid) {
      forcedDiscoveryPromise = null;
      forcedDiscoveryQid = null;
    }
  }
  function rediscoverDifferentOperation(staleQid) {
    if (operationCache && operationCache.qid !== staleQid) {
      return Promise.resolve(operationCache);
    }
    if (
      forcedDiscoveryPromise &&
      forcedDiscoveryQid === staleQid
    ) {
      return forcedDiscoveryPromise;
    }
    const generation = ++operationGeneration;
    operationCache = null;
    discoveryPromise = null;
    let promise;
    promise = discoverOperation()
      .then((operation) => {
        if (operation.qid === staleQid) {
          throw new Error('query-id-not-rotated');
        }
        if (operationGeneration === generation) {
          operationCache = operation;
        }
        return operation;
      })
      .finally(() => {
        if (discoveryPromise === promise) discoveryPromise = null;
        if (forcedDiscoveryPromise === promise) {
          forcedDiscoveryPromise = null;
          forcedDiscoveryQid = null;
        }
      });
    discoveryPromise = promise;
    forcedDiscoveryPromise = promise;
    forcedDiscoveryQid = staleQid;
    return promise;
  }
  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/u);
    return match?.[1] || '';
  }
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function bestVariantFromResponse(payload) {
    if (!isObject(payload)) return null;
    if (Object.hasOwn(payload, 'errors')) {
      if (!Array.isArray(payload.errors) || payload.errors.length !== 0) {
        return null;
      }
    }
    const media =
      payload?.data?.tweetResult?.result?.legacy?.extended_entities?.media;
    if (!Array.isArray(media)) return null;
    // Reject malformed structure rather than treating a partially malformed
    // GraphQL result as authoritative.
    for (const item of media) {
      if (!isObject(item)) return null;
      if (item.video_info == null) continue;
      if (!isObject(item.video_info)) return null;
      if (!Array.isArray(item.video_info.variants)) return null;
      for (const variant of item.video_info.variants) {
        if (!isObject(variant)) return null;
        if (variant.content_type != null && typeof variant.content_type !== 'string') {
          return null;
        }
        if (variant.url != null && typeof variant.url !== 'string') return null;
        if (
          variant.bitrate != null &&
          (typeof variant.bitrate !== 'number' || !Number.isFinite(variant.bitrate))
        ) {
          return null;
        }
      }
    }
    return Core.selectBestMp4(media);
  }
  async function resolvePostVideo(tweetId) {
    let staleQid = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let operation;
      try {
        operation = attempt === 0
          ? await findOperation()
          : await rediscoverDifferentOperation(staleQid);
      } catch {
        staleQid = null;
        return null;
      }
      const csrf = csrfToken();
      if (!csrf) {
        staleQid = null;
        return null;
      }
      const variables = {
        tweetId,
        includePromotedContent: true,
        withBirdwatchNotes: true,
        withVoice: true,
        withCommunity: true,
      };
      const query = new URLSearchParams();
      query.set('variables', JSON.stringify(variables));
      query.set('features', '{}');
      query.set('fieldToggles', '{}');
      const url =
        `https://x.com/i/api/graphql/${encodeURIComponent(operation.qid)}/` +
        `${OPERATION_NAME}?${query.toString()}`;
      let response;
      try {
        response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${operation.token}`,
            'x-csrf-token': csrf,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
          },
        });
      } catch {
        staleQid = null;
        return null;
      }
      if (response.status === 404) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          // An unreadable 404 body is not enough evidence to retry.
        }
        if (!/query not found/iu.test(body)) {
          staleQid = null;
          return null;
        }
        if (attempt === 0) {
          staleQid = operation.qid;
          invalidateOperation(operation.qid);
          continue;
        }
        invalidateOperation(operation.qid);
        staleQid = null;
        return null;
      }
      if (!response.ok) {
        staleQid = null;
        return null;
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        staleQid = null;
        return null;
      }
      const best = bestVariantFromResponse(payload);
      staleQid = null;
      return best?.url ?? null;
    }
    staleQid = null;
    return null;
  }
  function isBusy(phase) {
    return phase === 'RESOLVING' || phase === 'TRANSFERRING';
  }
  function renderState(state) {
    if (states.get(state.scope) !== state) return;
    const button = state.button;
    if (!button) return;
    button.disabled = isBusy(state.phase);
    button.setAttribute('aria-label', 'Download video');
    if (isBusy(state.phase)) {
      button.textContent = '…';
      button.title = 'Resolving or downloading video';
      button.setAttribute('aria-busy', 'true');
      button.style.color = '#1d9bf0';
      return;
    }
    button.removeAttribute('aria-busy');
    if (state.phase === 'SUCCEEDED') {
      button.textContent = '✓';
      button.title = 'Download complete';
      button.style.color = '#00ba7c';
    } else if (state.phase === 'FAILED') {
      button.textContent = '✕';
      button.title = 'Download failed; activate to retry';
      button.style.color = '#f4212e';
    } else {
      button.textContent = '⬇';
      button.title = 'Download video';
      button.style.color = '#1d9bf0';
    }
  }
  function transition(state, nextPhase) {
    if (!Core.canTransition(state.phase, nextPhase)) return false;
    state.phase = nextPhase;
    renderState(state);
    return true;
  }
  function setFailed(state) {
    if (state.phase === 'RESOLVING' || state.phase === 'TRANSFERRING') {
      transition(state, 'FAILED');
    }
  }
  function controlsOwnedBy(scope) {
    return [...scope.querySelectorAll(CONTROL_SELECTOR)].filter((button) => {
      const owner = buttonOwners.get(button);
      return owner === scope || (!owner && nearestPost(button) === scope);
    });
  }
  function removeScopeState(scope) {
    const state = states.get(scope);
    if (state?.button) state.button.remove();
    for (const button of scope.querySelectorAll(CONTROL_SELECTOR)) {
      const owner = buttonOwners.get(button);
      if (owner === scope || (!owner && nearestPost(button) === scope)) {
        button.remove();
      }
    }
    states.delete(scope);
  }
  function hostFor(scope) {
    const group = ownElements(scope, '[role="group"]')[0];
    if (group) return group;
    const time = ownElements(scope, 'time')[0];
    const timestampAnchor = time?.closest('a[href]');
    if (
      timestampAnchor &&
      nearestPost(timestampAnchor) === scope &&
      timestampAnchor.parentElement
    ) {
      return timestampAnchor.parentElement;
    }
    // A partially rendered post may not have its timestamp yet. Keeping the
    // control inside its own scope is safer than borrowing a nested post's host.
    return scope;
  }
  function reconcile(scope) {
    if (!scope || scope.nodeType !== 1) return;
    if (!scope.isConnected || !scope.matches(POST_SELECTOR)) {
      removeScopeState(scope);
      return;
    }
    const eligible = ownElements(scope, VIDEO_SELECTOR).length > 0;
    const existing = controlsOwnedBy(scope);
    if (!eligible) {
      removeScopeState(scope);
      for (const button of existing) button.remove();
      return;
    }
    const postId = ownStatusId(scope);
    const previous = states.get(scope);
    let button =
      previous?.button && existing.includes(previous.button)
        ? previous.button
        : existing[0] ?? null;
    if (previous?.button && previous.button !== button && previous.button.isConnected) {
      previous.button.remove();
    }
    let state = previous;
    if (!state || state.postId !== postId) {
      state = {
        scope,
        button,
        postId,
        phase: 'READY',
      };
      states.set(scope, state);
    }
    if (!button) {
      button = document.createElement('button');
      button.setAttribute('data-crest-take-control', '1');
      button.type = 'button';
    }
    state.button = button;
    for (const duplicate of existing) {
      if (duplicate !== button) duplicate.remove();
    }
    buttonOwners.set(button, scope);
    button.type = 'button';
    button.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:32px;height:32px;margin-left:8px;border:0;border-radius:9999px;' +
      'background:#1d9bf022;font-size:15px;cursor:pointer';
    const host = hostFor(scope);
    if (button.parentElement !== host) host.appendChild(button);
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void activate(scope, button);
    };
    renderState(state);
  }
  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  async function watchDownload(state, startMessage) {
    let missingRecordResubmitted = false;
    let lastQueuedResubmission = 0;
    for (;;) {
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({
          type: 'status',
          requestId: startMessage.requestId,
        });
      } catch {
        await sleep(900);
        continue;
      }
      if (!reply?.ok) {
        /*
         * The start message may have been lost before the worker materialized
         * its record. Re-send the same id once; the worker is idempotent for
         * that id and will not initiate a second transfer.
         */
        if (!missingRecordResubmitted) {
          missingRecordResubmitted = true;
          try {
            await chrome.runtime.sendMessage(startMessage);
          } catch {
            // The status loop is the recovery path.
          }
          await sleep(900);
          continue;
        }
        setFailed(state);
        return;
      }
      if (
        reply.retryStart === true &&
        Date.now() - lastQueuedResubmission >= 2500
      ) {
        lastQueuedResubmission = Date.now();
        void chrome.runtime.sendMessage(startMessage).catch(() => {});
      }
      if (reply.phase === 'SUCCEEDED') {
        transition(state, 'SUCCEEDED');
        void chrome.runtime.sendMessage({
          type: 'ack',
          requestId: startMessage.requestId,
        }).catch(() => {});
        return;
      }
      if (reply.phase === 'FAILED') {
        transition(state, 'FAILED');
        void chrome.runtime.sendMessage({
          type: 'ack',
          requestId: startMessage.requestId,
        }).catch(() => {});
        return;
      }
      if (reply.phase !== 'STARTING' && reply.phase !== 'TRANSFERRING') {
        setFailed(state);
        return;
      }
      await sleep(900);
    }
  }
  async function activate(scope, button) {
    let state = states.get(scope);
    if (
      !state ||
      state.button !== button ||
      button.disabled ||
      isBusy(state.phase)
    ) {
      return;
    }
    let meta;
    try {
      meta = ownPostMeta(scope);
    } catch {
      meta = { id: '', handle: 'unknown', text: '' };
    }
    // A virtualized DOM node can be recycled between observer delivery and
    // the click. Reset its control state to the identity visible at activation.
    if (state.postId !== meta.id) {
      state = {
        scope,
        button,
        postId: meta.id,
        phase: 'READY',
      };
      states.set(scope, state);
      renderState(state);
    }
    if (state.phase === 'SUCCEEDED' || state.phase === 'FAILED') {
      if (!transition(state, 'READY')) return;
    }
    if (!transition(state, 'RESOLVING')) return;
    if (!meta.id) {
      setFailed(state);
      return;
    }
    let mediaUrl;
    try {
      mediaUrl = await resolvePostVideo(meta.id);
    } catch {
      mediaUrl = null;
    }
    if (!mediaUrl) {
      setFailed(state);
      return;
    }
    let filename;
    let requestId;
    try {
      filename = Core.makeFilename(meta.handle, meta.text);
      requestId = crypto.randomUUID();
    } catch {
      setFailed(state);
      return;
    }
    if (!transition(state, 'TRANSFERRING')) {
      setFailed(state);
      return;
    }
    const startMessage = {
      type: 'start',
      requestId,
      url: mediaUrl,
      filename,
    };
    try {
      await chrome.runtime.sendMessage(startMessage);
    } catch {
      // Status polling and same-id recovery handle a lost response.
    }
    await watchDownload(state, startMessage);
  }
  function addScope(scope) {
    if (scope?.nodeType === 1) pendingScopes.add(scope);
  }
  function collectMutationTarget(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return;
    if (states.has(element) || element.matches?.(POST_SELECTOR)) {
      addScope(element);
    }
    addScope(element.closest?.(POST_SELECTOR));
  }
  function collectAddedNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return;
    addScope(element.closest?.(POST_SELECTOR));
    if (node.nodeType === 1) {
      if (node.matches(POST_SELECTOR)) addScope(node);
      for (const scope of node.querySelectorAll(POST_SELECTOR)) addScope(scope);
    }
  }
  function collectRemovedNode(node) {
    if (node?.nodeType !== 1) return;
    if (states.has(node) || node.matches(POST_SELECTOR)) addScope(node);
    for (const scope of node.querySelectorAll(POST_SELECTOR)) addScope(scope);
    if (node.matches(CONTROL_SELECTOR)) {
      const owner = buttonOwners.get(node);
      if (owner) addScope(owner);
    }
    for (const button of node.querySelectorAll(CONTROL_SELECTOR)) {
      const owner = buttonOwners.get(button);
      if (owner) addScope(owner);
      else addScope(nearestPost(button));
    }
  }
  function flushMutations() {
    mutationTimer = 0;
    const affected = [...pendingScopes];
    pendingScopes.clear();
    for (const scope of affected) reconcile(scope);
  }
  function scheduleMutationFlush() {
    if (!mutationTimer) mutationTimer = setTimeout(flushMutations, 80);
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        collectMutationTarget(record.target);
        for (const node of record.addedNodes) collectAddedNode(node);
        for (const node of record.removedNodes) collectRemovedNode(node);
      } else if (record.type === 'attributes') {
        collectMutationTarget(record.target);
      }
    }
    if (pendingScopes.size) scheduleMutationFlush();
  });
  const observerRoot = document.documentElement || document;
  observer.observe(observerRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid', 'href'],
  });
  // One initial scan; later work is scoped to mutation-affected posts.
  for (const scope of document.querySelectorAll(POST_SELECTOR)) {
    reconcile(scope);
  }
})();
