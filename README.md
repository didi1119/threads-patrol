# Threads Patrol · 森林巡帖

Mobile-first private workbench and read-only Threads feed scout, built for 靜謐森林.

This repository is a sanitized source snapshot of the existing project. It does **not** include the production database, credentials, browser login state, private reports, collected posts, media originals, or the unrelated website's Git history. Publishing this code does not make the running private workbench public.

## Current behavior

- Scout explores the logged-in recommended feed; up to 15 scrolls per pass and two refreshes, with bounded runtime and delivery batches.
- Collection-only mode accepts known like counts strictly greater than 1,000. Collection volume is not a measure of editorial usefulness.
- Daily browsing uses the Taipei collection date, today plus the previous six days, and selectable like thresholds.
- Delivered URLs are deduplicated. Human review, publication records and metrics are preserved separately from the temporary feed.
- Automatic reply drafting/recommendation is disabled in the current collection workflow. Legacy manual review/drafting code remains in the source.
- Publishing a reply is always a human action outside this application. The scout must stop for login expiration, challenges or rate limits; it is not designed to bypass them.
- LINE and GA integrations are not connected. Full image/video/comment understanding and creative opportunity selection are not implemented.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | React mobile workbench, Hono Worker and domain rules |
| `migrations/` | D1 schema migrations, no production data |
| `scout/src/` | Cloudflare Browser Run adapter, extraction, encrypted state, coordination and ingestion |
| `scout/fixtures/` | Synthetic HTML for extraction tests |

## Development

Use a recent Node.js release and npm. Install dependencies separately for the workbench and scout:

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

```sh
cd scout
npm ci
npm test
npm run typecheck
```

The Vite development server is the frontend only; authenticated API behavior requires a configured Worker/D1 environment. The workbench dependency manifest is preserved from the original project; there is no standalone workbench lockfile in this snapshot. The scout has its own lockfile.

## Deploying your own instance

Do not deploy the configuration unchanged. It is a source snapshot, not a one-click service.

1. Choose your own Worker names and create a D1 database. Replace the all-zero `database_id` in the root `wrangler.jsonc`.
2. Configure Browser Run and the scout Durable Object in your Cloudflare account. Check account limits and costs before enabling schedules.
3. Replace service bindings and the destination URL in `scout/wrangler.jsonc`. The original public host also appears in the workbench health request, scout ingestion allowlist and tests; update those together for a fork. These hostnames are not credentials.
4. Set secrets using `wrangler secret put`, never tracked files. Workbench: `PATROL_LOGIN_CODE`, `PATROL_SESSION_SECRET`, `PATROL_INGEST_SECRET`. Scout: `SCOUT_ADMIN_TOKEN`, `SCOUT_STATE_KEY_B64`, and `SCOUT_INGEST_TOKEN` (matching the workbench ingest secret). Generate independent strong secrets; the state key must match the encryption code's base64 key requirements.
5. Apply the D1 migrations to your own database, build the frontend, and deploy the two Workers. Initialize the dedicated scout account through the existing admin login workflow. Browser sessions and live-view links must remain private.
6. Keep `COLLECT_ONLY_HOT_POSTS=true`. Review UTC cron registration and the scout's internal schedule guard before enabling natural runs. The root hourly cron only maintains retention.

Cloudflare Access can additionally be configured through `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; configure and test your authentication boundary before production use. Do not expose the admin token or login/session material in screenshots, logs, issues or public configuration.

## Safety and limitations

Only inspect content you are authorized to access. Respect platform terms, privacy requirements and usage limits. Publicly visible posts are not automatically licensed for redistribution; this repository intentionally excludes collected media and posts. No guarantee is made of complete search coverage, stable platform markup, absence of account restrictions, or editorial suitability.

No open-source license is granted by this publication; a license can be selected by the owner separately.
