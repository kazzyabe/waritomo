# Cloud Run Deploy

This is the first deploy path for LINE mini app verification.

## Prerequisites

- Google Cloud project.
- Artifact Registry repository.
- Cloud Run API enabled.
- Cloud SQL PostgreSQL instance for durable groups, members, and expenses.
- LINE mini app channel created in LINE Developers.

## Build And Deploy

From this directory:

```sh
gcloud run deploy waritomo \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars APP_ENV=production \
  --set-env-vars PUBLIC_BASE_URL=https://YOUR_DOMAIN \
  --set-env-vars LINE_LIFF_ID=YOUR_LIFF_ID \
  --set-env-vars LINE_MINIAPP_BASE_URL=https://miniapp.line.me/YOUR_LIFF_ID \
  --set-env-vars LINE_CHANNEL_ID=YOUR_CHANNEL_ID \
  --set-env-vars GA_MEASUREMENT_ID=G-XXXXXXXXXX \
  --set-env-vars CLOUD_SQL_CONNECTION_NAME=PROJECT_ID:asia-northeast1:INSTANCE_NAME \
  --set-secrets DATABASE_URL=DATABASE_URL:latest \
  --set-secrets LINE_CHANNEL_SECRET=LINE_CHANNEL_SECRET:latest \
  --set-secrets SESSION_SECRET=SESSION_SECRET:latest
```

If `DATABASE_URL` is omitted, group data cannot be displayed or edited.
Set `DATABASE_URL` and run the schema migration before using the mini app.
Run the migration again after schema changes such as group completion fields.

## Database Migration

For local or Cloud SQL Auth Proxy access:

```sh
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/waritomo npm run db:migrate
```

For Cloud Run Unix socket access, set:

```text
CLOUD_SQL_CONNECTION_NAME=PROJECT_ID:asia-northeast1:INSTANCE_NAME
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/waritomo
```

## Smoke Checks

```sh
curl -s https://YOUR_DOMAIN/api/health
curl -s https://YOUR_DOMAIN/api/config
curl -s https://YOUR_DOMAIN/api/me
curl -s 'https://YOUR_DOMAIN/api/permanent-link?path=/groups/demo/invite'
```

The permanent link should be:

```text
https://miniapp.line.me/YOUR_LIFF_ID/groups/demo/invite
```

## LINE Developers

Set the LINE mini app endpoint URL to:

```text
https://YOUR_DOMAIN
```

Then open:

```text
https://miniapp.line.me/YOUR_LIFF_ID
```

## Current Auth Flow

1. Frontend calls `liff.init()`.
2. Frontend calls `liff.getIDToken()`.
3. Frontend sends the ID token to `/api/auth/line`.
4. API verifies it using LINE Login v2.1 ID token verification.
5. API creates an HTTP-only app session cookie.
6. Frontend checks `/api/me`.

## Storage Behavior

- With `DATABASE_URL`: LINE-authenticated users use Cloud SQL.
- Without `DATABASE_URL` or when Cloud SQL is unavailable: group data is not
  displayed or editable.

## Cheapest Operation

For the lowest-cost MVP profile, see [Cheapest GCP Operations](cheap-ops.md).

## gcloud Account Split

The `walica-next` project (see [Cheapest GCP Operations](cheap-ops.md) for the
instance name) grants Cloud Run and Cloud SQL access to different accounts:

- Cloud Run deploy and describe: `ogawa@thiasos.jp`.
- Cloud SQL (`gcloud sql instances describe/patch`, `gcloud sql backups list`,
  `gcloud services list`): `ryoto.ogawa@plusinsight.co.jp`. The Cloud Run
  account gets `does not have permission to access projects instance
  [walica-next]` on every `gcloud sql` and `gcloud services` call.

`scripts/gcp-db-stop.sh`, `gcp-db-start.sh`, and `gcp-cheap-status.sh` all call
`gcloud sql`, so run them with the Cloud SQL account:

```sh
gcloud sql instances describe waritomo-db --project walica-next \
  --account ryoto.ogawa@plusinsight.co.jp \
  --format='yaml(settings.backupConfiguration,settings.activationPolicy)'
```

or set it as the active account for the session with
`gcloud config set account ryoto.ogawa@plusinsight.co.jp` first.
