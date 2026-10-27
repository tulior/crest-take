/**
 * x_video_resolver.js — reference implementation for resolving X (Twitter) video URLs.
 *
 * Context: this replaces the legacy endpoints that now hard-404
 *   api.twitter.com/1.1/statuses/show.json      -> 404
 *   api.twitter.com/1.1/video/1.1/show.json     -> 404
 *   api.twitter.com/1.1/videos/media.json       -> 400
 * and the dead HTML scrape path (__NEXT_DATA__ no longer ships video variants).
 *
 * Strategy:
 *   1. GraphQL TweetResultByRestId  (authoritative; needs the page's session cookie)
 *   2. Syndication tweet-result      (no auth; needs the TWEET id, not the media id)
 *   3. Pick the best muxed MP4 variant, else fall back to the HLS master playlist.
 *
 * Run inside the page (or an extension content script) so that
 * fetch(..., {credentials: 'include'}) carries the x.com session cookie.
 */

/** HAR entry 120 query id. X ROTATES THIS — read it dynamically, see findQueryId(). */
const TWEET_RESULT_BY_REST_ID = 'a-Xpq8PjX9K6U5cmc1f05A';

const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';

/** Read the csrf token X expects in the x-csrf-token header. */
export function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Pull the current GraphQL query id out of the loaded JS bundle instead of
 * hardcoding a hash that X will rotate out from under you.
 *
 * @returns {Promise<string|null>}
 */
export async function findQueryId() {
  // 1. Prefer an id observed on the page's own in-flight GraphQL request.
  //    NOTE: the resource-timing buffer holds only 250 entries and saturates
  //    on x.com long before a user clicks, so this usually finds nothing.
  const fromPerf = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => /\/i\/api\/graphql\/([A-Za-z0-9_-]{15,})\/TweetResultByRestId/.test(n));
  if (fromPerf) {
    const m = fromPerf.match(/\/i\/api\/graphql\/([A-Za-z0-9_-]{15,})\/TweetResultByRestId/);
    if (m) return m[1];
  }

  // 2. Otherwise scrape it out of main.js / the routes bundle.
  try {
    const scripts = [...document.querySelectorAll('script[src]')]
      .map((s) => s.src)
      .filter((s) => /responsive-web\/client-web/.test(s));
    for (const src of scripts) {
      const txt = await (await fetch(src)).text();
      const m = txt.match(
        /queryId:"([A-Za-z0-9_-]{15,})",operationName:"TweetResultByRestId"/
      );
      if (m) return m[1];
    }
  } catch {
    /* ignore — fall through */
  }
  return null;
}

/**
 * The app-level Bearer the web client sends on every /i/api/ call. It lives in
 * the client build as a plain literal and is public — the same value every
 * visitor's browser uses. Without it x.com answers 403 even with a valid
 * session cookie. abs.twimg.com serves the bundle with
 * access-control-allow-origin: *, so this needs no host permission.
 */
