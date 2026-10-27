# X (Twitter) Video URL — HAR Analysis

**Source:** `x.com.har` (32,597,956 bytes, 276 entries, WebInspector 537.36, Chrome 155)
**Tweet:** https://x.com/Rayo_Libertario/status/2114572412054274285

| Field | Value |
|---|---|
| Author | @Rayo_Libertario — 🇦🇷🛠️🔬🔭⚖️🇦🇷 |
| Created | Mon Oct 26 04:18:44 +0000 2026 |
| Text | `Maldita sea, es demasiado bueno para dejarlo pasar 😂😂😂 https://t.co/CNnfkBGcYT` |
| Tweet id | `2114572412054274285` |
| Media id | `2114572381842714624` (`amplify_video`) |
| Duration | 19.05 s |
| Resolution | 962×720 (H.264 High @ 30 fps + AAC-LC 128 kbps stereo) |
| `allow_download_status` | `true` |

---

## 1. The 404 is NOT in this HAR

**Every one of the 276 entries is `200` or `302`. There is not a single 4xx/5xx entry.**

- No `_error` on any entry, no non-2xx `response.status`.
- **Zero** `chrome-extension://` or `moz-extension://` entries — the extension's own
  background/service-worker traffic is not captured (Chrome DevTools HAR export omits it).
- `pages[]` = 2 snapshots, both titled the tweet URL, started 20:00:30 / 20:00:48.

So this capture is a **clean browser session of x.com**, not the extension's request trace.
The 404 you're seeing is reproducible against the live legacy endpoints (verified below),
it just isn't recorded in this file.

---

## 2. Which endpoints actually 404 today (live-verified)

| # | Endpoint | Result |
|---|---|---|
| 1 | `api.twitter.com/1.1/statuses/show.json?id=<tweet_id>` | **404** |
| 2 | `api.x.com/1.1/statuses/show.json?id=<tweet_id>` | **404** |
| 3 | `api.twitter.com/1.1/video/1.1/show.json?id=<media_id>&token=1` | **404** ← *the classic video-downloader API* |
| 4 | `api.twitter.com/1.1/videos/media.json?id=<media_id>&token=1` | **400** |
| 5 | `cdn.syndication.twimg.com/tweet-result?id=<media_id>&lang=en&token=…` | **404** ← *media id passed instead of tweet id* |
| 6 | `cdn.syndication.twimg.com/tweet-result?id=<tweet_id>&lang=en` (no `token` param) | 200 but body is `{}` — empty, no video |
| 7 | `x.com/i/api/graphql/…/TweetResultByRestId` — no auth | **403** |
| 8 | same — `x-csrf-token` only, no session cookie | **403** |
| 9 | same — `x-csrf-token` + guest `Bearer` | **403** |
| 10 | same — browser session (HAR entry 120) | **200** ✅ (but see the correction below) |
| 11 | `cdn.syndication.twimg.com/tweet-result?id=<tweet_id>&lang=en&token=<anything>` | **200, full video payload** ✅ |

**Key findings:**

- **`video/1.1/show.json` and `statuses/show.json` are the dead APIs.** Both return a flat 404
  for this tweet. These are the two most common "outdated API" paths in
  video-downloader extensions for X. That is almost certainly your extension's 404.
- **The GraphQL fallback needs the app-level Bearer token, not just the session cookie.**
  See the correction in §3a — the HAR cannot show you this header, and getting it wrong
  produces a 403 that looks like an auth problem.
- **The syndication `token` is no longer validated.** `token=a`, `token=1`, `token=xyzzy`,
  `token=0` all return the identical 3092-byte payload. Only *presence* of the param matters.
  The old base-36 token algorithm is dead weight.
- **HTML scraping is dead too.** The page no longer ships `__NEXT_DATA__` (0 occurrences).
  `__INITIAL_STATE__` exists but contains **0** occurrences of `variants`, `videoInfo`, or
  `m3u8`. Video URLs are now GraphQL-only, fetched client-side.

---

## 3. The GraphQL fallback (HAR entry 120)

