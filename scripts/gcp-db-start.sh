#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${CLOUD_SQL_INSTANCE:-waritomo-db}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${CLOUD_RUN_SERVICE:-waritomo}"

gcloud sql instances patch "$INSTANCE" \
  --activation-policy=ALWAYS \
  --quiet

gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=20 \
  --cpu=1 \
  --memory=512Mi \
  --cpu-throttling

echo "Started Cloud SQL instance: $INSTANCE"
echo "Cloud Run remains scale-to-zero: $SERVICE"
