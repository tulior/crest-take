/* Crest Take MV3 worker: keyed durable records, direct reverse correlation,
   per-request serialization, and conservative pre-launch recovery. */
import './shared.js';

const { isSafeDownloadFilename } = globalThis.XDLShared;
const REQUEST_PREFIX = 'xdl:req:';
const DOWNLOAD_PREFIX = 'xdl:dl:';
const WORKER_EPOCH = crypto.randomUUID();
const START_RECOVERY_MS = 120_000;
const MISSING_DOWNLOAD_MS = 60_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const storage = chrome.storage.local;
const requestTails = new Map();
const launching = new Set();
let nextPruneAt = 0;
let prunePromise = null;

try {
  void storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
} catch {}

const requestKey = (id) => REQUEST_PREFIX + id;
const downloadKey = (id) => DOWNLOAD_PREFIX + id;
const terminal = (state) => state === 'SUCCEEDED' || state === 'FAILED';
const validRequestId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);

function mediaUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function get(key) {
  return (await storage.get(key))[key] ?? null;
}

// Serializes only operations for one request. Independent downloads are concurrent.
function forRequest(id, fn) {
  const previous = requestTails.get(id) ?? Promise.resolve();
  const work = previous.then(fn, fn);
  const tail = work.then(() => undefined, () => undefined);
  requestTails.set(id, tail);
  void tail.then(() => {
    if (requestTails.get(id) === tail) requestTails.delete(id);
  });
  return work;
}

function result(record) {
  if (!record) return { ok: false, found: false, state: 'UNKNOWN', reason: 'not-found' };
  return {
    ok: record.state === 'STARTING' || record.state === 'TRANSFERRING' || record.state === 'SUCCEEDED',
    found: true,
    state: record.state,
    downloadId: Number.isInteger(record.downloadId) ? record.downloadId : null,
    reason: record.reason || '',
  };
}

function fail(reason) {
  return { ok: false, found: false, state: 'FAILED', reason };
}

function searchDownloads(query) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.search(query, (items) => {
        if (chrome.runtime.lastError) reject(new Error('download-search-failed'));
        else resolve(Array.isArray(items) ? items : []);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError || !Number.isInteger(id) || id < 0) {
          reject(new Error('download-rejected'));
        } else {
          resolve(id);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function notifyTab(record, state, reason) {
  if (!Number.isInteger(record?.tabId)) return;
  const message = { type: 'XDL_STATE', requestId: record.requestId, state, reason: reason || '' };
  try {
    if (Number.isInteger(record.frameId)) {
      await chrome.tabs.sendMessage(record.tabId, message, { frameId: record.frameId });
    } else {
      await chrome.tabs.sendMessage(record.tabId, message);
    }
  } catch {}
}

// Caller holds this request's lock. The same request and reverse keys can be
// written together, without accessing or rewriting unrelated records.
async function finishLocked(record, state, reason = '') {
  if (!record || terminal(record.state)) return record;
  const next = {
    ...record,
    state,
    reason,
    finishedAt: Date.now(),
  };
  delete next.url;
  delete next.filename;
  await storage.set({ [requestKey(record.requestId)]: next });
  void notifyTab(next, state, reason);
  return next;
}

async function attachLocked(record, downloadId) {
  if (!record || terminal(record.state)) return record;
  if (Number.isInteger(record.downloadId) && record.downloadId !== downloadId) {
    return finishLocked(record, 'FAILED', 'ambiguous-download-id');
  }
  const next = {
    requestId: record.requestId,
    tabId: record.tabId,
    frameId: record.frameId,
    state: 'TRANSFERRING',
    downloadId,
    urlHash: record.urlHash,
    filenameHash: record.filenameHash,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: Date.now(),
  };
  await storage.set({
    [requestKey(record.requestId)]: next,
    [downloadKey(downloadId)]: { requestId: record.requestId },
  });
  return next;
}

async function reconcileLocked(record) {
  if (!record || record.state !== 'TRANSFERRING' || !Number.isInteger(record.downloadId)) return record;
  let items;
  try {
    items = await searchDownloads({ id: record.downloadId });
  } catch {
    return record;
  }
  const item = items.find((candidate) => candidate?.id === record.downloadId);
  if (!item) {
    const now = Date.now();
    if (record.missingSince && now - record.missingSince >= MISSING_DOWNLOAD_MS) {
      return finishLocked(record, 'FAILED', 'download-missing');
    }
    if (!record.missingSince) {
      const next = { ...record, missingSince: now };
      await storage.set({ [requestKey(record.requestId)]: next });
      return next;
    }
    return record;
  }
  if (item.state === 'complete') return finishLocked(record, 'SUCCEEDED');
  if (item.state === 'interrupted') return finishLocked(record, 'FAILED', item.error || 'interrupted');
  if (record.missingSince) {
    const next = { ...record };
    delete next.missingSince;
    await storage.set({ [requestKey(record.requestId)]: next });
    return next;
  }
  return record;
}

async function recoverStartingLocked(record) {
  if (!record || record.state !== 'STARTING' || Number.isInteger(record.downloadId)) return record;
  // A currently running invocation owns the callback gap: no second invocation.
  if (launching.has(record.requestId)) return record;
  const startedAt = record.startedAt ?? record.createdAt;
  let candidates;
  try {
    candidates = await searchDownloads({
      startedAfter: new Date(Math.max(0, startedAt - 1000)).toISOString(),
    });
  } catch {
    if (Date.now() - startedAt >= START_RECOVERY_MS) {
      return finishLocked(record, 'FAILED', 'recovery-search-unavailable');
    }
    return record;
  }

  // A full-store scan is reserved for rare STARTING recovery, never for
  // routine request/status/reverse-ID lookups.
  const allRecords = await storage.get(null);
  const competingStarts = Object.entries(allRecords).some(([key, other]) =>
    key.startsWith(REQUEST_PREFIX) && key !== requestKey(record.requestId) &&
    other?.state === 'STARTING' && other?.urlHash === record.urlHash &&
    Math.abs((other.startedAt ?? other.createdAt) - startedAt) < START_RECOVERY_MS
  );
  const matches = [];
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate?.id) || candidate.byExtensionId !== chrome.runtime.id) continue;
    if (typeof candidate.url !== 'string') continue;
    const time = Date.parse(candidate.startTime);
    if (!Number.isFinite(time) || time < startedAt - 1000) continue;
    if (await fingerprint(candidate.url) !== record.urlHash) continue;
    const linked = allRecords[downloadKey(candidate.id)];
    if (linked && linked.requestId !== record.requestId) continue;
    matches.push(candidate);
  }
  if (!competingStarts && matches.length === 1) {
    const next = await attachLocked(record, matches[0].id);
    return reconcileLocked(next);
  }
  if (matches.length > 1 || (competingStarts && matches.length)) {
    return finishLocked(record, 'FAILED', 'ambiguous-recovery');
  }
  if (Date.now() - startedAt >= START_RECOVERY_MS) {
    return finishLocked(record, 'FAILED', 'acceptance-unconfirmed');
  }
  return record;
}

