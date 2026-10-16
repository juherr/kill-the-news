# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Keep the `## [Unreleased]` section up to date **as part of every change** (the
same rule as the rest of the docs). At release time `npm run release X.Y.Z`
promotes this section to `## [X.Y.Z]` and the Release workflow publishes it
verbatim as the GitHub Release notes — so what you write here is what ships.

## [Unreleased]

### Added

- The admin dashboard now shows each feed's email count on its **Emails** button
  and a **"Last email …"** freshness line under the feed title, in both the list
  and table views. Both values are projected into `feeds:list`, so the dashboard
  stays a single KV read; they backfill on a feed's next email or save.

### Fixed

- Update Hono, Wrangler, esbuild and Vitest to patched releases that address
  dependency security advisories. Wrangler now requires Node.js 22 or later;
  the dry-run build uses its renamed `--no-autoconfig` flag.
- WebSub subscription requests now reject file uploads for `hub.secret` and
  `hub.lease_seconds` rather than treating them as text fields.
- Setup no longer fails to list KV namespaces because of an unsupported `--json`
  flag or reports that failure as an authentication problem. Namespace parsing
  now reads Wrangler's JSON correctly and matches explicit worker-prefixed
  titles instead of falling back to unrelated namespaces. Wrangler errors remain
  visible, and setup checks for existing namespaces before creating missing ones,
  so reruns with both namespaces present do not require KV-create permission.
  The listing runs in CI mode so Wrangler's agent-skills notice cannot corrupt
  the JSON output.
- Per-feed favicons now resolve for senders on a subdomain that hosts no icon of
  its own (e.g. `mail.example.com`): the lookup walks up to the apex domain
  (`example.com`) and uses its favicon, caching it under the original sender
  domain. Previously both the direct `/favicon.ico` and the DuckDuckGo lookup
  were tried only against the full subdomain, leaving such feeds blank.
- Subscription-confirmation detection now flags code-based signup verifications
  (OTP) that have no link to click — e.g. "Your verification code is 371404",
  whose only link is a `mailto:` support address. These cleared the keyword
  threshold but were dropped because the detector required an http(s) candidate
  link. A code path now raises the flag/badge/banner when a verification keyword
  sits next to an OTP-style code; the code itself is never extracted or surfaced.
- Subscription-confirmation detection now recognizes localized "subscribe" CTAs.
  The weak link-signal vocabulary was English-only (`subscrib`),
  so a genuine double opt-in whose confirm button reads "Je m'inscris…" over an
  opaque tracking redirect scored 0 on every link and was missed. The weak vocab
  is now multilingual (FR/DE/ES) to match the confirmation keywords.
- Per-feed favicons no longer fail for senders whose DuckDuckGo icon is a
  hi-res PNG: the maximum accepted favicon size is raised from 100 KB to 256 KB,
  so legitimate large icons (~107 KB and up) are cached instead of rejected.
  A domain that was already negatively cached only re-fetches once that entry's
  TTL expires (and something — a new email or a favicon request — retriggers
  the fetch); delete its `icon:<domain>` KV key to force an immediate refresh.
- Admin dashboard table view: long feed titles no longer overflow into the Feed
  ID column — the title/description cell now shrinks so its text ellipsises.
- RSS and Atom feeds now advertise the WebSub hub inside the feed body
  (`<atom:link rel="hub">`), not just in the HTTP `Link` header. Readers like
  FreshRSS discover the hub from the XML, so they can now subscribe and receive
  an instant push when a new email arrives instead of waiting up to the cache
  `max-age` (30 min) to refresh.
- Subscription-confirmation detection now recognises a confirm email whose CTA
  button carries the subscribe/subscription hint only in its visible text (e.g.
  "Yes, subscribe me to this mailing list.") over an opaque tracking-redirect
  href — previously the link scored zero and the email was missed.
- Sender favicons now recover from a transient miss: a failed favicon lookup is
  cached negatively for 6 hours instead of a full week, so a domain whose icon
  was momentarily unavailable (e.g. not yet indexed upstream) is retried on the
  next email instead of staying blank for days.
- Feed entry HTML now escapes bare ampersands in attribute URLs (e.g. query
  strings like `?a=1&b=2`), clearing the W3C feed validator's "Named entity
  expected. Got none." warning and improving interoperability with stricter
  feed readers.

## [0.3.1] - 2026-05-25

### Fixed

- Feed self link (RSS/Atom/JSON) is derived from the configured domain instead
  of the request host — it no longer leaks the `workers.dev` host when a feed is
  reached directly, and now matches the alternate link.

## [0.3.0] - 2026-05-25

### Added

