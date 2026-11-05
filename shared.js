/*
 * Pure shared helpers for the content script and the service worker.
 * No DOM, no Chrome API, and no credential persistence.
 */
(() => {
  'use strict';

  const POST_SELECTOR =
    'article[data-testid="tweet"], [data-testid="quoteTweet"]';

  const VIDEO_SELECTOR =
    'video,[data-testid="videoPlayer"],[data-testid="videoComponent"]';

  const DOWNLOAD_ATTR = 'data-xdl';

  /*
   * The operation registry is minified client code. The observed shape puts
   * queryId before operationName; the reverse pattern is a small defensive
   * fallback for a different minification order. Neither the query id nor the
   * token shape is hardcoded as a value.
   */
  const QID_FORWARD =
    /queryId\s*:\s*["']([A-Za-z0-9_-]{8,64})["']\s*,\s*operationName\s*:\s*["']TweetResultByRestId["']/;

  const QID_REVERSE =
    /operationName\s*:\s*["']TweetResultByRestId["'][^}]{0,512}?queryId\s*:\s*["']([A-Za-z0-9_-]{8,64})["']/;

  const BEARER_TOKEN =
    /\bBearer\s+([A-Za-z0-9%._~+\/=-]{20,})/;

  function findQueryId(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let match = text.match(QID_FORWARD);
    if (match) return match[1];
    match = text.match(QID_REVERSE);
    if (match) return match[1];
    return '';
  }

  function findBearerToken(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    const match = text.match(BEARER_TOKEN);
    return match ? match[1] : '';
  }

  function hasGraphQLErrors(json) {
    if (!json || !Object.prototype.hasOwnProperty.call(json, 'errors')) {
      return false;
    }
    const errors = json.errors;
    if (Array.isArray(errors)) return errors.length > 0;
    return errors !== null && errors !== undefined;
  }

  function normalizeContentType(variant) {
    if (!variant || typeof variant.content_type !== 'string') return '';
    const value = variant.content_type;
    const semicolon = value.indexOf(';');
    return (semicolon === -1 ? value : value.slice(0, semicolon))
      .trim()
      .toLowerCase();
  }

  /*
   * Scans every media entry and every variant attached to the scoped post.
   * Keeps one running maximum; does not sort the variant set.
   * Missing/non-numeric bitrate is treated as zero. Equal bitrates retain the
   * first appearance in response order.
   */
  function selectBestMp4(json) {
    const media =
      json?.data?.tweetResult?.result?.legacy?.extended_entities?.media;

    if (!Array.isArray(media)) return null;

    let best = null;

    for (const item of media) {
      const variants = item?.video_info?.variants;
      if (!Array.isArray(variants)) continue;

      for (const variant of variants) {
        if (!variant || typeof variant !== 'object') continue;
        if (normalizeContentType(variant) !== 'video/mp4') continue;
        if (typeof variant.url !== 'string') continue;

        const url = variant.url.trim();
        if (!url) continue;

        const bitrate =
          typeof variant.bitrate === 'number' &&
          Number.isFinite(variant.bitrate)
            ? variant.bitrate
            : 0;

        if (best === null || bitrate > best.bitrate) {
          best = { url, bitrate };
        }
      }
    }

    return best;
  }

  function isReservedWindowsName(value) {
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
  }

  function sanitizePart(value, fallback, maxLength) {
    let text = typeof value === 'string' ? value : '';

    text = text.normalize('NFKC');
    text = text.replace(/https?:\/\/\S+/gi, ' ');
    text = text.replace(/[\u0000-\u001F\u007F]/g, '');
    text = text.replace(/[<>:"/\\|?*]/g, '');
    text = text.replace(/\s+/g, ' ').trim();
    text = text.replace(/^[. ]+/, '').replace(/[. ]+$/, '');

    if (!text) text = fallback || '';
    if (!text) text = 'x';

    if (isReservedWindowsName(text)) text = '_' + text;

    if (text.length > maxLength) {
      text = text
        .slice(0, maxLength)
        .replace(/[. ]+$/, '')
        .trim();
    }

    if (!text) text = fallback || 'x';
    if (isReservedWindowsName(text)) text = '_' + text;

    return text;
  }

  function makeFilename(post) {
    const postId = post?.id;
    if (typeof postId !== 'string' || !/^\d{1,25}$/.test(postId)) {
      throw new TypeError('invalid-post-id');
    }
    const handle = sanitizePart(post?.handle, 'unknown', 30);
    const text = sanitizePart(post?.text, 'video', 80);
    return `x-videos/${handle}_${postId}_${text}.mp4`;
  }

  function isSafeDownloadFilename(name) {
    if (typeof name !== 'string' || name.length > 240) return false;

    const prefix = 'x-videos/';
    if (!name.startsWith(prefix)) return false;

    const rest = name.slice(prefix.length);
    if (!/\.mp4$/i.test(rest)) return false;
    if (rest.includes('/') || rest.includes('\\')) return false;
    if (/[\u0000-\u001F\u007F<>:"|?*]/.test(rest)) return false;

    const base = rest.slice(0, -4);
    if (!base || base === '.' || base === '..') return false;
    if (base.startsWith('.') || base.startsWith(' ')) return false;
    if (base.endsWith('.') || base.endsWith(' ')) return false;

    return true;
  }

  globalThis.XDLShared = Object.freeze({
    POST_SELECTOR,
    VIDEO_SELECTOR,
    DOWNLOAD_ATTR,
    findQueryId,
    findBearerToken,
    hasGraphQLErrors,
    selectBestMp4,
    makeFilename,
    isSafeDownloadFilename,
  });
})();
