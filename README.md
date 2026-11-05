# Crest Take

A Chrome Manifest V3 extension for downloading the highest-bitrate progressive MP4 attached to an X post.

A download control appears on eligible posts at `x.com`. On activation, the content script discovers X's current `TweetResultByRestId` GraphQL operation and application bearer from client script assets, resolves the selected post through the user's own authenticated X session, and selects the best progressive MP4 with a linear scan. Chrome's download manager performs the transfer.

No build step, video reconstruction, bulk mode, telemetry, developer-operated backend, or remotely executed code.

## Install

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Select **Load unpacked** and choose the repository root.
3. Reload already-open X tabs. Use the download control on a video post.

Downloads are saved under `Downloads/x-videos/`, with filenames derived from the author and post text.

## Runtime design

`shared.js` contains post/video selectors, operation metadata matching, MP4 selection, and filename safety rules.

`content.js` handles post-scoped control reconciliation, authenticated media resolution, per-control state, and download-status notification. It uses a request-ID-indexed pending map, direct worker notifications, and polling as a fallback.

`sw.js` is a module service worker that uses individually keyed records in `chrome.storage.local`:

| Key | Value |
| --- | --- |
| `xdl:req:<requestId>` | Download phase, Chrome download ID, owning tab/frame, creation/start times, SHA-256 URL and filename fingerprints |
| `xdl:dl:<downloadId>` | Reverse mapping to a request ID |

Downloads for unrelated request IDs can start concurrently; each request ID has a serialized critical section. A `STARTING` reservation is durably written **before** invoking Chrome's download API. After worker suspension/restart, an unconfirmed start is reconciled against uniquely matching, extension-created Chrome downloads using URL fingerprint and start-time checks. Ambiguous matches are rejected rather than initiating another transfer.

The worker writes both direct and reverse records upon confirmation, handles terminal `onChanged` events, and also verifies completion using `chrome.downloads.search`. It notifies the originating tab while allowing polling if the tab missed the notification. Terminal acknowledgments remove both record keys. Unacknowledged terminal records are pruned after 30 days; orphan reverse entries are also removed. Full scans are reserved for startup/periodic cleanup and exceptional recovery, not ordinary lookups.

No credentials, post text, raw video URLs, or filenames are stored by the extension. A startup/cleanup scan may touch local recovery records. No server-side sync is used.

## Permissions

- `downloads`: initiate and observe downloads, recover Chrome download status.
- `storage`: preserve minimal download correlation and recovery state across service-worker/browser restarts.
- Host access to `x.com`: inject controls and resolve clicked post media.
- Host access to `abs.twimg.com`: access X's public client assets for operation discovery.

See [PRIVACY.md](PRIVACY.md) for a fuller description of data use.

## Tests

Run `npm test` (Node.js 22 or later recommended). The tests cover pure helpers and a mocked MV3 worker lifecycle, including concurrent starts, interrupted-download recovery, callback-gap restart, ambiguous candidate rejection, authoritative completion, acknowledgments, and expiry. These are not a substitute for live Chrome/X integration testing.

## Files

```text
manifest.json
shared.js
content.js
sw.js
icon128.png
package.json
tests/
docs/
PRIVACY.md
LICENSE
```

The existing `docs/x_video_analysis.md` and `docs/x_video_resolver.js` are historical protocol references.

Crest Take is unofficial and is not affiliated with X Corp. Respect creators' rights and platform terms. MIT license; see [LICENSE](LICENSE).