- **Native feed detection** — incoming newsletters are inspected for a
  self-advertised Atom/RSS/JSON feed (`rel=alternate` links in the email HTML);
  discovered feeds are stored per sender on the Feed aggregate and surfaced as
  chips on the feed detail page, a dashboard pill, and (read-only) on the REST
  `Feed` schema, with a dismissable notice.
- **Subscription confirmation surfacing** — confirmation emails ("click to
  confirm your subscription") are detected at ingestion and flagged on the feed;
  the admin UI surfaces the confirmation link, a badge, a dashboard pill, and an
  inline banner (all dismissable), tightened against false positives via a
  weak-signal heuristic.
- **JSON Feed 1.1** output (`/json/:feedId`).
- **OPML export** of all feeds (`/admin/opml`).
- **Conditional GET** (ETag / Last-Modified / 304) on the feed routes.
- Per-feed **Subscribe chips** for RSS/Atom/JSON with copy / open / validate
  actions, reused across dashboard and feed detail page.
- Email detail page links to its public entry page; land on the feed's emails
  page right after creation.
- Optional **per-feed "sender in title"** toggle.
- Running **version** shown in the admin/status footer, `/health`, and
  `/api/v1/stats`.

### Changed

- **Read/write identity decoupling (privacy)** — the public read id (`FeedId`,
  used in `/rss/:feedId`) is fully decoupled from the inbound email address
  (`MailboxId`, `noun.noun.NN`); a feed's read URL never reveals its inbound
  alias and vice-versa (reading `/rss/<noun.noun.NN>` 404s).
- Sender display name, site URL and parsing now owned by the `EmailAddress`
  value object (DDD cleanup).
- Release version is derived from the git tag; CI guards against tagging the
  wrong commit.

## [0.2.1] - 2026-05-24

### Added

- Optional `FALLBACK_FORWARD_ADDRESS`: forward non-feed mail to a verified
  address so a domain catch-all can point at kill-the-news without swallowing
  personal mail (forwarded mail is counted in the stats dashboard).

### Changed

- Feed, entry, and attachment responses send `X-Robots-Tag: noindex`; a new
  `/robots.txt` disallows `/rss`, `/atom`, `/entries`, `/files`, and `/admin` —
  private feeds and emails stay out of search engines.
- Relative links/images in email bodies are absolutized against the sender's
  site; lazy-loaded images are promoted so they don't render blank.
- Feed `<title>` is plain text (HTML stripped, entities decoded).
- Sender-site derivation moved onto the `EmailAddress` value object
  (`siteBaseUrl`).

### Fixed

- XML-illegal control characters are stripped from generated feeds (valid astral
  characters such as emoji preserved).

## [0.2.0] - 2026-05-24

### Added

- Versioned REST API (`/api/v1/feeds*`) with an OpenAPI 3.1 spec
  (`/api/openapi.json`) and rendered reference docs via Scalar (`/api/docs`).
- `/api/v1/stats` as the canonical public stats endpoint (JSON + CORS).
- Optional R2 attachment storage with a config toggle, storage metrics, download
  links on the email/admin views, and inline `cid:` image rendering.
- Project favicon (`/favicon.svg`, `/favicon.ico`) and per-feed favicon derived
  from the last sender's domain (`/favicon/:feedId`).
- RFC 8058 one-click unsubscribe dispatched when a feed is deleted.

### Changed

- Large internal refactor toward a clean domain-driven architecture; redesigned
  landing/status page.

### Removed

- The deprecated `/api/stats` endpoint (use `/api/v1/stats`).

## [0.1.0] - 2026-05-22

### Added

- **Atom feed format** (`/atom/:feedId`) alongside RSS 2.0.
- **WebSub push notifications** advertised via `Link` header for real-time
  delivery instead of polling.
- **HTML email processing** — bodies sanitized via `linkedom` + `escape-html`
  (XSS prevention, MSO style stripping, plain-text fallback).
- **Email attachments as RSS enclosures**, stored in R2 and served at
  `/files/:attachmentId/:filename`.
- **Sender blocklist** with 4-level priority matching and a quick-add dropdown.
- **`EMAIL_DOMAIN`** env var to separate web domain and email domain.
- **Authelia / reverse-proxy auth** via trusted headers (`Remote-User`,
  `X-Forwarded-User`).
- Demo environment auto-deployed to `demo.kill-the.news` with a nightly KV
  reset.
- Admin UI redesign (Inter font, orange theme), client scripts compiled via
  esbuild, templates on `hono/jsx`.

[Unreleased]: https://github.com/juherr/kill-the-news/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/juherr/kill-the-news/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/juherr/kill-the-news/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/juherr/kill-the-news/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/juherr/kill-the-news/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/juherr/kill-the-news/releases/tag/v0.1.0
