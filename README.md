# Crest Take

Save the highest-bitrate MP4 from a video post with one click.

Runs on `x.com`. Keeps nothing, uploads nothing, asks for nothing.

---

## What it does

One button appears in the action bar of every video post. Click it and the extension:

1. resolves that post's media through **one authenticated GraphQL operation**,
2. picks the **highest-bitrate MP4** among the offered variants,
3. hands the URL to **Chrome's own download manager**,
4. reports pending → saved / failed on the button itself.

There is no panel, no queue, no options page, no account, no telemetry, and no
persistent state. There is no bulk mode, no bookmark batch, no auto-scroll, no
statistics — those were removed because nothing needed them.

Files land in `Downloads/x-videos/` as `handle_post text.mp4`.

## Why this name

**Crest Take** is a *rank + instance* compound — the family of English compounds where a
grade modifier qualifies a countable noun naming one discrete instance of a produced
work ("prime example", "final draft", "cover shot", "first cut"). The pairing is new.

| morpheme | root | what it asserts |
|---|---|---|
| **crest** | Old English *crēst* — the crest of a wave, a ridge; Latin *crista* | the **selection rule**: the top-grade rendition among the variants, not merely *a* file |
| **take** | Old English *tacan* "to take" → the count noun "a take" | the **unit of work**: one post, one press, one resulting file — no queue, no batch, no second click |

Read together: *the top-grade rendition, obtained in a single take.* That is exactly the
extension's contract, and nothing in the name claims anything the tool does not do —
no conversion, no batching, no scheduling, no hosting.

The name deliberately carries **no platform mark**: it names the tool, not the site it
reads, and not whoever ships it, so forks stay nameable ("Crest Take Community") without
inventing a new identity.

## Install

```
chrome://extensions  →  Developer mode  →  Load unpacked  →  select this folder
```

Then open `x.com` and press the ⬇ button on any video post. Reload any already-open
X tab after installing.

## How it works

```
GET https://x.com/i/api/graphql/<queryId>/TweetResultByRestId
    ?variables={"tweetId":"…","includePromotedContent":true,
                "withBirdwatchNotes":true,"withVoice":true,"withCommunity":true}
    &features={}&fieldToggles={}

authorization: Bearer <app-level token>   ← read from the client bundle at runtime
x-csrf-token: <the page's ct0 cookie>
credentials: include                      ← the session cookie rides along
```

### The part that is easy to get wrong

**Chrome's HAR export omits the `authorization` header.** A captured GraphQL request
therefore looks like a cookie-only request, and it is tempting to conclude that the
session cookie alone authenticates the call. It does not. Measured live in a logged-in
session, one variable changed at a time:

| request | result |
|---|---|
| session cookie + `x-csrf-token` only | **403**, empty body |
| … + `authorization: Bearer <app token>` | **200**, media returned |
| … but no `x-client-transaction-id` | 200 |
| … but empty `features` / `fieldToggles` | 200 |
| … but no `x-twitter-client-language`, no `content-type` | 200 |
| … but a 2.5 h-old `x-client-transaction-id` | 200 |

Only two things are required: the **app-level Bearer** and an **`x-csrf-token` that
matches the live `ct0` cookie**. The Bearer is not a secret — it is the public constant
the web client ships in its own bundle, which is why the extension reads it out at
runtime instead of pinning it. A stale csrf value answers with
`{"errors":[{"code":353,…}]}` instead, so the two failures are distinguishable.

Two more traps, both measured:

- **The client uses XHR, not `fetch`** — a `fetch` hook sees none of its traffic.
- **`performance.getEntriesByType('resource')` is useless here**: the 250-entry
  resource-timing buffer is already saturated on x.com before anyone clicks, so the
  page's GraphQL URLs have been evicted. The operation id is read from the client
  bundle's registry instead.

`docs/x_video_analysis.md` has the full protocol write-up, the HAR evidence, and the
media-variant tables.

## Permissions

| permission | why |
|---|---|
| `downloads` | hand the resolved URL to Chrome's download manager |

That is the entire list. **No host permissions** — the client bundle is fetched
cross-origin because `abs.twimg.com` serves it with `access-control-allow-origin: *`,
and the media URL is handed to the browser's download manager rather than fetched by the
extension. **No `storage`** — there is no state to persist, so completion travels back as
the reply to the message that started the download.

## Tests

```
node test/test-xdl.js
```

83 checks, no dependencies beyond Node itself. The harness runs **both** execution
contexts of `x.js` — service worker and content script — against the real GraphQL
payload and the real client bundle, sharing one emulated Chrome platform so the
cross-context protocol is exercised for real. It covers the normal path, an
interrupted download, a quoted post (each button must resolve its *own* post), bundle
and GraphQL failures, query-id rotation, duplicate injection, concurrent activation, and
the manifest's permission surface.

The content-script sandbox deliberately has **no `performance` object**, so any
regression back to resource timing fails loudly.

## Layout

```
manifest.json     the extension (MV3) — the only two files Chrome needs
x.js              the extension source: service worker + content script, one file
test/test-xdl.js  the integration harness
docs/             protocol analysis and the turn-1 reference resolver
```

## A note on the platform

This is an unofficial client. It only reads what your own logged-in session can already
read, and it is not affiliated with, endorsed by, or sponsored by X Corp.
