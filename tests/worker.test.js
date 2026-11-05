import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').replace(/^import '\.\/shared\.js';\s*/m, '');
const videoUrl = 'https://video.twimg.com/ext_tw_video/a/pu/vid/1280x720/video.mp4';
const filename = 'x-videos/user_video.mp4';
const id = '12345678-1234-4123-8123-123456789abc';
const sender = { id: 'crest-test', tab: { id: 23 }, frameId: 0 };
const delay = () => new Promise((resolve) => setImmediate(resolve));

class MockPlatform {
  constructor() {
    this.records = new Map();
    this.downloads = new Map();
    this.nextId = 0;
    this.downloadCalls = 0;
    this.sessionReads = 0;
    this.scanCalls = 0;
    this.delayCallbacks = false;
    this.heldCallbacks = [];
    this.messages = [];
  }
  async get(key) {
    if (key === null) {
      this.scanCalls++;
      return Object.fromEntries([...this.records.entries()].map(([k, v]) => [k, structuredClone(v)]));
    }
    this.sessionReads++;
    if (typeof key === 'string') return this.records.has(key) ? { [key]: structuredClone(this.records.get(key)) } : {};
    return {};
  }
  async set(obj) { for (const [key, value] of Object.entries(obj)) this.records.set(key, structuredClone(value)); }
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key); }
  makeWorker() {
    let onMessage;
    let onChanged;
    let onStartup;
    const platform = this;
    const chrome = {
      runtime: {
        id: 'crest-test', lastError: null,
        onMessage: { addListener(fn) { onMessage = fn; } },
        onStartup: { addListener(fn) { onStartup = fn; } },
      },
      storage: {
        local: {
          get: (key) => platform.get(key),
          set: (items) => platform.set(items),
          remove: (keys) => platform.remove(keys),
          async setAccessLevel() {},
        },
      },
      downloads: {
        download({ url, filename: name, conflictAction }, callback) {
          assert.equal(conflictAction, 'uniquify');
          const downloadId = ++platform.nextId;
          platform.downloadCalls++;
          platform.downloads.set(downloadId, {
            id: downloadId, url, filename: name, byExtensionId: chrome.runtime.id,
            startTime: new Date().toISOString(), state: 'in_progress',
          });
          if (platform.delayCallbacks) platform.heldCallbacks.push(() => callback(downloadId));
          else callback(downloadId);
        },
        search(query, callback) {
          if (typeof query.id === 'number') callback([platform.downloads.get(query.id)].filter(Boolean));
          else if (query.startedAfter) callback([...platform.downloads.values()].filter((item) => Date.parse(item.startTime) >= Date.parse(query.startedAfter)));
          else callback([...platform.downloads.values()]);
        },
        onChanged: { addListener(fn) { onChanged = fn; } },
      },
      tabs: {
        async sendMessage(_tabId, message) { platform.messages.push(message); },
      },
    };
    const sandbox = vm.createContext({
      chrome, crypto: webcrypto, TextEncoder, URL, Date, setTimeout, clearTimeout,
    });
    vm.runInContext(shared, sandbox);
    vm.runInContext(worker, sandbox);
    return {
      message: (message, from = sender) => new Promise((resolve, reject) => {
        const keep = onMessage(message, from, resolve);
        if (keep !== true) reject(new Error('message not accepted'));
      }),
      change(downloadId, state) {
        const download = platform.downloads.get(downloadId);
        if (download) download.state = state;
        onChanged({ id: downloadId, state: { current: state } });
      },
      startup: () => onStartup?.(),
    };
  }
}
const startMessage = (requestId = id, url = videoUrl, name = filename) => ({
  type: 'XDL_DOWNLOAD', requestId, url, filename: name,
});
const statusMessage = (requestId = id) => ({ type: 'XDL_QUERY', requestId });
const ackMessage = (requestId = id) => ({ type: 'XDL_ACK', requestId });

async function waitUntil(fn) {
  for (let i = 0; i < 50; ++i) {
    if (fn()) return;
    await delay();
  }
  throw new Error('condition was not reached');
}

test('same-ID concurrent starts are serialized and cannot double-launch', async () => {
  const platform = new MockPlatform();
  const worker = platform.makeWorker();
  const [first, second] = await Promise.all([
    worker.message(startMessage()), worker.message(startMessage()),
  ]);
  assert.equal(first.state, 'TRANSFERRING');
  assert.equal(second.state, 'TRANSFERRING');
  assert.equal(platform.downloadCalls, 1);
  assert.equal(platform.records.size, 2);
  assert.ok(platform.records.has('xdl:req:' + id));
  assert.ok(platform.records.has('xdl:dl:1'));
  const job = platform.records.get('xdl:req:' + id);
  assert.equal(job.url, undefined);
  assert.equal(job.filename, undefined);
  assert.match(job.urlHash, /^[0-9a-f]{64}$/);
});

test('different requests initiate independently without a global launch queue', async () => {
  const platform = new MockPlatform();
  platform.delayCallbacks = true;
  const worker = platform.makeWorker();
  const secondId = '22222222-2222-4222-8222-222222222222';
  const a = worker.message(startMessage());
  const b = worker.message(startMessage(secondId, videoUrl + '?v=2'));
  await waitUntil(() => platform.downloadCalls === 2);
  assert.equal(platform.heldCallbacks.length, 2);
  for (const respond of platform.heldCallbacks) respond();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.state, 'TRANSFERRING');
  assert.equal(second.state, 'TRANSFERRING');
  assert.equal(platform.downloadCalls, 2);
});

