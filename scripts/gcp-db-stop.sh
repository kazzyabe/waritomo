#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${CLOUD_SQL_INSTANCE:-waritomo-db}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${CLOUD_RUN_SERVICE:-waritomo}"

gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=20 \
  --cpu=1 \
  --memory=512Mi \
  --cpu-throttling

gcloud sql instances patch "$INSTANCE" \
  --activation-policy=NEVER \
  --quiet

echo "Stopped Cloud SQL instance: $INSTANCE"
echo "Cloud Run is configured for scale-to-zero: $SERVICE"
