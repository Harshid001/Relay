#!/usr/bin/env bash
# Nightly MongoDB backup to Cloudflare R2.
#
#   0 3 * * *  /opt/relay/scripts/backup-r2.sh >> /var/log/relay-backup.log 2>&1
#
# Requires the aws CLI (S3-compatible, works with R2) and these variables,
# e.g. in /opt/relay/.env.r2 (chmod 600):
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  (R2 > Manage API tokens)
#   R2_ENDPOINT   https://<accountid>.r2.cloudflarestorage.com
#   R2_BUCKET     relay-backups
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/relay/.env.r2}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

: "${R2_ACCESS_KEY_ID:?missing R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?missing R2_SECRET_ACCESS_KEY}"
: "${R2_ENDPOINT:?missing R2_ENDPOINT}"
: "${R2_BUCKET:?missing R2_BUCKET}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "[$(date -Is)] dumping mongo -> $WORKDIR"
docker compose -f /opt/relay/docker-compose.prod.yml exec -T mongo \
  mongodump --archive --gzip --db "${MONGODB_DB:-relay}" > "$WORKDIR/dump.archive.gz"

# Local retention: keep 7 days of dumps on the VM.
find /opt/relay/backups -name 'relay-*.archive.gz' -mtime +7 -delete 2>/dev/null || true
mkdir -p /opt/relay/backups
cp "$WORKDIR/dump.archive.gz" "/opt/relay/backups/relay-$STAMP.archive.gz"

echo "[$(date -Is)] uploading to R2"
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
aws --endpoint-url "$R2_ENDPOINT" \
  s3 cp "/opt/relay/backups/relay-$STAMP.archive.gz" \
  "s3://$R2_BUCKET/mongo/relay-$STAMP.archive.gz" \
  --storage-class STANDARD

# R2 lifecycle rule (recommended, set once in the dashboard):
#   prefix mongo/ -> expire after 30 days
echo "[$(date -Is)] done: mongo/relay-$STAMP.archive.gz"