test('restart in callback gap recovers one matching extension-owned download without re-launch', async () => {
  const platform = new MockPlatform();
  platform.delayCallbacks = true;
  const prior = platform.makeWorker();
  void prior.message(startMessage());
  await waitUntil(() => platform.downloadCalls === 1);
  const reservation = platform.records.get('xdl:req:' + id);
  assert.equal(reservation.state, 'STARTING');
  assert.equal(reservation.url, undefined);
  assert.equal(reservation.filename, undefined);
  const resumed = platform.makeWorker();
  const status = await resumed.message(statusMessage());
  assert.equal(status.state, 'TRANSFERRING');
  assert.equal(status.downloadId, 1);
  assert.equal(platform.downloadCalls, 1);
  assert.deepEqual(platform.records.get('xdl:dl:1'), { requestId: id });
});

test('ambiguous candidates fail closed without assigning a download', async () => {
  const platform = new MockPlatform();
  platform.delayCallbacks = true;
  const prior = platform.makeWorker();
  void prior.message(startMessage());
  await waitUntil(() => platform.downloadCalls === 1);
  platform.downloads.set(2, { ...platform.downloads.get(1), id: 2 });
  const resumed = platform.makeWorker();
  const status = await resumed.message(statusMessage());
  assert.equal(status.state, 'FAILED');
  assert.equal(status.reason, 'ambiguous-recovery');
  assert.equal(platform.downloadCalls, 1);
});

test('stale unmatched STARTING fails without initiating another transfer', async () => {
  const platform = new MockPlatform();
  platform.delayCallbacks = true;
  const prior = platform.makeWorker();
  void prior.message(startMessage());
  await waitUntil(() => platform.downloadCalls === 1);
  platform.downloads.clear();
  const state = platform.records.get('xdl:req:' + id);
  state.startedAt -= 130_000;
  state.createdAt -= 130_000;
  const resumed = platform.makeWorker();
  const status = await resumed.message(statusMessage());
  assert.equal(status.state, 'FAILED');
  assert.equal(status.reason, 'acceptance-unconfirmed');
  assert.equal(platform.downloadCalls, 1);
});

test('event-driven terminal notification, status and acknowledgement delete both keys', async () => {
  const platform = new MockPlatform();
  const worker = platform.makeWorker();
  await worker.message(startMessage());
  worker.change(1, 'complete');
  await waitUntil(() => platform.records.get('xdl:req:' + id)?.state === 'SUCCEEDED');
  assert.equal((await worker.message(statusMessage())).state, 'SUCCEEDED');
  assert.equal(platform.messages.at(-1)?.state, 'SUCCEEDED');
  assert.equal((await worker.message(ackMessage())).ok, true);
  assert.equal(platform.records.has('xdl:req:' + id), false);
  assert.equal(platform.records.has('xdl:dl:1'), false);
});

test('direct reverse lookup remains available after worker restart', async () => {
  const platform = new MockPlatform();
  const prior = platform.makeWorker();
  await prior.message(startMessage());
  const next = platform.makeWorker();
  await delay(); // initial opportunistic pruning may scan, but event lookup does not
  const before = platform.scanCalls;
  next.change(1, 'interrupted');
  await waitUntil(() => platform.records.get('xdl:req:' + id)?.state === 'FAILED');
  assert.equal(platform.scanCalls, before);
  assert.equal((await next.message(statusMessage())).state, 'FAILED');
});

test('expired terminals and their reverse keys are pruned, active jobs retained', async () => {
  const platform = new MockPlatform();
  const tooOld = Date.now() - 31 * 24 * 3600 * 1000;
  platform.records.set('xdl:req:' + id, {
    requestId: id, state: 'SUCCEEDED', finishedAt: tooOld, createdAt: tooOld,
    downloadId: 3, tabId: 23,
  });
  platform.records.set('xdl:dl:3', { requestId: id });
  const newer = '22222222-2222-4222-8222-222222222222';
  platform.records.set('xdl:req:' + newer, {
    requestId: newer, state: 'SUCCEEDED', finishedAt: Date.now(), createdAt: Date.now(),
    downloadId: 4, tabId: 23,
  });
  platform.records.set('xdl:dl:4', { requestId: newer });
  platform.makeWorker();
  await waitUntil(() => !platform.records.has('xdl:req:' + id));
  assert.equal(platform.records.has('xdl:dl:3'), false);
  assert.equal(platform.records.has('xdl:req:' + newer), true);
  assert.equal(platform.records.has('xdl:dl:4'), true);
});

test('a reused request ID with a different URL or filename is rejected', async () => {
  const platform = new MockPlatform();
  const worker = platform.makeWorker();
  await worker.message(startMessage());
  assert.equal((await worker.message(startMessage(id, videoUrl + '?other'))).reason, 'request-id-reused');
  assert.equal((await worker.message(startMessage(id, videoUrl, 'x-videos/else.mp4'))).reason, 'request-id-reused');
  assert.equal(platform.downloadCalls, 1);
});
