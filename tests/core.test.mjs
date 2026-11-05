import test from 'node:test';
import assert from 'node:assert/strict';
import '../core.js';
const Core = globalThis.CrestTakeCore;
test('selects the global highest-bitrate MP4 and ignores HLS', () => {
  const media = [
    {
      video_info: {
        variants: [
          {
            content_type: 'application/x-mpegURL',
            url: 'https://video.twimg.com/list.m3u8',
            bitrate: 9_000_000,
          },
          {
            content_type: 'VIDEO/MP4',
            url: 'https://video.twimg.com/low.mp4',
            bitrate: 128_000,
          },
        ],
      },
    },
    {
      video_info: {
        variants: [
          {
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/best.mp4',
            bitrate: 1_024_000,
          },
        ],
      },
    },
  ];
  assert.deepEqual(Core.selectBestMp4(media), {
    url: 'https://video.twimg.com/best.mp4',
    bitrate: 1_024_000,
  });
});
test('equal bitrates retain the first variant in response order', () => {
  const media = [
    {
      video_info: {
        variants: [
          { content_type: 'video/mp4', url: 'first.mp4', bitrate: 500 },
          { content_type: 'video/mp4', url: 'second.mp4', bitrate: 500 },
        ],
      },
    },
  ];
  assert.deepEqual(Core.selectBestMp4(media), {
    url: 'first.mp4',
    bitrate: 500,
  });
});
test('a missing bitrate is zero and remains a valid MP4 candidate', () => {
  const media = [
    {
      video_info: {
        variants: [
          { content_type: 'video/mp4', url: 'first.mp4' },
          { content_type: 'VIDEO/MP4; codecs=avc1', url: 'second.mp4', bitrate: 0 },
          { content_type: 'video/mp4', url: 'higher.mp4', bitrate: 1 },
        ],
      },
    },
  ];
  assert.deepEqual(Core.selectBestMp4(media), {
    url: 'higher.mp4',
    bitrate: 1,
  });
  assert.deepEqual(
    Core.selectBestMp4([
      {
        video_info: {
          variants: [
            { content_type: 'video/mp4', url: 'first.mp4' },
            { content_type: 'video/mp4', url: 'second.mp4', bitrate: 0 },
          ],
        },
      },
    ]),
    { url: 'first.mp4', bitrate: 0 }
  );
});
test('returns no candidate for HLS-only or empty media', () => {
  assert.equal(
    Core.selectBestMp4([
      {
        video_info: {
          variants: [
            {
              content_type: 'application/x-mpegURL',
              url: 'https://video.twimg.com/list.m3u8',
              bitrate: 100_000,
            },
          ],
        },
      },
    ]),
    null
  );
  assert.equal(Core.selectBestMp4([]), null);
});
test('animated MP4 variants use the same selection rule', () => {
  assert.deepEqual(
    Core.selectBestMp4([
      {
        type: 'animated_gif',
        video_info: {
          variants: [
            { content_type: 'video/mp4', url: 'animation.mp4', bitrate: 42 },
          ],
        },
      },
    ]),
    { url: 'animation.mp4', bitrate: 42 }
  );
});
test('filename is deterministic, confined to x-videos, and sanitized', () => {
  const filename = Core.makeFilename(
    'alice_7',
    '../bad\\name: x\nhttps://example.test/path'
  );
  assert.equal(
    filename,
    Core.makeFilename('alice_7', '../bad\\name: x\nhttps://example.test/path')
  );
  assert.ok(filename.startsWith('x-videos/'));
  assert.equal(filename.split('/').length, 2);
  assert.ok(filename.endsWith('.mp4'));
  assert.ok(Core.isSafeDownloadFilename(filename));
  assert.ok(!Core.isSafeDownloadFilename('x-videos/../outside.mp4'));
  assert.ok(!Core.isSafeDownloadFilename('x-videos/a/b.mp4'));
});
test('state transitions permit failures and explicit retries, not illegal jumps', () => {
  assert.equal(Core.canTransition('READY', 'RESOLVING'), true);
  assert.equal(Core.canTransition('RESOLVING', 'FAILED'), true);
  assert.equal(Core.canTransition('RESOLVING', 'TRANSFERRING'), true);
  assert.equal(Core.canTransition('TRANSFERRING', 'SUCCEEDED'), true);
  assert.equal(Core.canTransition('TRANSFERRING', 'FAILED'), true);
  assert.equal(Core.canTransition('FAILED', 'READY'), true);
  assert.equal(Core.canTransition('READY', 'SUCCEEDED'), false);
});
