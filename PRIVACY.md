# Privacy Policy — Crest Take

**Effective date:** 2026-10-27
**Applies to:** the Crest Take Chrome extension (Manifest V3).

Crest Take is a single-purpose extension: it adds a download button to video
posts on `x.com` and, when you click it, saves that post's highest-bitrate MP4
to your Downloads folder. It has no server, no account, no analytics, and no
persistent state.

## What the extension handles

| data | where it comes from | what it is used for |
|---|---|---|
| **Website content** — the post's id, the author's handle, the post text | read from the page you are already looking at | to ask `x.com` for that post's media, and to name the file you get back |
| **Authentication information** — the `ct0` cookie of `x.com` | read from your own session | sent back to `x.com` and nowhere else, to authenticate that one request |

The post text is written into the saved file's name, trimmed to 80 characters
and stripped of anything that is not valid in a filename. Nothing else about the
page is read, and no other post is touched.

## What the extension does not do

- No analytics, telemetry, tracking, ads, or affiliate links.
- No `storage` permission, so **nothing is persisted** — no history, no
  preferences, no cache, no settings. When the request finishes, the data is
  gone.
- No account, no login of its own, and no server belonging to the developer.
  Nothing you do is sent to the developer, ever.
- No advertising of any kind, and no human being ever reads your data.

## What leaves your browser, and to whom

Exactly three requests, all to X's own infrastructure, and all only after you
click the button:

1. **`abs.twimg.com`** — the public JavaScript bundle of the `x.com` web
   client. The extension reads two strings out of it: the id of the GraphQL
   operation it has to call, and the public app-level bearer token that
   `x.com`'s own web client sends with every request. That bearer is a constant
   published in the bundle; it is **not** your account credential. The bundle is
   read as plain text and two strings are matched out of it — **no code from it
   is executed**, and the extension's own behaviour lives entirely in its
   package.
2. **`x.com/i/api/graphql/…`** — the request for that one post's media,
   carrying your own session cookie and the matching `ct0` value.
3. **`video.twimg.com`** — the media file itself, fetched by Chrome's own
   download manager when the file is saved.

The extension contacts no other host, and no server belonging to the developer.
All three requests use HTTPS.

## Limited Use

This extension's use of user data complies with the Chrome Web Store User Data
Policy, including the Limited Use requirements. The use of information received
from Google APIs will adhere to the Chrome Web Store User Data Policy, including
the Limited Use requirements.

Concretely:

- **Allowed use.** The data listed above is used only to provide the
  extension's single purpose: saving one video the user is already able to
  view. It is not used for anything else.
- **Allowed transfer.** The data is transferred only to `x.com` and
  `video.twimg.com`, which is necessary to provide that purpose, and to nobody
  else.
- **No advertising.** The extension never transfers or sells data for
  personalized advertising, re-targeting, or interest-based advertising, and it
  contains no ads.
- **No human interaction.** No developer, employee, or contractor can read your
  data. The extension has no server endpoint for it to arrive at.

## Copyright, and what this extension is not

Crest Take does not circumvent paywalls, logins, or any access control. It
only saves media that your own logged-in session can already play on the page
you are looking at. It hosts no media and distributes no media.

You are responsible for respecting the rights of content creators and the terms
of the platform whose content you save. Crest Take is an unofficial client and
is not affiliated with, endorsed by, or sponsored by X Corp.

## Changes and contact

If this policy changes, the new version is published in this repository and the
effective date above is updated. Questions: [mail@tulio.org](mailto:mail@tulio.org).
