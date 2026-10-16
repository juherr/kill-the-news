# Installation & deployment

How to set up, run, deploy, and configure kill-the-news. For an overview of what the project does, see [README.md](README.md).

## Requirements

- Node.js 22+
- A Cloudflare account (free plan works — Workers, KV, and Email Routing are all included)
- A domain added to Cloudflare as a zone (DNS managed by Cloudflare)
- A ForwardEmail account _(Option B only)_

## Cloudflare setup

If your domain is not yet on Cloudflare: in the [Cloudflare dashboard](https://dash.cloudflare.com/), go to _Add a site_, enter your domain, choose the Free plan, and follow the instructions to update your nameservers at your registrar. Wait for the zone to become active (usually a few minutes).

## Setup

1. Clone this repository.
2. Authenticate Wrangler:
   ```bash
   npx wrangler login
   ```
3. Run setup:

   ```bash
   bash setup.sh
   ```

   The script will prompt for an admin password and your domain, then:
   - install npm dependencies
   - verify Cloudflare auth (`wrangler whoami`)
   - look up KV namespaces (`<worker>-EMAIL_STORAGE` and `<worker>-EMAIL_STORAGE_preview`) in your account and create any that are missing
   - set the `ADMIN_PASSWORD` secret in the `production` environment
   - generate `wrangler.toml` from `wrangler-example.toml` with your KV IDs, domain, and today's compatibility date

4. Configure email ingestion — choose **one** of the two options below.

### Option A — Cloudflare Email Workers (recommended)

No third-party service required. Cloudflare receives the email and hands it directly to the Worker.

1. In the Cloudflare dashboard, go to _Email → Email Routing_ for your zone and click **Enable Email Routing**. Cloudflare will prompt you to add MX and SPF records — accept and it adds them automatically.
2. Under _Email Routing → Routing Rules_, add a **Catch-all** rule:
   - Action: **Send to Worker**
   - Worker: `kill-the-news` (the name from `wrangler.toml`)

That's it. No webhook configuration is needed.

### Option B — ForwardEmail (alternative)

Use this if you prefer ForwardEmail's additional features (sender filtering, open-tracking, etc.).

Add these DNS records in Cloudflare (_DNS → Records_):

| Type | Name | Content                                              | Notes                   |
| ---- | ---- | ---------------------------------------------------- | ----------------------- |
| MX   | @    | `mx1.forwardemail.net`                               | Priority `10`, DNS only |
| MX   | @    | `mx2.forwardemail.net`                               | Priority `10`, DNS only |
| TXT  | @    | `"forward-email=https://yourdomain.com/api/inbound"` | webhook target          |
| TXT  | @    | `"v=spf1 include:spf.forwardemail.net -all"`         | SPF                     |

Replace `yourdomain.com` with your actual domain.

The Worker verifies each webhook request against ForwardEmail's published MX IP list before processing it.

5. Deploy:

   ```bash
   npm run deploy
   ```

   Wrangler will create the Worker and register `yourdomain.com` (and `www.yourdomain.com`) as custom domains pointing to it. Cloudflare handles TLS automatically.

6. Open `https://yourdomain.com/admin` and sign in.

> **Tip:** To verify the Worker is running, check _Workers & Pages → kill-the-news_ in the Cloudflare dashboard. The _Custom Domains_ tab should list your domain once the deploy succeeds.

## Development

```bash
npm install
npm run dev
npm test
npm run build
```

## Continuous deployment (GitHub Actions)

The repo ships a [`Deploy Demo`](.github/workflows/demo.yml) workflow that generates `wrangler.toml` from `wrangler-example.toml` and runs `wrangler deploy --env demo` after CI passes on `main`. To wire up your own automated deploys, set these repository secrets (_Settings → Secrets and variables → Actions_):

| Secret                  | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Scoped API token used by Wrangler to deploy (see permissions below) |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID                                        |
| `DEMO_KV_NAMESPACE_ID`  | KV namespace ID substituted into the generated `wrangler.toml`      |
| `DEMO_ADMIN_PASSWORD`   | Admin password set via `wrangler secret put`                        |

### Deploy token permissions

Local `npx wrangler login` uses OAuth and already has every permission, so the gaps below only bite **scoped API tokens** (i.e. CI). Create the token at <https://dash.cloudflare.com/profile/api-tokens> — the **"Edit Cloudflare Workers"** template is the easiest base — and make sure it carries the permissions matching the bindings you actually deploy:

| Permission                                        | Needed for                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Account · **Workers Scripts** · Edit              | Deploying the Worker and running `wrangler secret put`                     |
| Account · **Workers KV Storage** · Edit           | The `EMAIL_STORAGE` KV binding                                             |
| Account · **Workers R2 Storage** · Edit           | The `ATTACHMENT_BUCKET` R2 binding (only when attachments are enabled)     |
| Zone · **Workers Routes** · Edit + **DNS** · Edit | The `custom_domain` routes (e.g. `demo.kill-the.news`), scoped to its zone |

Scope the token to the relevant **account** and, for custom domains, the relevant **zone**. A missing R2 permission fails with `Authentication error [code: 10000]` on `/r2/buckets/...`; a missing routes/DNS permission fails while provisioning the custom domain. The `User Details`/`Memberships` warnings Wrangler prints are only for `whoami` display and are not fatal.

## Configuration notes

- `wrangler-example.toml` is the template; `wrangler.toml` is generated locally.
- Keep `compatibility_date` fresh when doing runtime upgrades.
- `ADMIN_PASSWORD` is a Cloudflare Worker secret, not a plain env var in config.

### Native feed detection

When an incoming email's HTML advertises the newsletter's own syndication feed via `<link rel="alternate" type="application/atom+xml|rss+xml|feed+json">`, the worker captures those URLs at ingestion and shows them per feed — no configuration required:

- **Email detail page** — a "Native feeds" chip group lists each discovered feed URL with a copy button.
- **Feed dashboard** — a "Native feed available" pill signals that the source publishes its own feed.
- **Emails page banner** — a dismissable banner prompts you to subscribe to the source directly; once dismissed it stays hidden.
- **REST API** — the read-only `nativeFeeds` array on `GET/POST/PATCH /api/v1/feeds` exposes the same data for automation.

### Subscription confirmation

When a newsletter sends a "confirm your email" message, the worker detects it at ingestion using multilingual keyword matching and link scoring. Detected emails are automatically flagged and surfaced throughout the admin UI:

- **Email detail page** — a dedicated "Confirm your subscription" section appears at the top with a primary button linking directly to the confirmation URL.
- **Email list** — a "Confirmation" badge appears next to the subject so pending confirmations stand out at a glance.
- **Feed dashboard** — a "Confirmation pending" pill on the feed card signals that action is needed.
- **Emails page banner** — a dismissible banner with a "Mark as confirmed" button lets you clear the flag once you've clicked the link.

**v1 performs no outbound request.** The admin clicks the confirmation link themselves in their browser; the worker only detects and surfaces it. Server-side on-detect actions (auto-click from the worker, or forwarding the original email to a fallback address) are planned for a future version.

### Catch-all fallback forwarding

By default, inbound mail that doesn't match a feed is dropped (logged, then discarded). If you want to point a domain's **catch-all** at this worker without losing your personal mail, set an optional fallback address — non-feed mail is forwarded there instead of dropped:

```toml
[vars]
FALLBACK_FORWARD_ADDRESS = "you@example.com"
```

**Prerequisite:** the address must be a **verified destination** in _Email → Email Routing → Destination addresses_ (Cloudflare won't forward to an unverified address — `message.forward()` fails, and the worker just logs a warning). This only applies to the Cloudflare Email Workers path (Option A).

What gets forwarded vs dropped:

| Situation                                          | Action                |
| -------------------------------------------------- | --------------------- |
| Address isn't a feed (e.g. `you@`, typo)           | forward               |
| Well-formed feed address but no such feed          | forward               |
| Feed exists but is **expired**                     | drop                  |
| Feed exists but the sender is **blocked/filtered** | drop                  |
| Delivered to a live feed                           | ingested (no forward) |

Expired feeds and blocked senders are dropped on purpose, so a real newsletter never leaks into your fallback inbox. Leave the variable unset to keep the original drop-and-log behavior.

### Inbound address vs feed URL

Each feed has **two independent identifiers**, on purpose:

- a friendly **inbound address** you subscribe newsletters with — `noun.noun.NN@yourdomain.com` (e.g. `apple.mountain.42@yourdomain.com`);
- an **opaque feed URL** for your reader — `https://yourdomain.com/rss/<random-id>` (also `/atom/<id>`, `/json/<id>`).

They are not derivable from each other. This means you can hand someone a feed URL without revealing the address that feeds it, and an address harvested by a newsletter sender can't be turned into your feed (requesting `/rss/<your-address>` returns 404). The admin dashboard shows both per feed; copy the address into signup forms and the feed URL into your reader. (Internally the inbound address is mapped to the feed by an `inbound:<address>` KV entry, resolved only when mail arrives.)

### Feed size limit

By default the worker keeps emails until the feed's stored data exceeds **512 KB**, then drops the oldest entries (and their KV records) to stay under the limit. This is more robust than a fixed entry count for HTML-heavy newsletters.

To override the threshold, add to `wrangler.toml` under `[vars]`:

```toml
FEED_MAX_SIZE_BYTES = "524288"   # 512 KB — adjust as needed
```

### Email attachments (R2)

When an incoming email contains attachments, the Worker can store them in a Cloudflare R2 bucket and expose them as `<enclosure>` elements in the RSS feed (and `<link rel="enclosure">` in Atom). Each attachment is served at `/files/{id}/{filename}` with an immutable cache header. Attachments are also listed with download links on the admin email detail page and the public entry view.

Inline images (the ones an email references with `src="cid:…"`) are handled separately: they are still stored in R2 (and deleted with the email), but instead of appearing in the attachment list they render in place — the `cid:` reference is rewritten to the stored `/files/{id}/{filename}` URL in the feed, the admin preview, and the public entry view.

This feature is **optional**. If no R2 bucket is bound, attachments are silently ignored and nothing else changes.

**Setup (automated):** `setup.sh` now asks _"Enable email attachments stored in R2?"_. Answer yes and it creates the buckets (`<worker>-attachments` and `<worker>-attachments-preview`) and wires the binding into the generated `wrangler.toml` for you.

**Setup (manual):**

1. Create an R2 bucket in the Cloudflare dashboard (_R2 Object Storage → Create bucket_), or with Wrangler:
   ```bash
   npx wrangler r2 bucket create your-bucket-name
   ```
2. In `wrangler.toml`, uncomment and fill in the R2 binding (the commented block from `wrangler-example.toml`):
   ```toml
   r2_buckets = [
     { binding = "ATTACHMENT_BUCKET", bucket_name = "your-bucket-name", preview_bucket_name = "your-bucket-name-preview" }
   ]
   ```
   The binding is **per environment**: add it under every env you deploy (`[env.production]`, `[env.demo]`, …), each pointing at its own bucket.
3. Redeploy:
   ```bash
   npm run deploy
   ```

> **Deploy token permission:** with an R2 binding, `wrangler deploy` verifies the bucket exists, so a scoped CI token also needs **Account → Workers R2 Storage** — see [Continuous deployment](#continuous-deployment-github-actions). Local `npx wrangler login` already has it.

**Turning it off:** set `ATTACHMENTS_ENABLED = "false"` in `[vars]` to disable attachments even while the R2 bucket stays bound (useful to cap usage on a demo). Any other value (or leaving it unset) keeps the feature on whenever R2 is configured.

Attachments are deleted from R2 automatically when the corresponding email is deleted from the admin UI, or when an email is dropped during feed size trimming.

**Monitoring storage / free tier:** the status page (`/`) and `/api/v1/stats` report R2 space used (against the **10 GB** R2 free tier) and an estimate of KV space used (against the **1 GB** KV free tier). The figures are refreshed hourly by the cron trigger. KV usage is an estimate based on stored email sizes, so treat it as a lower bound.

### External auth provider (Authelia / Authentik / reverse proxy)

Instead of the built-in password login you can delegate admin authentication to a reverse proxy that sets a trusted user header (`Remote-User` or `X-Forwarded-User`).

**Required Worker secrets** (set with `wrangler secret put`, never in `[vars]`):

| Secret              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `PROXY_AUTH_SECRET` | Shared secret between the proxy and the Worker |

**Required `[vars]`** in `wrangler.toml`:

```toml
PROXY_TRUSTED_IPS = "10.0.0.1"   # comma-separated IPs of your reverse proxy
```

When both are configured, the Worker authenticates a request if:

1. `CF-Connecting-IP` is in `PROXY_TRUSTED_IPS`
2. The `X-Auth-Proxy-Secret` header matches `PROXY_AUTH_SECRET`
3. `Remote-User` or `X-Forwarded-User` is non-empty

Password login remains available as a fallback when the proxy check fails.

> **Security note:** `CF-Connecting-IP` can be spoofed on direct `workers.dev` requests. Disable the `workers.dev` subdomain in production (`workers_dev = false` in `[env.production]`).

### REST API authentication

The versioned REST API (`/api/v1/*`) is authenticated independently of the cookie-based
admin UI — there is no CSRF check, so it is suited to server-to-server automation. A
request is authorized when **either**:

- it carries `Authorization: Bearer <ADMIN_PASSWORD>` (the same admin password secret), **or**
- it passes the reverse-proxy check above (`PROXY_TRUSTED_IPS` + `X-Auth-Proxy-Secret` + `Remote-User`).

The OpenAPI 3.1 spec (`/api/openapi.json`) and the Scalar reference (`/api/docs`) are
public. In the Scalar UI, click **Authorize** and paste the admin password as the bearer
token to try requests. See the route table in [README.md](README.md#rest-api).

## Upgrading dependencies

To refresh dependencies to latest:

```bash
npm outdated
npm install
npm test
npm run build
```

Then update `compatibility_date` and redeploy.
