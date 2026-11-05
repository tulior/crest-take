# Chrome Web Store submission notes — Crest Take v2

This file describes the **current v2 extension**. Verify current Chrome Web Store policies and dashboard wording before submission; older store claims and review estimates are not authoritative.

## Package

ZIP these files with `manifest.json` at the archive root:

```text
manifest.json
core.js
content.js
service_worker.js
icon128.png
```

No development tests, documentation, or Node package files are required in the extension ZIP. The 128×128 icon is in `icon128.png`.

## Listing summary

Crest Take adds a download control to video posts on x.com and saves the highest-bitrate progressive MP4 selected by the user.

The button reports resolving, transferring, success, or failure. It does not offer HLS reconstruction, batch operations, accounts, telemetry, or a developer-operated server.

## Permissions justification

- **downloads:** start a user-initiated download, observe Chrome's download state, and check completion or interruption.
- **storage:** retain minimal request/download identifiers, phase, timestamps, and a URL fingerprint for MV3 worker-restart recovery. Per-request records are removed after acknowledgement and stale terminal records are eventually pruned.
- **host access (`https://x.com/*`):** place controls on X posts and resolve the selected post with the user's existing authenticated session.

The content script discovers the GraphQL query ID and public application bearer by reading the web client's script assets **as text**. It does not evaluate remote code.

## Data disclosure

See [../PRIVACY.md](../PRIVACY.md). The extension processes post text and the user's X authentication context transiently, and stores only minimal download recovery metadata in Chrome local extension storage. No raw media URL or authentication data is stored; there is no developer server or analytics.

## Manual verification

1. Load the unpacked extension into a supported Chrome build.
2. Sign in to x.com, open an ordinary video post and a quoted video post, and verify separate controls resolve their own posts.
3. Verify the saved file under `Downloads/x-videos/` and the button's completed state.
4. Verify interrupted downloads become failures and retries are usable.
5. Suspend/restart the MV3 worker during a transfer and verify status recovery.
6. Review the manifest permissions and privacy statement together before submitting.

## Source documentation

`docs/x_video_analysis.md` and `docs/x_video_resolver.js` are historical protocol analysis, not shipped extension runtime code.
