'use strict';
importScripts('core.js');
const Core = globalThis.CrestTakeCore;
const JOB_PREFIX = 'crestTakeJobV2:';
const ORPHAN_PREFIX = 'crestTakeOrphanV2:';
const START_RECOVERY_TIMEOUT_MS = 120_000;
const MISSING_DOWNLOAD_TIMEOUT_MS = 60_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_RETENTION_MS = 10 * 60 * 1000;
const MAX_ORPHANS = 64;
const REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_PHASES = new Set(['SUCCEEDED', 'FAILED']);

// Per-request durable records; reverse correlation is indexed in memory.
// All writes remain serialized so a STARTING reservation is persisted before
// Chrome is asked to begin a transfer.
let storageTail = Promise.resolve();
let launchTail = Promise.resolve();
const launches = new Map();
const reverse = new Map();
const dirtyJobs = new Set();
const dirtyOrphans = new Set();
let storePromise = null;
let nextPruneAt = 0;

try {
  const promise = chrome.storage.local.setAccessLevel?.({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  promise?.catch(() => {});
} catch {}

function updateReverse(requestId, before, after) {
  if (Number.isInteger(before) && reverse.get(before) === requestId) {
    reverse.delete(before);
  }
  if (Number.isInteger(after)) reverse.set(after, requestId);
}

function createStore() {
  const records = Object.create(null);
  const stray = Object.create(null);
  const jobs = new Proxy(records, {
    set(target, requestId, value) {
      const previous = target[requestId];
      if (previous) updateReverse(requestId, previous.downloadId, null);
      const record = new Proxy({ ...value }, {
        set(job, prop, next) {
          const prior = job[prop];
          if (!Object.is(prior, next)) {
            job[prop] = next;
            if (prop === 'downloadId') updateReverse(requestId, prior, next);
            dirtyJobs.add(requestId);
          }
          return true;
        },
      });
      target[requestId] = record;
      updateReverse(requestId, null, record.downloadId);
      dirtyJobs.add(requestId);
      return true;
    },
    deleteProperty(target, requestId) {
      const previous = target[requestId];
      if (previous) {
        updateReverse(requestId, previous.downloadId, null);
        delete target[requestId];
        dirtyJobs.add(requestId);
      }
      return true;
    },
  });
  const orphans = new Proxy(stray, {
    set(target, id, value) {
      target[id] = value;
      dirtyOrphans.add(id);
      return true;
    },
    deleteProperty(target, id) {
      if (Object.hasOwn(target, id)) {
        delete target[id];
        dirtyOrphans.add(id);
      }
      return true;
    },
  });
  return { jobs, orphans };
}

function loadStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const data = await chrome.storage.local.get(null);
      const store = createStore();
      for (const [key, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (key.startsWith(JOB_PREFIX)) {
          const requestId = key.slice(JOB_PREFIX.length);
          if (validRequestId(requestId)) store.jobs[requestId] = entry;
        } else if (key.startsWith(ORPHAN_PREFIX)) {
          const id = key.slice(ORPHAN_PREFIX.length);
          if (/^\d+$/u.test(id)) store.orphans[id] = entry;
        }
      }
      dirtyJobs.clear();
      dirtyOrphans.clear();
      return store;
    })().catch((error) => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

function transaction(change) {
  const work = storageTail.then(async () => {
    const store = await loadStore();
    try {
      const result = await change(store);
      const updates = {};
      const removals = [];
      for (const id of dirtyJobs) {
        const key = JOB_PREFIX + id;
        if (Object.hasOwn(store.jobs, id)) {
          updates[key] = { ...store.jobs[id] };
        } else {
          removals.push(key);
        }
      }
      for (const id of dirtyOrphans) {
        const key = ORPHAN_PREFIX + id;
        if (Object.hasOwn(store.orphans, id)) {
          updates[key] = { ...store.orphans[id] };
        } else {
          removals.push(key);
        }
      }
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
      if (removals.length) await chrome.storage.local.remove(removals);
      return result;
    } catch (error) {
      // Reload persistent state instead of proceeding with a partially committed cache.
      storePromise = null;
      reverse.clear();
      throw error;
    } finally {
      dirtyJobs.clear();
      dirtyOrphans.clear();
    }
  });
  storageTail = work.then(() => undefined, () => undefined);
  return work;
}

function isTerminal(phase) {
  return TERMINAL_PHASES.has(phase);
}
function copyJob(job) {
  if (!job) return null;
  return {
    requestId: job.requestId,
    phase: job.phase,
    downloadId: Number.isInteger(job.downloadId) ? job.downloadId : null,
    createdAt: Number.isFinite(job.createdAt) ? job.createdAt : 0,
    startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
    updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : 0,
    urlHash: typeof job.urlHash === 'string' ? job.urlHash : '',
    missingSince: Number.isFinite(job.missingSince) ? job.missingSince : null,
  };
}
function publicPhase(job) {
  return job?.phase === 'QUEUED' ? 'STARTING' : job?.phase;
}
function pruneStore(store, now = Date.now()) {
  for (const [requestId, job] of Object.entries(store.jobs)) {
    if (
      isTerminal(job?.phase) &&
      now - (Number(job.updatedAt) || Number(job.createdAt) || now) >
        TERMINAL_RETENTION_MS
    ) {
      delete store.jobs[requestId];
    }
  }
  pruneOrphans(store, now);
}
function pruneOrphans(store, now = Date.now()) {
  for (const [downloadId, orphan] of Object.entries(store.orphans)) {
    if (!Number.isFinite(orphan?.at) || now - orphan.at > ORPHAN_RETENTION_MS) {
      delete store.orphans[downloadId];
    }
  }
  while (Object.keys(store.orphans).length > MAX_ORPHANS) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [downloadId, orphan] of Object.entries(store.orphans)) {
      if (orphan.at < oldestAt) {
        oldestAt = orphan.at;
        oldestId = downloadId;
      }
    }
    if (oldestId === null) break;
    delete store.orphans[oldestId];
  }
}
function validSender(sender) {
  try {
    return new URL(sender?.url || '').origin === 'https://x.com';
  } catch {
    return false;
  }
}
function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}
function normalizeMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
async function urlFingerprint(url) {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function invokeDownload(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(
        {
          url,
          filename,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          const failed = Boolean(chrome.runtime.lastError);
          const validId = Number.isInteger(downloadId) && downloadId >= 0;
          resolve({
            accepted: !failed && validId,
            downloadId: validId ? downloadId : null,
          });
        }
      );
    } catch {
      resolve({ accepted: false, downloadId: null });
    }
  });
}
function searchDownloads(query) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.search(query, (items) => {
        if (chrome.runtime.lastError) {
          reject();
          return;
        }
        resolve(Array.isArray(items) ? items : []);
      });
    } catch {
      reject();
    }
  });
}
function findJobByDownloadId(store, downloadId) {
  const requestId = reverse.get(downloadId);
  return requestId ? store.jobs[requestId] ?? null : null;
}
function applyChromeState(job, state, now = Date.now()) {
  if (!job || isTerminal(job.phase) || typeof state !== 'string') return;
  job.missingSince = null;
  job.updatedAt = now;
  if (state === 'in_progress') {
    job.phase = 'TRANSFERRING';
  } else if (state === 'complete') {
    job.phase = 'SUCCEEDED';
  } else {
    // interrupted and every other terminal state are failures.
    job.phase = 'FAILED';
  }
}
function attachInStore(store, job, downloadId, now = Date.now()) {
  if (!job || isTerminal(job.phase)) return;
  if (
    Number.isInteger(job.downloadId) &&
    job.downloadId !== downloadId
  ) {
    job.phase = 'FAILED';
    job.updatedAt = now;
    return;
  }
  job.downloadId = downloadId;
  job.phase = 'TRANSFERRING';
  job.updatedAt = now;
  job.missingSince = null;
  const orphanKey = String(downloadId);
  const orphan = store.orphans[orphanKey];
  if (orphan) {
    delete store.orphans[orphanKey];
    applyChromeState(job, orphan.state, now);
  }
}
async function getJob(requestId) {
  return transaction((store) => copyJob(store.jobs[requestId]));
}
async function getActiveJobs() {
  return transaction((store) =>
    Object.values(store.jobs)
      .filter((job) =>
        job &&
        (job.phase === 'QUEUED' ||
          job.phase === 'STARTING' ||
          job.phase === 'TRANSFERRING')
      )
      .map(copyJob)
  );
}
async function markFailed(requestId) {
  return transaction((store) => {
    const job = store.jobs[requestId];
    if (job && !isTerminal(job.phase)) {
      job.phase = 'FAILED';
      job.updatedAt = Date.now();
      job.missingSince = null;
    }
    return copyJob(job);
  });
}
async function attachDownload(requestId, downloadId) {
  return transaction((store) => {
    const job = store.jobs[requestId];
    attachInStore(store, job, downloadId);
    return copyJob(job);
  });
}
async function updateFromItemState(requestId, state) {
  return transaction((store) => {
    const job = store.jobs[requestId];
    applyChromeState(job, state);
    return copyJob(job);
  });
}
async function noteMissingDownload(requestId) {
  return transaction((store) => {
    const job = store.jobs[requestId];
    if (!job || isTerminal(job.phase)) return copyJob(job);
    const now = Date.now();
    if (job.missingSince == null) {
      job.missingSince = now;
    } else if (now - job.missingSince >= MISSING_DOWNLOAD_TIMEOUT_MS) {
      job.phase = 'FAILED';
      job.updatedAt = now;
      job.missingSince = null;
    }
    return copyJob(job);
  });
}
async function refreshDownload(requestId) {
  let job = await getJob(requestId);
  if (
    !job ||
    isTerminal(job.phase) ||
    !Number.isInteger(job.downloadId)
  ) {
    return job;
  }
  let items;
  try {
    items = await searchDownloads({ id: job.downloadId });
  } catch {
    // A later status poll or lifecycle event can retry this query.
    return job;
  }
  const item = items.find((candidate) => candidate.id === job.downloadId);
  if (!item) {
    return noteMissingDownload(requestId);
  }
  job = await updateFromItemState(requestId, item.state);
  return job;
}
async function recoverStarting(requestId) {
  const job = await getJob(requestId);
  if (
    !job ||
    job.phase !== 'STARTING' ||
    Number.isInteger(job.downloadId)
  ) {
    return job;
  }
  const startedAt = job.startedAt ?? job.createdAt;
  let items;
  try {
    items = await searchDownloads({
      startedAfter: new Date(Math.max(0, startedAt - 1000)).toISOString(),
    });
  } catch {
    return job;
  }
  const matches = [];
  for (const item of items) {
    if (item.byExtensionId !== chrome.runtime.id) continue;
    if (typeof item.url !== 'string') continue;
    const itemTime = Date.parse(item.startTime);
    if (!Number.isFinite(itemTime) || itemTime < startedAt - 1000) continue;
    let hash;
    try {
      hash = await urlFingerprint(item.url);
    } catch {
      continue;
    }
    if (hash === job.urlHash) matches.push(item);
  }
  if (matches.length === 1) {
    const item = matches[0];
    await attachDownload(requestId, item.id);
    await updateFromItemState(requestId, item.state);
    return getJob(requestId);
  }
  if (matches.length > 1) {
    // Ambiguous correlation is a failure, not permission to guess or redownload.
    return markFailed(requestId);
  }
  if (Date.now() - startedAt > START_RECOVERY_TIMEOUT_MS) {
    return markFailed(requestId);
  }
  return job;
}
function startReply(job) {
  if (!job) {
    return { ok: false, accepted: false, phase: 'FAILED' };
  }
  const accepted =
    Number.isInteger(job.downloadId) ||
    job.phase === 'QUEUED' ||
    job.phase === 'STARTING' ||
    job.phase === 'TRANSFERRING' ||
    job.phase === 'SUCCEEDED';
  return {
    ok: true,
    accepted,
    phase: publicPhase(job),
  };
}
async function launchQueued(requestId, url, filename) {
  const mayLaunch = await transaction((store) => {
    const job = store.jobs[requestId];
    if (!job || job.phase !== 'QUEUED') return false;
    const otherUnresolvedStart = Object.values(store.jobs).some(
      (candidate) =>
        candidate &&
        candidate.requestId !== requestId &&
        candidate.phase === 'STARTING'
    );
    if (otherUnresolvedStart) {
      job.phase = 'FAILED';
      job.updatedAt = Date.now();
      return false;
    }
    job.phase = 'STARTING';
    job.startedAt = Date.now();
    job.updatedAt = job.startedAt;
    return true;
  });
  if (!mayLaunch) return startReply(await getJob(requestId));
  const result = await invokeDownload(url, filename);
  if (!result.accepted) {
    const current = await getJob(requestId);
    // onCreated is also evidence that Chrome created the item if an unusual
    // callback/event ordering made the callback look unsuccessful.
    if (Number.isInteger(current?.downloadId)) {
      await refreshDownload(requestId);
      return startReply(await getJob(requestId));
    }
    return startReply(await markFailed(requestId));
  }
  await attachDownload(requestId, result.downloadId);
  await refreshDownload(requestId);
  return startReply(await getJob(requestId));
}
function enqueueLaunch(requestId, url, filename) {
  const existing = launches.get(requestId);
  if (existing) return existing;
  const work = launchTail.then(
    () => launchQueued(requestId, url, filename),
    () => launchQueued(requestId, url, filename)
  );
  let tracked;
  tracked = work.finally(() => {
    if (launches.get(requestId) === tracked) launches.delete(requestId);
  });
  launches.set(requestId, tracked);
  launchTail = tracked.then(
    () => undefined,
    () => undefined
  );
  return tracked;
}
async function startDownload(message) {
  const requestId = message?.requestId;
  const url = normalizeMediaUrl(message?.url);
  const filename = message?.filename;
  if (!validRequestId(requestId)) {
    return { ok: false, accepted: false, phase: 'FAILED' };
  }
  if (!url || !Core.isSafeDownloadFilename(filename)) {
    return { ok: false, accepted: false, phase: 'FAILED' };
  }
  const urlHash = await urlFingerprint(url);
  const prepared = await transaction((store) => {
    if (Date.now() >= nextPruneAt) {
      pruneStore(store);
      nextPruneAt = Date.now() + 60 * 60 * 1000;
    }
    const existing = store.jobs[requestId];
    if (existing) {
      return {
        kind: 'existing',
        job: copyJob(existing),
        sameUrl: existing.urlHash === urlHash,
      };
    }
    const now = Date.now();
    store.jobs[requestId] = {
      requestId,
      phase: 'QUEUED',
      downloadId: null,
      urlHash,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      missingSince: null,
    };
    return { kind: 'created' };
  });
  if (prepared.kind === 'existing') {
    if (!prepared.sameUrl) {
      return { ok: false, accepted: false, phase: 'FAILED' };
    }
    if (prepared.job.phase === 'QUEUED') {
      return enqueueLaunch(requestId, url, filename);
    }
    if (prepared.job.phase === 'STARTING') {
      await recoverStarting(requestId);
    }
    return startReply(await getJob(requestId));
  }
  return enqueueLaunch(requestId, url, filename);
}
async function statusFor(requestId) {
  if (!validRequestId(requestId)) {
    return { ok: false, phase: 'FAILED' };
  }
  let job = await getJob(requestId);
  if (!job) {
    return { ok: false, phase: 'FAILED', notFound: true };
  }
  if (job.phase === 'QUEUED') {
    if (Date.now() - job.createdAt > START_RECOVERY_TIMEOUT_MS) {
      job = await markFailed(requestId);
    } else {
      return {
        ok: true,
        phase: 'STARTING',
        retryStart: !launches.has(requestId),
      };
    }
  }
  if (job?.phase === 'STARTING') {
    await recoverStarting(requestId);
    job = await getJob(requestId);
  }
  if (job?.phase === 'TRANSFERRING') {
    await refreshDownload(requestId);
    job = await getJob(requestId);
  }
  return {
    ok: true,
    phase: publicPhase(job) || 'FAILED',
  };
}
async function acknowledge(requestId) {
  if (!validRequestId(requestId)) return { ok: false };
  await transaction((store) => {
    const job = store.jobs[requestId];
    if (job && isTerminal(job.phase)) delete store.jobs[requestId];
  });
  return { ok: true };
}
async function recoverAll() {
  const jobs = await getActiveJobs();
  for (const job of jobs) {
    if (job.phase === 'STARTING') {
      await recoverStarting(job.requestId);
    } else if (job.phase === 'TRANSFERRING') {
      await refreshDownload(job.requestId);
    } else if (
      job.phase === 'QUEUED' &&
      Date.now() - job.createdAt > START_RECOVERY_TIMEOUT_MS
    ) {
      await markFailed(job.requestId);
    }
  }
}
chrome.downloads.onCreated.addListener((item) => {
  if (
    !item ||
    item.byExtensionId !== chrome.runtime.id ||
    !Number.isInteger(item.id) ||
    typeof item.url !== 'string'
  ) {
    return;
  }
  void urlFingerprint(item.url)
    .then((hash) =>
      transaction((store) => {
        if (findJobByDownloadId(store, item.id)) return;
        const itemTime = Date.parse(item.startTime);
        const candidates = Object.values(store.jobs).filter((job) => {
          if (job?.phase !== 'STARTING') return false;
          if (job.downloadId != null || job.urlHash !== hash) return false;
          const startedAt = job.startedAt ?? job.createdAt;
          return !Number.isFinite(itemTime) || itemTime >= startedAt - 1000;
        });
        if (candidates.length !== 1) return;
        const job = candidates[0];
        attachInStore(store, job, item.id);
        if (store.orphans[String(item.id)]) {
          delete store.orphans[String(item.id)];
          // attachInStore applied the orphan before the item snapshot.
          if (!isTerminal(job.phase)) applyChromeState(job, item.state);
        } else {
          applyChromeState(job, item.state);
        }
      })
    )
    .catch(() => {});
});
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta?.state?.current;
  if (!Number.isInteger(delta?.id) || typeof state !== 'string') return;
  void transaction((store) => {
    const job = findJobByDownloadId(store, delta.id);
    if (job) {
      applyChromeState(job, state);
      return;
    }
    if (
      state !== 'in_progress' &&
      Object.values(store.jobs).some((candidate) => candidate?.phase === 'STARTING')
    ) {
      store.orphans[String(delta.id)] = {
        state,
        at: Date.now(),
      };
      pruneOrphans(store);
    }
  }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!validSender(sender) || !message || typeof message.type !== 'string') {
    return false;
  }
  if (
    message.type !== 'start' &&
    message.type !== 'status' &&
    message.type !== 'ack'
  ) {
    return false;
  }
  void (async () => {
    try {
      if (message.type === 'start') {
        sendResponse(await startDownload(message));
      } else if (message.type === 'status') {
        sendResponse(await statusFor(message.requestId));
      } else {
        sendResponse(await acknowledge(message.requestId));
      }
    } catch {
      // Only static failure data crosses the boundary; never expose API errors.
      sendResponse({ ok: false, accepted: false, phase: 'FAILED' });
    }
  })();
  return true;
});
chrome.runtime.onStartup.addListener(() => {
  void recoverAll().catch(() => {});
});
// Also runs when a worker is restarted after suspension.
void recoverAll().catch(() => {});
