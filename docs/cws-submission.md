# Chrome Web Store submission notes — Crest Take v3

This file describes the current module-based extension. Check the latest Chrome Web Store requirements and developer dashboard fields before publishing.

## Distribution package

Archive the following files at the ZIP root:

```text
manifest.json
shared.js
content.js
sw.js
icon128.png
```

The existing 128×128 `icon128.png` is retained. Do not package tests, package metadata, or protocol notes.

## Single purpose

Add a button to eligible video posts at `x.com`. Save the post's highest-bitrate progressive MP4 using the user's existing logged-in X session and Chrome's own downloads manager. Filenames include the author's handle, post ID, and sanitized post text. No conversion, bulk download, telemetry, accounts, or developer server.

## Permission justifications

- **downloads:** initiate a selected download, observe terminal Chrome download events, and query download status after worker restart.
- **storage:** persist minimal local request/download correlation and URL/filename fingerprints to prevent duplicates, recover an interrupted callback window, and clean up acknowledged/expired jobs.
- **x.com host:** run the content script on video posts and call the authenticated metadata operation.
- **abs.twimg.com host:** inspect the current X client assets as plain text for an operation identifier and public app bearer. Upon stale query-ID detection the extension may also fetch the current `x.com` HTML document to discover newly deployed script URLs. Remote JavaScript and HTML scripts are **not evaluated**.

The privacy disclosure must reflect local persistence of minimal download metadata. The extension intentionally does **not** claim zero storage or no host permissions.

## Data declarations

See [../PRIVACY.md](../PRIVACY.md). The extension transiently handles the clicked post's text and the existing X authentication context. It retains only opaque correlation IDs, download IDs, state, timestamps, owning tab/frame IDs, and SHA-256 fingerprints in local extension storage. It does not retain raw media URLs, cookies, bearer tokens, or post text.

## Manual verification before store submission

1. Load the extension unpacked and reload an X page.
2. Check one button for each independently eligible video post, including nested quoted posts.
3. Download an MP4; check `Downloads/x-videos/` and the eventual success state.
4. Interrupt a download and verify failure without false success; check durable storage-change notification and fallback status polling.
5. Restart the service worker during a transfer and in the Chrome download acceptance window; verify recovery or conservative failure.
6. Verify acknowledged download keys are removed and review browser storage and host permissions.
7. Re-run `npm test`; the mocked tests do not provide live Chrome/X validation.

`docs/x_video_analysis.md` and `docs/x_video_resolver.js` remain historical protocol references, not distributed runtime.