```
GET https://x.com/i/api/graphql/a-Xpq8PjX9K6U5cmc1f05A/TweetResultByRestId
    ?variables={"tweetId":"2114572412054274285","includePromotedContent":true,
                "withBirdwatchNotes":true,"withVoice":true,"withCommunity":true}
    &features={…44 switches…}
    &fieldToggles={"withArticleRichContentState":true,…}
```

Headers that mattered:

```
x-csrf-token: <the page's ct0 cookie>
x-twitter-active-user: yes
x-twitter-auth-type: OAuth2Session
x-client-transaction-id: VSxYijUTRtoSUf+mJYt+YIEY9k9GzZ4DeuDWH6vp5QJYLBmwSV8obd3qn09FnS7fDVQbxVMFcT8wv0f73s1JO0q8jDb8Vg
referer: https://x.com/Rayo_Libertario/status/2114572412054274285
```

> ⚠️ The query id `a-Xpq8PjX9K6U5cmc1f05A` is a build hash and **X rotates it**. Hardcoding it
> is the next breakage. Read it from the page's own network traffic or the JS bundle instead.

### 3a. ⚠️ CORRECTION — the HAR hides the one header that matters

**Chrome's HAR export omits the `authorization` header.** Entry 120 above therefore looks
like a cookie-only request, and the live client in fact sends:

```
authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA
```

That token is **not a secret**: it is the app-level bearer the web client ships in its own
public bundle — the same string in every visitor's page source. It is not tied to your
account, grants nothing beyond what the anonymous client already has, and rotates with
each client deploy (which is why the extension reads it out of the bundle at runtime
rather than pinning it).

That header is the **gate**. Measured live in a logged-in browser session:

| request | result |
|---|---|
| session cookie + `x-csrf-token` only | **403** (empty body) |
| … + `authorization: Bearer <app token>` | **200**, media returned |

Measured matrix (same session, same URL, one variable changed at a time):

| variant | result |
|---|---|
| no `authorization` | **403** |
| no `x-client-transaction-id` | 200 |
| no `x-twitter-client-language` | 200 |
| no `content-type` | 200 |
| **`features={}` / `fieldToggles={}`** | 200 |
| 2.5 h-old `x-client-transaction-id` | 200 |

So: **only `authorization` and a matching `x-csrf-token` are required.** The transaction id
is not verified, the feature switches may be empty, and the client-language header is
optional. The app-level token is a public constant inside the web client build
(`main.<hash>.js`), extractable with `/"Bearer (AAAAAAA[A-Za-z0-9%_-]+)"/`.

Two further traps, both measured:

- **`ct0` rotates.** A stale `x-csrf-token` yields
  `{"errors":[{"code":353,"message":"This request requires a matching csrf cookie and header"}]}`.
  Read the cookie again immediately before each request. The auth gate answers with an
  *empty* body, so a 403 with no body means "missing/!valid Bearer", not "stale csrf".
- **The web client uses XHR, not `fetch`** — 26/26 API calls went through XHR. A `fetch`
  hook sees nothing.
- **`performance.getEntriesByType('resource')` is useless on x.com**: the 250-entry
  resource-timing buffer is already saturated before a user clicks, so the page's GraphQL
  URLs have been evicted. Read the operation id out of the client bundle instead.


### Response path

```
data.tweetResult.result.legacy.extended_entities.media[].video_info.variants[]
```

`legacy.entities.media[]` carries an identical copy — use `extended_entities` (complete set).

---

## 4. The actual video URLs

### 4a. Progressive MP4 — best for a downloader

| Bitrate | URL | Size |
|---|---|---|
| 2176000 | `https://video.twimg.com/amplify_video/2114572381842714624/vid/avc1/962x720/zyHZvTSE7AOz7BIc.mp4?tag=29` | 2,296,709 B |
| 832000 | `https://video.twimg.com/amplify_video/2114572381842714624/vid/avc1/480x360/kA8DaEhssCTYztRS.mp4?tag=29` | 698,640 B |
| 256000 | `https://video.twimg.com/amplify_video/2114572381842714624/vid/avc1/360x270/EInvVkC7IQ85WZzg.mp4?tag=29` | 261,517 B |

Verified: `?tag=29` is **optional** (200 + identical 2,296,709 bytes without it).
`pbs.twimg.com/amplify_video/…` is a working legacy CDN alias for the same file.

