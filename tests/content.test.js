import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedSource = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const exposed = contentSource.replace(/\n\}\)\(\);\s*$/, '\n  globalThis.__testContent = { fetchMetadata };\n})();\n');
const oldId = 'OldQid12345';
const newId = 'NewQid67890';
const token = 'A'.repeat(36);
const responseJson = { data: { tweetResult: { result: { legacy: { extended_entities: { media: [] } } } } } };
const oldAsset = 'https://abs.twimg.com/old.js';
const newAsset = 'https://abs.twimg.com/new.js';
const bundleText = (qid) => 'queryId:"' + qid + '",operationName:"TweetResultByRestId" "Bearer ' + token + '"';

function loadContent(request) {
  const calls = [];
  const scripts = [{ getAttribute: () => oldAsset }];
  const document = {
    baseURI: 'https://x.com/home',
    cookie: 'ct0=csrf123',
    documentElement: null,
    querySelectorAll: (selector) => selector === 'script[src]' ? scripts : [],
  };
  class DOMParser {
    parseFromString(html) {
      return {
        querySelectorAll: (selector) => selector === 'script[src]'
          ? [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
            .map((m) => ({ getAttribute: () => m[1] }))
          : [],
      };
    }
  }
  const context = vm.createContext({
    document, DOMParser, URL, MutationObserver: class { observe() {} },
    window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return request(url, options);
    },
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(exposed, context);
  return { fetchMetadata: context.__testContent.fetchMetadata, calls };
}

const textResponse = (text, status = 200) => ({ ok: status === 200, status, async text() { return text; } });
const jsonResponse = (value, status = 200) => ({ ok: status === 200, status, async json() { return value; } });

test('404 rotation re-reads the current document and selects its newly deployed bundle', async () => {
  const context = loadContent((url) => {
    if (url === oldAsset) return textResponse(bundleText(oldId));
    if (url === 'https://x.com/') return textResponse('<html><script src="/other.js"></script><script src="' + newAsset + '"></script></html>');
    if (url === newAsset) return textResponse(bundleText(newId));
    if (url.includes('/' + oldId + '/')) return jsonResponse({}, 404);
    if (url.includes('/' + newId + '/')) return jsonResponse(responseJson);
    throw Error('unexpected URL ' + url);
  });
  await context.fetchMetadata('12345678');
  assert.equal(context.calls.filter((c) => c.url.includes('/i/api/graphql/')).length, 2);
  assert.equal(context.calls.some((c) => c.url === 'https://x.com/' && c.options.cache === 'reload'), true);
  assert.equal(context.calls.some((c) => c.url === newAsset && c.options.cache === 'reload'), true);
});

test('refresh reloads known assets when current-document discovery is unavailable', async () => {
  let readOld = 0;
  const context = loadContent((url) => {
    if (url === oldAsset) return textResponse(bundleText(++readOld === 1 ? oldId : newId));
    if (url === 'https://x.com/') throw Error('offline');
    if (url.includes('/' + oldId + '/')) return jsonResponse({}, 404);
    if (url.includes('/' + newId + '/')) return jsonResponse(responseJson);
    throw Error('unexpected URL ' + url);
  });
  await context.fetchMetadata('12345678');
  assert.equal(readOld, 2);
  assert.equal(context.calls.some((c) => c.url === oldAsset && c.options.cache === 'reload'), true);
});

test('unchanged stale query ID is not retried indefinitely', async () => {
  let graphql = 0;
  const context = loadContent((url) => {
    if (url === oldAsset) return textResponse(bundleText(oldId));
    if (url === 'https://x.com/') return textResponse('<script src="' + oldAsset + '"></script>');
    if (url.includes('/i/api/graphql/')) { graphql++; return jsonResponse({}, 404); }
    throw Error('unexpected URL ' + url);
  });
  await assert.rejects(context.fetchMetadata('12345678'), /operation-unavailable/);
  assert.equal(graphql, 1);
});