async function runDownloadLocked(id, url, filename, urlHash, filenameHash, sender) {
  let record = await get(requestKey(id));
  if (record) {
    if (record.urlHash !== urlHash || record.filenameHash !== filenameHash ||
        record.tabId !== sender.tab.id || record.frameId !== sender.frameId) {
      return fail('request-id-reused');
    }
    if (record.state === 'STARTING') record = await recoverStartingLocked(record);
    if (record.state === 'TRANSFERRING') record = await reconcileLocked(record);
    return result(record);
  }

  const now = Date.now();
  record = {
    requestId: id,
    tabId: sender.tab.id,
    frameId: sender.frameId,
    state: 'STARTING',
    createdAt: now,
    startedAt: now,
    ownerEpoch: WORKER_EPOCH,
    urlHash,
    filenameHash,
  };
  // The reservation is durable BEFORE Chrome can be asked to start anything.
  await storage.set({ [requestKey(id)]: record });

  let downloadId;
  launching.add(id);
  try {
    downloadId = await startDownload({ url, filename, conflictAction: 'uniquify' });
  } catch {
    launching.delete(id);
    // Callback ambiguity: search once before marking a real failure.
    record = await recoverStartingLocked(record);
    if (record?.state === 'STARTING') record = await finishLocked(record, 'FAILED', 'download-rejected');
    return result(record);
  }

  launching.delete(id);
  // An event can arrive before this mapping; the immediate search reconciles it.
  record = await attachLocked(record, downloadId);
  record = await reconcileLocked(record);
  return result(record);
}

async function handleDownload(message, sender) {
  const id = message.requestId;
  if (!validRequestId(id)) return fail('invalid-request');
  const url = mediaUrl(message.url);
  if (!url) return fail('invalid-url');
  if (!isSafeDownloadFilename(message.filename)) return fail('invalid-filename');
  if (!Number.isInteger(sender?.tab?.id)) return fail('missing-tab');
  const [urlHash, filenameHash] = await Promise.all([
    fingerprint(url), fingerprint(message.filename),
  ]);
  // A keyed lock covers the initial read and reservation (no first-write race).
  return forRequest(id, () => runDownloadLocked(id, url, message.filename, urlHash, filenameHash, sender));
}

