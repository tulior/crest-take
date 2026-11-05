# Crest Take

A Manifest V3 Chrome extension that adds a download control to video posts on **x.com**. One click resolves the selected post through X's `TweetResultByRestId` GraphQL operation, selects the globally highest-bitrate progressive MP4, and hands the URL to Chrome's download manager.

No HLS reconstruction, bulk downloading, analytics, remote code execution, or developer-operated server.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository's root directory.
3. Reload any existing x.com tabs, then use the ⬇ button on a video post.

Files are saved to `Downloads/x-videos/` as `handle_post text.mp4`.

## Implementation

- **content.js** reconciles controls within each post (including quoted posts), discovers the current GraphQL query ID and public app bearer from the page's script assets, makes an authenticated request to x.com, and selects the best progressive MP4 through **core.js**. Discovery occurs on demand; credentials are kept only in content-script memory.
- **service_worker.js** validates start messages, creates a durable request-ID reservation before calling Chrome's download API, correlates download events, and reports authoritative complete/interrupted status. It can recover in-progress jobs after a worker restart and is idempotent for a repeated request ID.
- The worker persists individual records under `crestTakeJobV2:` and `crestTakeOrphanV2:` in `chrome.storage.local`, rather than rewriting an entire ledger on each status check. An in-memory reverse map indexes downloads by ID. Terminal jobs are removed when acknowledged; unacknowledged terminal records expire after 30 days. Records contain opaque request IDs, download IDs, status, timestamps, and a one-way media-URL fingerprint — **not** cookies, bearer tokens, raw media URLs, filenames, or post text.

## Permissions

| Permission | Purpose |
| --- | --- |
| `downloads` | Start downloads and observe Chrome's completion/interruption state. |
| `storage` | Persist minimal download-correlation records across MV3 worker suspension. |
| Host access: `https://x.com/*` | Run on x.com and resolve a clicked post via its authenticated X request. |

The page's current script assets may be read as text for metadata discovery. No remotely obtained script is evaluated.

## Tests

Run `npm test` or `node --test tests/*.test.mjs`. These tests cover pure selection/filename/state logic and a mocked service-worker lifecycle. They are not a live Chrome/X integration test.

## Source layout

```text
manifest.json
core.js
content.js
service_worker.js
icon128.png
package.json
tests/
docs/
PRIVACY.md
LICENSE
```

## Privacy and scope

[PRIVACY.md](PRIVACY.md) describes the locally stored recovery metadata and data flows. The extension does not upload anything to its developer. It operates on video available to the user's existing X session; it is not affiliated with X Corp.

MIT licensed; see [LICENSE](LICENSE).
