# Privacy Policy — Crest Take

**Updated: November 5, 2026.** This policy covers the Crest Take Chrome Manifest V3 extension.

Crest Take saves a user-selected X post's highest-bitrate progressive MP4 through Chrome's own download manager. It has no developer-operated service, account, telemetry, advertising, analytics, or data sales.

## Data processed

- The clicked post's identifier, author handle, and text are read from the visible X page. The identifier selects the post to resolve; the identifier, handle, and text generate the download filename.
- The user's existing X session is used for a request back to `x.com`. The current `ct0` CSRF cookie and the public app-level bearer extracted as text from X's client assets are used transiently. The extension does **not** persist cookies, app bearer, post text, filenames, or raw video URLs.
- Minimal download recovery records are stored **locally** using `chrome.storage.local`. A request record includes a random request ID, state, owning tab/frame IDs, download ID, timestamps, and SHA-256 fingerprints of the URL and filename. A second key maps Chrome's download ID to the request ID. The records allow duplicate prevention, terminal-status reporting, and recovery when the service worker restarts or a Chrome download-start callback is lost.

A terminal record and its reverse index are deleted when the content script acknowledges its terminal state. Unacknowledged terminal records are pruned after 30 days, and stale reverse entries are cleaned up during startup/periodic maintenance. Records are stored only in the browser's local extension storage, not synced to the developer. The service worker requests that storage access be restricted to trusted extension contexts.

## Network requests

On activation, the extension may fetch the public X web client's JavaScript bundles (including `abs.twimg.com`) **as text** to discover the current GraphQL operation and application token. If that operation is stale, it may fetch the current `x.com` document as HTML text to find a fresh list of script asset URLs, then read those assets as text. The HTML and remote scripts are not executed. Remote JavaScript is not executed. It makes the authenticated media metadata request to `x.com`; Chrome's download manager then fetches the selected MP4 from the media host (typically `video.twimg.com`). No user data is sent to the extension developer, analytics providers, or advertising partners.

## Limited Use and user rights

Collected/processed data is used solely to fulfil the user-requested download and verify its outcome, not for targeting, profiling, resale, or human review. Crest Take intends to comply with the Chrome Web Store User Data Policy and Limited Use requirements. The extension does not bypass login or access controls. Users must respect copyright and the terms of the platform they access.

Crest Take is not affiliated with X Corp.

For questions, contact [mail@tulio.org](mailto:mail@tulio.org).
