# Privacy Policy — Crest Take

**Updated:** 2026-11-05  
**Applies to:** Crest Take, the Manifest V3 Chrome extension.

Crest Take adds a button to video posts on x.com. On activation it requests that post's metadata using the user's existing X session, chooses the highest-bitrate progressive MP4, and asks Chrome to download it. The extension has no developer-operated backend, account, advertising, tracking, or analytics.

## Data used

- **Clicked post content:** post ID, author handle, and text, used to resolve the correct media and construct the filename.
- **X authentication context:** the current `ct0` CSRF cookie, the user's existing session cookies (automatically sent to x.com), and the public application bearer read from X's own client bundles. These are used for requests to x.com only, and are **not persisted**.
- **Minimal local download state:** a random request ID, Chrome's download ID, status/phase, timestamps, and a one-way SHA-256 fingerprint of the media URL. A limited number of short-lived orphaned download events may also be stored to recover event/callback ordering. These records are held in `chrome.storage.local` so an MV3 service worker can recover after suspension. They contain **no raw media URL, cookies, bearer tokens, filenames, post text, or browsing history**. The service worker attempts to restrict storage access to trusted extension contexts. Records are deleted on successful acknowledgement, and unacknowledged terminal records are pruned after 30 days; orphan records expire after 10 minutes.

## External connections

At activation time, the extension may read X's public JavaScript assets (for example from `abs.twimg.com`) as **text**, extracting the GraphQL operation ID and public app bearer; it does not execute external code. The post metadata request goes to `https://x.com/i/api/graphql/...` with the browser's existing X session. Chrome's download manager retrieves the chosen video media URL (typically `video.twimg.com`). No information is sent to the extension developer or third-party analytics services.

## User data and Limited Use

User data is used only to save a video selected by the user and to track whether that download completed. It is not sold, shared for advertising, used for profiling, or accessed by humans. The extension is intended to comply with the Chrome Web Store User Data Policy and Limited Use requirements; information received from Google APIs, if any, is subject to those requirements.

The extension does not bypass access controls and cannot grant access to media the user is not already allowed to view. Users are responsible for respecting creators' rights and platform terms. Crest Take is not affiliated with X Corp.

Questions: [mail@tulio.org](mailto:mail@tulio.org).
