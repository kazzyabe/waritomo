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

When Cloud SQL is stopped, the app still opens, but group data is unavailable.
The UI does not fall back to browser storage.

## Backups: Off By Decision, Not By Default

As of 2026-09-06, `waritomo-db` has automated backups disabled and zero
backups exist (`gcloud sql backups list` returns nothing). This is a decision,
not an oversight: the product only has internal test users, so there is
nothing yet worth protecting against loss, and the setting was left alone to
avoid touching it before this was confirmed.

**Revisit before opening the product to real users.** At that point, turn
backups on:

```sh
gcloud sql instances patch waritomo-db --backup-start-time=00:00
```

The retention policy is already configured (7 backups by count), so this one
flag is enough — no PITR. PITR was considered and rejected: it keeps
transaction logs continuously, which fights the stop/start cost profile this
doc describes (`scripts/gcp-db-stop.sh` stops the instance; no backups or logs
are taken while it's stopped).

Cost impact if enabled, measured 2026-09-06: backup storage in Tokyo is
¥16.575/GiB-month (Cloud Billing Catalog, `Cloud SQL: Backups in Japan`,
asia-northeast1), and the instance's actual disk usage is 71.4 MiB (Cloud
Monitoring, `cloudsql.googleapis.com/database/disk/bytes_used`). That puts
enabling backups at roughly ¥1–8/month — even a worst case of 7 full 10GB
backups would be ¥1,161/month, but backups are incremental, so the real cost
tracks actual data size. Either way it is small next to the ¥1,629/month the
Zonal Micro instance itself costs running 24/7 (`activationPolicy: ALWAYS`,
¥2.23125/hour). If cost is the reason backups are off, it shouldn't be —
uptime and stop/start scheduling are the real levers in this profile.
