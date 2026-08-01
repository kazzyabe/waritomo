# ワリトモ LINE Mini App

LINE mini app starter for splitting expenses with friends.

This project is intentionally designed as an original product. It must not copy
Walica's brand, source code, UI, wording, assets, or private implementation
details. The shared domain idea is only "split expenses among a group", which is
a common product category.

## Platform Decision

Build as a LINE mini app from day one.

- Create a LINE mini app channel in LINE Developers.
- Serve the web app from Cloud Run over HTTPS.
- Use the LINE mini app LIFF URL format: `https://miniapp.line.me/{liffId}`.
- Use permanent links for invite and settlement sharing.
- Keep review, policy, and mini app production settings in scope from the first
  implementation pass.

## MVP

- Create a trip expense group.
- Invite members through a LINE mini app permanent link.
- Let each LINE user claim one member profile in the group.
- Add expenses with equal split or per-member split.
- Calculate who should pay whom.
- Share invite and settlement summaries through LINE.
- Keep "my groups" tied to the LINE user.

## Suggested Stack

- Frontend: React + TypeScript SPA served as a LINE mini app with LIFF SDK.
- Backend: TypeScript API on Cloud Run.
- Database: Cloud SQL for PostgreSQL. Without `DATABASE_URL`, the current UI
  falls back to browser-only `localStorage` for local previews.
- Secrets: Secret Manager.
- Jobs: Cloud Run Jobs or Cloud Scheduler for currency-rate refreshes and DB maintenance.
- Observability: Cloud Logging and Error Reporting.

## Docs

- [Product spec](docs/product-spec.md)
- [IP boundary](docs/ip-boundary.md)
- [Architecture](docs/architecture.md)
- [Cloud Run deploy](docs/cloud-run-deploy.md)
- [Cheapest GCP operations](docs/cheap-ops.md)
- [LINE mini app notes](docs/line-mini-app.md)
- [LINE Developers setup](docs/line-developers-setup.md)
- [API design](docs/api.md)
- [Roadmap](docs/roadmap.md)
- [Database schema](db/schema.sql)

## Local Run

```sh
npm test
HOST=127.0.0.1 PORT=4312 npm run start
```

Apply the PostgreSQL schema after creating a database:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/waritomo npm run db:migrate
```

For local mini app configuration, copy `.env.example` values into your shell or
Cloud Run environment. `LINE_LIFF_ID` is optional for local browser development,
but required for LINE mini app testing.

Open:

```text
http://127.0.0.1:4312/
```

Health check:

```sh
curl -s http://127.0.0.1:4312/api/health
```

Settlement preview:

```sh
curl -s -X POST http://127.0.0.1:4312/api/settlement/preview \
  -H 'content-type: application/json' \
  -d '{"baseCurrencyCode":"JPY","roundingUnit":"1","members":[{"id":"a"},{"id":"b"},{"id":"c"}],"expenses":[{"payerMemberId":"a","splitMode":"equal","amount":"3000","debtors":[{"memberId":"a"},{"memberId":"b"},{"memberId":"c"}]}]}'
```

Permanent link preview:

```sh
curl -s 'http://127.0.0.1:4312/api/permanent-link?path=/groups/demo/invite'
```
