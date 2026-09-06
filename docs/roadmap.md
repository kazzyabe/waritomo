# Roadmap

## Phase 0: Product Freeze

- Pick final product name.
- Finalize visual direction independent from Walica.
- Create the LINE mini app channel.
- Confirm LINE Developers provider/channel ownership.
- Confirm custom domain.
- Set endpoint URL and LIFF URL environment variables.

## Phase 1: MVP Backend

- Cloud SQL schema and migrations.
- Cloud Run API service.
- LINE token verification.
- App session cookie.
- Groups, members, expenses, settlement endpoints.

## Phase 2: MVP Frontend

- LIFF initialization wrapper.
- Home / my groups.
- Create group.
- Invite and join flow.
- Expense CRUD.
- Settlement view.
- LINE share target picker with copy fallback.

## Phase 3: Production Hardening

- Error states and retry behavior.
- Rate limiting on auth and invite endpoints.
- Cloud Logging structured logs.
- E2E smoke test in LINE mini app playground.
- Privacy policy and terms pages.
- Review test scenario.

## Phase 4: Useful Differentiators

- Settlement confirmation workflow.
- Trip timeline view.
- Expense templates.
- Receipt image attachment.
- CSV export.
- Change history for expense edits.
- Currency rate snapshots.

## Phase 5: Optional Platform Features

- Service messages for policy-safe confirmations.
- LINE Official Account integration.
- Ads only after LINE mini app ad requirements are cleared.