async function handleQuery(message, sender) {
  const id = message.requestId;
  if (!validRequestId(id)) return fail('invalid-request');
  const record = await get(requestKey(id));
  if (!record) return result(null);
  if (Number.isInteger(record.tabId) && sender?.tab?.id !== record.tabId) return fail('wrong-tab');
  if (record.state === 'STARTING' && launching.has(id)) {
    return result(record);
  }
  if (record.state === 'STARTING' || record.state === 'TRANSFERRING') {
    return forRequest(id, async () => {
      const current = await get(requestKey(id));
      const fresh = current?.state === 'STARTING'
        ? await recoverStartingLocked(current)
        : await reconcileLocked(current);
      return result(fresh);
    });
  }
  return result(record);
}

async function handleAck(message, sender) {
  const id = message.requestId;
  if (!validRequestId(id)) return { ok: false };
  return forRequest(id, async () => {
    const record = await get(requestKey(id));
    if (!record || !terminal(record.state) || sender?.tab?.id !== record.tabId) {
      return { ok: false };
    }
    const keys = [requestKey(id)];
    if (Number.isInteger(record.downloadId)) {
      const mapping = await get(downloadKey(record.downloadId));
      if (mapping?.requestId === id) keys.push(downloadKey(record.downloadId));
    }
    await storage.remove(keys);
    return { ok: true };
  });
}

async function handleDownloadChanged(downloadId, state) {
  const link = await get(downloadKey(downloadId));
  if (!validRequestId(link?.requestId)) return;
  await forRequest(link.requestId, async () => {
    const current = await get(requestKey(link.requestId));
    if (!current || current.downloadId !== downloadId || terminal(current.state)) return;
    if (state === 'complete') await finishLocked(current, 'SUCCEEDED');
    else {
      let reason = 'interrupted';
      try {
        const found = await searchDownloads({ id: downloadId });
        reason = found[0]?.error || reason;
      } catch {}
      await finishLocked(current, 'FAILED', reason);
    }
  });
}

// Rare, bounded-frequency full scan for expiry and recovery across worker and
// browser restarts; the common path uses only keyed get/set/remove operations.
async function pruneRecords(force = false) {
  if (prunePromise) return prunePromise;
  if (!force && Date.now() < nextPruneAt) return;
  nextPruneAt = Date.now() + PRUNE_INTERVAL_MS;
  prunePromise = (async () => {
    const all = await storage.get(null);
    const now = Date.now();
    for (const [key, record] of Object.entries(all)) {
      if (!key.startsWith(REQUEST_PREFIX) || !validRequestId(record?.requestId)) continue;
      if (terminal(record.state)) {
        if (now - (record.finishedAt || record.createdAt) < TERMINAL_RETENTION_MS) continue;
        await forRequest(record.requestId, async () => {
          const fresh = await get(key);
          if (!fresh || !terminal(fresh.state) || now - (fresh.finishedAt || fresh.createdAt) < TERMINAL_RETENTION_MS) return;
          const keys = [key];
          if (Number.isInteger(fresh.downloadId)) {
            const mapping = await get(downloadKey(fresh.downloadId));
            if (mapping?.requestId === fresh.requestId) keys.push(downloadKey(fresh.downloadId));
          }
          await storage.remove(keys);
        });
      } else if (record.state === 'STARTING') {
        await forRequest(record.requestId, async () => {
          const current = await get(key);
          if (current?.state === 'STARTING') await recoverStartingLocked(current);
        });
      }
    }
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(DOWNLOAD_PREFIX)) continue;
      const record = value?.requestId && await get(requestKey(value.requestId));
      if (!record || String(record.downloadId) !== key.slice(DOWNLOAD_PREFIX.length)) {
        await storage.remove(key);
      }
    }
  })().finally(() => { prunePromise = null; });
  return prunePromise;
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!Number.isInteger(delta?.id)) return;
  const state = delta?.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  void handleDownloadChanged(delta.id, state).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || sender?.id !== chrome.runtime.id) return;
  const action = message.type === 'XDL_DOWNLOAD' ? handleDownload(message, sender)
    : message.type === 'XDL_QUERY' ? handleQuery(message, sender)
    : message.type === 'XDL_ACK' ? handleAck(message, sender)
    : null;
  if (!action) return;
  action.then(sendResponse, () => sendResponse({ ok: false, found: false, state: 'UNKNOWN', reason: 'internal' }));
  void pruneRecords().catch(() => {});
  return true;
});

chrome.runtime.onStartup?.addListener(() => { void pruneRecords(true).catch(() => {}); });
void pruneRecords(true).catch(() => {});
