(() => {
  'use strict';
  const TRANSITIONS = Object.freeze({
    READY: Object.freeze(['RESOLVING']),
    RESOLVING: Object.freeze(['TRANSFERRING', 'FAILED']),
    TRANSFERRING: Object.freeze(['SUCCEEDED', 'FAILED']),
    SUCCEEDED: Object.freeze(['READY']),
    FAILED: Object.freeze(['READY']),
  });
  /*
   * Returns the global maximum over all eligible variants. The nested loops
   * preserve response order; not updating on an equal bitrate preserves the
   * first occurrence. The response itself is not copied or sorted.
   */
  function selectBestMp4(mediaEntries) {
    if (!Array.isArray(mediaEntries)) return null;
    let best = null;
    for (const media of mediaEntries) {
      const variants = media?.video_info?.variants;
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (!variant || typeof variant !== 'object') continue;
        if (typeof variant.content_type !== 'string') continue;
        const mediaType = variant.content_type
          .split(';', 1)[0]
          .trim()
          .toLowerCase();
        if (mediaType !== 'video/mp4') continue;
        if (typeof variant.url !== 'string' || variant.url.trim() === '') continue;
        const bitrate =
          typeof variant.bitrate === 'number' && Number.isFinite(variant.bitrate)
            ? variant.bitrate
            : 0;
        if (best === null || bitrate > best.bitrate) {
          best = {
            url: variant.url.trim(),
            bitrate,
          };
        }
      }
    }
    return best;
  }
  function safeSegment(value, fallback, maxCodePoints) {
    let text = typeof value === 'string' ? value : '';
    text = text
      .normalize('NFKC')
      .replace(/https?:\/\/\S+/giu, '')
      .replace(/@[\w]+/gu, '')
      .replace(/#([\w]+)/gu, '$1')
      .replace(/[<>:"\/\\\|?*\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/^\.+/u, '')
      .replace(/[. ]+$/u, '')
      .trim();
    text = Array.from(text).slice(0, maxCodePoints).join('');
    return text || fallback;
  }
  /*
   * Exactly one leaf below the fixed directory. The handle and post text are
   * deterministic inputs; no query or authentication metadata is used.
   */
  function makeFilename(handle, postText) {
    const safeHandle = safeSegment(handle, 'unknown', 32);
    const safeText = safeSegment(postText, 'video', 80);
    return `x-videos/${safeHandle}_${safeText}.mp4`;
  }
  /*
   * Worker-side defense in depth. There must be exactly one fixed directory
   * component and one safe leaf; a page-derived value cannot add a path.
   */
  function isSafeDownloadFilename(filename) {
    if (typeof filename !== 'string') return false;
    const parts = filename.split('/');
    if (parts.length !== 2 || parts[0] !== 'x-videos') return false;
    const leaf = parts[1];
    if (!leaf || leaf === '.' || leaf === '..' || leaf.startsWith('.')) return false;
    if (!/\.mp4$/iu.test(leaf)) return false;
    if (/[<>:"\/\\\|?*\u0000-\u001f\u007f-\u009f]/u.test(leaf)) return false;
    if (/[. ]$/u.test(leaf)) return false;
    return true;
  }
  function canTransition(from, to) {
    return TRANSITIONS[from]?.includes(to) === true;
  }
  globalThis.CrestTakeCore = Object.freeze({
    selectBestMp4,
    makeFilename,
    isSafeDownloadFilename,
    canTransition,
  });
})();