### 4b. HLS — what the web player actually uses

Master:
`https://video.twimg.com/amplify_video/2114572381842714624/pl/9YveWDwqSvFKo2vK.m3u8?tag=29&v=e39`

```
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=961100,BANDWIDTH=1371804,RESOLUTION=962x720,CODECS="mp4a.40.2,avc1.64001F",SUBTITLES="subs",AUDIO="audio-128000"
/amplify_video/2114572381842714624/pl/avc1/962x720/t2MZVTw9LElJ1Njr.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=287254,BANDWIDTH=415485,RESOLUTION=480x360,CODECS="mp4a.40.2,avc1.4D401E",SUBTITLES="subs",AUDIO="audio-64000"
/amplify_video/2114572381842714624/pl/avc1/480x360/9PlaLamc8BxBdpPs.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=103434,BANDWIDTH=145384,RESOLUTION=360x270,CODECS="mp4a.40.2,avc1.4D400D",SUBTITLES="subs",AUDIO="audio-32000"
/amplify_video/2114572381842714624/pl/avc1/360x270/RIiTvGZ-fDWUJcgT.m3u8
```

Audio renditions (separate, `EXT-X-MEDIA`): `pl/mp4a/128000/_ZNVLHY7xxW87WJu.m3u8`,
`pl/mp4a/64000/xwLKhP-s7dpIH8L9.m3u8`, `pl/mp4a/32000/GdDv5KYNta1GnPGm.m3u8`.

Subtitles: `pl/s0/Ff1SLgy1-8uPtyaI.m3u8` → `/subtitles/amplify_video/2114572381842714624/0/F3CEcBt1hH0kFRK2.vtt`
(auto-generated, `en`).

720p variant playlist → 6 segments (`vid/avc1/<start_ms>/<end_ms>/962x720/*.m4s`, 3 s each + 4 s tail = 19 s),
plus init `vid/avc1/0/0/962x720/yOFbycdT8X25Be1n.mp4`.

### 4c. The trap that makes naive downloaders 404

**Playlist hashes and media hashes are different tokens.** Rewriting the HLS variant URL into a
progressive MP4 path with the *playlist's* hash 404s:

```
❌ 404  …/vid/avc1/962x720/t2MZVTw9LElJ1Njr.mp4     (hash from pl/…m3u8)
❌ 404  …/vid/avc1/360x270/RIiTvGZ-fDWUJcgT.mp4     (hash from pl/…m3u8)
❌ 404  …/pl/avc1/962x720/t2MZVTw9LElJ1Njr.mp4
✅ 200  …/vid/avc1/962x720/zyHZvTSE7AOz7BIc.mp4     (hash from video_info.variants)
```

The correct `.mp4` hash is only obtainable from `video_info.variants[]` (GraphQL) or the
syndication payload. It cannot be derived from the playlist URL.

---

## 5. Recommended resolution order

1. **GraphQL `TweetResultByRestId`** — same-origin from the page with `credentials: 'include'`
   and `x-csrf-token: <ct0 cookie>`. Authoritative, gives bitrate + HLS + mp4.
   Read the query id dynamically; don't hardcode the hash.
2. **Syndication** `cdn.syndication.twimg.com/tweet-result?id=<tweet_id>&lang=en&token=1` —
   no auth, no session, returns the same variant set. Great fallback, and note it needs the
   **tweet id**, not the media id (that returns 404).
3. **Never** `statuses/show.json` or `video/1.1/show.json` — permanently 404.
4. Prefer the `video/mp4` variant (single file, muxed A+V) over assembling HLS `.m4s`
   segments. Use HLS only when you need the auto-generated subtitle track or the exact
   streaming rendition.

See `x_video_resolver.js` for a reference implementation.

---

## 6. Deliverables in this folder

- `Rayo_Libertario_2114572412054274285_720p.mp4` — the 720p video, downloaded and verified
  (h264 High 962×720 @30 fps, AAC-LC 128 kbps, 19.05 s, 2,296,709 bytes)
- `frame_3s.png` — frame at t=3 s (visual confirmation)
- `x_video_resolver.js` — reference resolver implementing the order above
