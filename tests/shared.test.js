import test from 'node:test';
import assert from 'node:assert/strict';

await import('../shared.js');

const {
  findQueryId,
  findBearerToken,
  hasGraphQLErrors,
  selectBestMp4,
  makeFilename,
  isSafeDownloadFilename,
} = globalThis.XDLShared;

function media(variants) {
  return {
    video_info: {
      variants,
    },
  };
}

function payload(mediaItems) {
  return {
    data: {
      tweetResult: {
        result: {
          legacy: {
            extended_entities: {
              media: mediaItems,
            },
          },
        },
      },
    },
  };
}

test('selects global highest-bitrate MP4 across media, first tie wins', () => {
  const json = payload([
    media([
      {
        content_type: 'application/x-mpegURL',
        bitrate: 999_999,
        url: 'hls',
      },
      {
        content_type: 'video/mp4',
        bitrate: 100,
        url: 'low',
      },
    ]),
    media([
      {
        content_type: 'VIDEO/MP4',
        bitrate: 500,
        url: 'first-tie',
      },
      {
        content_type: 'video/mp4',
        bitrate: 500,
        url: 'second-tie',
      },
      {
        content_type: 'video/webm',
        bitrate: 999_999,
        url: 'webm',
      },
    ]),
  ]);

  assert.deepEqual(selectBestMp4(json), {
    url: 'first-tie',
    bitrate: 500,
  });
});

test('missing bitrate counts as zero and empty/non-MP4 URLs are ignored', () => {
  const json = payload([
    media([
      {
        content_type: 'video/mp4',
        url: 'missing-bitrate',
      },
      {
        content_type: 'video/mp4',
        bitrate: 0,
        url: 'zero',
      },
      {
        content_type: 'video/mp4',
        bitrate: 1,
        url: 'best',
      },
      {
        content_type: 'video/mp4',
        bitrate: 999_999,
        url: '   ',
      },
      {
        content_type: 'application/x-mpegURL',
        bitrate: 999_999,
        url: 'hls',
      },
    ]),
  ]);

  assert.deepEqual(selectBestMp4(json), {
    url: 'best',
    bitrate: 1,
  });
});

test('animated media represented as MP4 follows the same selection rule', () => {
  const json = payload([
    media([
      {
        content_type: 'video/mp4',
        bitrate: 10,
        url: 'animated',
      },
    ]),
  ]);

  assert.deepEqual(selectBestMp4(json), {
    url: 'animated',
    bitrate: 10,
  });
});

test('returns null when only HLS/non-MP4 variants exist', () => {
  const json = payload([
    media([
      {
        content_type: 'application/x-mpegURL',
        bitrate: 999_999,
        url: 'playlist',
      },
      {
        content_type: 'video/webm',
        bitrate: 999_999,
        url: 'webm',
      },
    ]),
  ]);

  assert.equal(selectBestMp4(json), null);
});

test('GraphQL errors are rejected unless explicitly proven authoritative', () => {
  assert.equal(hasGraphQLErrors({}), false);
  assert.equal(hasGraphQLErrors({ errors: [] }), false);
  assert.equal(hasGraphQLErrors({ errors: [{ message: 'x' }] }), true);
  assert.equal(hasGraphQLErrors({ errors: {} }), true);
});

test('operation registry and Bearer are discovered without hardcoded values', () => {
  const asset =
    'noise queryId:"AbCdEf12",operationName:"TweetResultByRestId" ' +
    '"Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

  assert.equal(findQueryId(asset), 'AbCdEf12');
  assert.equal(
    findBearerToken(asset),
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
});

test('reverse minified operation order is also accepted', () => {
  const asset =
    'operationName:"TweetResultByRestId",foo:1,' +
    'queryId:"Zxcvbn12"';

  assert.equal(findQueryId(asset), 'Zxcvbn12');
});

test('filename is deterministic, safe, and confined to x-videos/', () => {
  const filename = makeFilename({
    handle: 'a/b',
    id: '1234567890123456789',
    text: 'hello ../ world? <x> @a https://t.co/example',
  });

  assert.ok(filename.startsWith('x-videos/'));
  assert.ok(filename.endsWith('.mp4'));
  assert.ok(filename.includes('_1234567890123456789_'));
  assert.ok(isSafeDownloadFilename(filename));

  const rest = filename.slice('x-videos/'.length);
  assert.equal(rest.includes('/'), false);
  assert.equal(rest.includes('\\'), false);
  assert.ok(!/[<>:"|?*]/.test(rest));
});

test('filename sanitization resists traversal and reserved names', () => {
  const filename = makeFilename({
    handle: '../CON',
    id: '987654321',
    text: '..',
  });

  assert.ok(filename.startsWith('x-videos/'));
  assert.ok(isSafeDownloadFilename(filename));

  assert.equal(isSafeDownloadFilename('x-videos/../evil.mp4'), false);
  assert.equal(isSafeDownloadFilename('x-videos/evil.exe'), false);
  assert.equal(isSafeDownloadFilename('other/evil.mp4'), false);
});

test('filename carries the originating post ID and avoids equal-text collisions', () => {
  const first = makeFilename({ handle: 'alice', id: '123', text: 'same text' });
  const second = makeFilename({ handle: 'alice', id: '456', text: 'same text' });
  assert.equal(first, 'x-videos/alice_123_same text.mp4');
  assert.equal(second, 'x-videos/alice_456_same text.mp4');
  assert.notEqual(first, second);
  assert.ok(isSafeDownloadFilename(first));
  assert.throws(() => makeFilename({ handle: 'alice', text: 'no ID' }), TypeError);
});