export async function findAppBearer() {
  try {
    const scripts = [...document.querySelectorAll('script[src]')]
      .map((s) => s.src)
      .filter((s) => /responsive-web\/client-web/.test(s))
      .sort((a, b) => (b.includes('/main.') ? 1 : 0) - (a.includes('/main.') ? 1 : 0));
    for (const src of scripts) {
      const txt = await (await fetch(src)).text();
      const m = txt.match(/"Bearer (AAAAAAA[A-Za-z0-9%_-]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* ignore — fall through */
  }
  return null;
}

/** Normalise the two shapes X uses for a video variant list. */
function normaliseVariants(videoInfo) {
  const raw = videoInfo?.variants ?? [];
  return raw
    .map((v) => ({
      // GraphQL uses `content_type` + `url`; syndication uses `contentType` + `src`.
      contentType: v.content_type ?? v.contentType ?? '',
      url: v.url ?? v.src ?? '',
      bitrate: v.bitrate ?? 0,
    }))
    .filter((v) => v.url);
}

/**
 * Rank variants and return the best downloadable one.
 * Prefers muxed progressive MP4 (single file, audio already muxed in).
 */
export function pickBestVariant(variants) {
  const mp4 = variants.filter(
    (v) => /video\/mp4|application\/mp4/i.test(v.contentType) && v.bitrate > 0
  );
  if (mp4.length) {
    return mp4.reduce((a, b) => (b.bitrate > a.bitrate ? b : a));
  }
  // Some videos only advertise a bare `video/mp4` with bitrate 0.
  const anyMp4 = variants.filter((v) => /video\/mp4|application\/mp4/i.test(v.contentType));
  if (anyMp4.length) return anyMp4[anyMp4.length - 1];

  const hls = variants.find((v) => /mpegurl/i.test(v.contentType));
  return hls ?? null;
}

/** Extract the media id from any of the URL shapes X uses. */
export function parseMediaId(tweetId, tweetText = '') {
  const m = tweetText.match(/https:\/\/t\.co\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Tier 1 — GraphQL. Authoritative: returns bitrates, HLS master, muxed MP4s.
 * @param {string} tweetId
 * @returns {Promise<{variants: Array, durationMillis: number}|null>}
 */
export async function resolveViaGraphQL(tweetId) {
  const queryId = (await findQueryId()) ?? TWEET_RESULT_BY_REST_ID;
  const csrf = getCsrfToken();
  if (!csrf) return null;
  const bearer = await findAppBearer();
  if (!bearer) return null;

  const variables = {
    tweetId,
    includePromotedContent: true,
    withBirdwatchNotes: true,
    withVoice: true,
    withCommunity: true,
  };

  const url =
    `https://x.com/i/api/graphql/${queryId}/TweetResultByRestId` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent('{}')}` +
    `&fieldToggles=${encodeURIComponent('{}')}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      // Same-origin => the x.com session cookie rides along.
      credentials: 'include',
      headers: {
        // The app-level Bearer is the gate. Chrome's HAR export omits the
        // authorization header, which is why it looks optional in a capture.
        // Without it X answers 403 with an empty body.
        authorization: `Bearer ${bearer}`,
        // Must match the live ct0 cookie, which rotates.
        'x-csrf-token': csrf,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        referer: location.href,
      },
    });
    if (!res.ok) return null;

    const json = await res.json();
    const media =
      json?.data?.tweetResult?.result?.legacy?.extended_entities?.media?.find(
        (m) => m.type === 'video'
      );
    if (!media?.video_info) return null;

    return {
      variants: normaliseVariants(media.video_info),
      durationMillis: media.video_info.duration_millis ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Tier 2 — Syndication. No auth, no session. NOTE: `id` must be the TWEET id.
 * Passing the media id returns 404.
 * @param {string} tweetId
 */
export async function resolveViaSyndication(tweetId) {
  // The `token` value is no longer validated — any non-empty value works.
  const url = `${SYNDICATION}?id=${encodeURIComponent(tweetId)}&lang=en&token=1`;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.video) return null;
    return {
      variants: normaliseVariants(json.video),
      durationMillis: (json.video.durationMillis ?? 0) * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the best download URL for a tweet.
 * @param {string} tweetId
 * @returns {Promise<{url: string, kind: 'mp4'|'hls', variants: Array, source: string}|null>}
 */
export async function resolveVideo(tweetId) {
  const result =
    (await resolveViaGraphQL(tweetId)) ?? (await resolveViaSyndication(tweetId));
  if (!result || !result.variants.length) return null;

  const best = pickBestVariant(result.variants);
  if (!best) return null;

  return {
    url: best.url,
    kind: /mpegurl/i.test(best.contentType) ? 'hls' : 'mp4',
    variants: result.variants,
    source: result.source ?? 'resolved',
  };
}

/**
 * HLS -> file. Only needed when there is no muxed MP4 variant, or when you want
 * the auto-generated subtitle track.
 *
 * NOTE: never rewrite a `pl/.../<hash>.m3u8` URL into `vid/.../<hash>.mp4` —
 * the playlist hash and the media hash are different tokens and the guess 404s.
 */
export async function resolveHlsSegments(masterUrl) {
  const master = await (await fetch(masterUrl)).text();
  const lines = master.split('\n');
  const variants = lines.filter((l) => l.startsWith('/amplify_video/'));
  return {
    master: masterUrl,
    videoPlaylists: variants.map((v) => new URL(v, 'https://video.twimg.com').href),
    subtitles: [...master.matchAll(/URI="([^"]+\.vtt)"/g)].map((m) =>
      new URL(m[1], 'https://video.twimg.com').href
    ),
  };
}
