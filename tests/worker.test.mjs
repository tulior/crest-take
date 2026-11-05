import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreCode = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const workerCode = fs.readFileSync(path.join(root, 'service_worker.js'), 'utf8');
const requestId = '12345678-1234-4123-8123-123456789abc';
const videoUrl = 'https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/example.mp4';

function harness(persisted = new Map(), downloads = new Map()) {
  let messages;
  let onChanged;
  let count = 0;
  let storageReads = 0;
  const chrome = {
    runtime: {
      id: 'crest-test', lastError: null,
      onMessage: { addListener(cb) { messages = cb; } },
      onStartup: { addListener() {} },
    },
    storage: {
      local: {
        async setAccessLevel() {},
        async get(key) {
          storageReads++;
          if (key === null) return Object.fromEntries(persisted);
          if (typeof key === 'string') return { [key]: persisted.get(key) };
          return {};
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) persisted.set(key, structuredClone(value));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) persisted.delete(key);
        },
      },
    },
    downloads: {
      download({ url, filename }, callback) {
        count++;
        const id = count;
        downloads.set(id, { id, url, filename, state: 'in_progress',
          byExtensionId: 'crest-test', startTime: new Date().toISOString() });
        callback(id);
      },
      search(query, callback) {
        if (Number.isInteger(query.id)) callback([downloads.get(query.id)].filter(Boolean));
        else callback([...downloads.values()]);
      },
      onCreated: { addListener() {} },
      onChanged: { addListener(cb) { onChanged = cb; } },
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, TextEncoder, setTimeout });
  context.importScripts = () => vm.runInContext(coreCode, context);
  vm.runInContext(workerCode, context);
  function message(payload) {
    return new Promise((resolve, reject) => {
      const active = messages(payload, { url: 'https://x.com/home' }, resolve);
      if (active !== true) reject(new Error('message rejected'));
    });
  }
  return { message, downloads, persisted,
    get started() { return count; },
    get storageReads() { return storageReads; },
    changed(delta) { onChanged(delta); },
  };
}

test('simultaneous identical starts launch only one download and persist keyed records', async () => {
  const worker = harness();
  const start = { type: 'start', requestId, url: videoUrl, filename: 'x-videos/me_video.mp4' };
  const [one, two] = await Promise.all([worker.message(start), worker.message(start)]);
  assert.equal(one.accepted, true);
  assert.equal(two.accepted, true);
  assert.equal(worker.started, 1);
  assert.equal(worker.persisted.size, 1);
  assert.ok(worker.persisted.has('crestTakeJobV2:' + requestId));
  const firstReads = worker.storageReads;
  const status = await worker.message({ type: 'status', requestId });
  assert.equal(status.phase, 'TRANSFERRING');
  assert.equal(worker.storageReads, firstReads);
});

test('download completion survives a new worker instance and acknowledgement cleans up', async () => {
  const state = new Map();
  const downloads = new Map();
  const first = harness(state, downloads);
  const result = await first.message({ type: 'start', requestId, url: videoUrl,
    filename: 'x-videos/me_video.mp4' });
  assert.equal(result.accepted, true);
  downloads.get(1).state = 'complete';
  const restarted = harness(state, downloads);
  const status = await restarted.message({ type: 'status', requestId });
  assert.equal(status.phase, 'SUCCEEDED');
  assert.equal((await restarted.message({ type: 'ack', requestId })).ok, true);
  assert.equal(state.size, 0);
});

test('a request ID cannot be rebound to a different URL', async () => {
  const worker = harness();
  const first = { type: 'start', requestId, url: videoUrl,
    filename: 'x-videos/me_video.mp4' };
  assert.equal((await worker.message(first)).accepted, true);
  const second = await worker.message({ ...first, url: videoUrl + '?different' });
  assert.equal(second.ok, false);
  assert.equal(worker.started, 1);
});
