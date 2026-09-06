# Architecture

## Target Architecture

```text
LINE app
  -> LINE mini app channel
    -> LIFF browser / external browser fallback
    -> Cloud Run service: web + API
      -> Cloud SQL PostgreSQL
      -> Secret Manager
      -> Cloud Logging / Error Reporting
      -> Cloud Run Job: migrations and scheduled maintenance
```

## Cloud Run Services

### MVP: Single Service

Use one Cloud Run service that serves both:

- static frontend assets
- `/api/*` JSON API

This keeps deployment simple and avoids CORS complexity during the first build.

### Later: Split Services

Split if traffic or team ownership grows:

- `web`: static/SSR frontend
- `api`: authenticated app API
- `jobs`: currency rate updates, cleanup, migrations

## Suggested Runtime

- Node.js 22
- TypeScript
- Hono or Fastify for API routing
- Drizzle or Prisma for PostgreSQL access
- Zod for request validation

## Database

Use Cloud SQL for PostgreSQL. Cloud Run instances are disposable, so no user data
should rely on local files. All durable state belongs in PostgreSQL or managed
Google Cloud services.

## Authentication

1. User opens a LINE mini app permanent link such as
   `https://miniapp.line.me/{liffId}/groups/{id}/invite`.
2. LINE opens the app endpoint URL in the LIFF browser.
3. Frontend initializes LIFF with the LINE mini app LIFF ID.
4. Frontend sends an ID token to `/api/auth/line`.
5. Backend verifies the token with LINE.
6. Backend creates or updates `line_users`.
7. Backend returns an app session cookie.

Prefer an HTTP-only secure cookie for browser API calls. Keep LINE access tokens
out of logs and avoid sending profile objects from frontend to backend.

## Authorization

- Public: limited invite preview by invite token.
- Authenticated: my groups, group joining.
- Group member: read group, add expenses, view settlement.
- Group owner: edit group settings, remove members.

MVP allows all claimed members to edit expenses. There is no audit trail; the
ledger is the shared record, and a changed amount moves a total the whole group
can see.

## Settlement Calculation

For each group:

1. Convert every debtor amount and payer credit into base currency using the
   expense's stored rate snapshot.
2. Compute member balances.
3. Match debtors to creditors with a two-pointer algorithm.
4. Apply rounding unit at the display/settlement layer.
5. Store confirmations separately from calculated suggestions.

## Environment Variables

- `APP_ENV`
- `PUBLIC_BASE_URL`
- `LINE_LIFF_ID`
- `LINE_MINIAPP_BASE_URL`
- `LINE_CHANNEL_ID`
- `LINE_CHANNEL_SECRET`
- `DATABASE_URL`
- `SESSION_SECRET`
- `CURRENCY_RATE_PROVIDER`

`SESSION_SECRET` is mandatory whenever `APP_ENV=production`, `NODE_ENV=production`
(which the Dockerfile always sets), or `DATABASE_URL` is present. The server
refuses to start without it rather than falling back to the shared development
secret, so a deployment that forgets it fails the revision instead of signing
forgeable sessions.

Secrets should come from Secret Manager in Cloud Run, not from committed files.

## Deployment

MVP deployment:

1. Build frontend.
2. Build API container.
3. Run DB migrations through Cloud Run Job.
4. Deploy Cloud Run service.
5. Configure the LINE mini app channel endpoint URL to the Cloud Run custom
   domain.
6. Verify permanent links open with `https://miniapp.line.me/{liffId}/...`.
7. Prepare LINE mini app review materials.

Use a custom domain before LINE review to keep links stable.

## LINE Mini App Channel Settings

Use a LINE mini app channel, not a generic LINE Login + LIFF channel.

- Endpoint URL: `PUBLIC_BASE_URL`, for example `https://app.example.com`.
- LIFF URL: `https://miniapp.line.me/{liffId}`.
- Scopes for MVP: `openid`, then add `profile` only if display name/picture is
  needed.
- Sharing: use permanent links, not raw endpoint URLs.
- Custom Path: optional later, only for a verified mini app.
