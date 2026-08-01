#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${CLOUD_SQL_INSTANCE:-waritomo-db}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${CLOUD_RUN_SERVICE:-waritomo}"

echo "Cloud Run:"
gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format="yaml(status.url,spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources)"

echo
echo "Cloud SQL:"
gcloud sql instances describe "$INSTANCE" \
  --format="table(name,state,settings.activationPolicy,settings.tier,settings.dataDiskType,settings.dataDiskSizeGb,settings.backupConfiguration.enabled)"
