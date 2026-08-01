# Cheapest GCP Operations

Use this profile for MVP testing where low cost is more important than uptime.

## Settings

- Cloud Run: `min-instances=0`, `max-instances=1`, `concurrency=20`, `cpu=1`, `memory=512Mi`.
- Cloud SQL: PostgreSQL, `db-f1-micro`, zonal, 10GB HDD, backups disabled.
- Storage remains billable while Cloud SQL is stopped.
- Cloud Run scales to zero automatically; Cloud SQL is the resource to stop.

## Stop

```sh
scripts/gcp-db-stop.sh
```

This sets Cloud SQL activation policy to `NEVER` and keeps Cloud Run scale-to-zero.

## Start

```sh
scripts/gcp-db-start.sh
```

This sets Cloud SQL activation policy to `ALWAYS`.

## Status

```sh
scripts/gcp-cheap-status.sh
```

## Notes

When Cloud SQL is stopped, the app still opens, but shared database storage is
unavailable. The UI falls back to browser storage for previews.
