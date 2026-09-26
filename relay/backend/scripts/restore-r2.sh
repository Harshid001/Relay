#!/usr/bin/env bash
# Restore the latest (or a named) Mongo backup from Cloudflare R2.
#
#   ./scripts/restore-r2.sh                      # latest
#   ./scripts/restore-r2.sh mongo/relay-2026-09-22_030000.archive.gz
#
# WARNING: --drop replaces existing collections in the database.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/relay/.env.r2}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

: "${R2_ACCESS_KEY_ID:?missing R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?missing R2_SECRET_ACCESS_KEY}"
: "${R2_ENDPOINT:?missing R2_ENDPOINT}"
: "${R2_BUCKET:?missing R2_BUCKET}"

KEY="${1:-}"
if [ -z "$KEY" ]; then
  KEY="$(AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/mongo/" \
    | sort | tail -1 | awk '{print $4}')"
  [ -n "$KEY" ] || { echo "no backups found"; exit 1; }
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "restoring $KEY"
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "s3://$R2_BUCKET/$KEY" "$WORKDIR/dump.archive.gz"

docker compose -f /opt/relay/docker-compose.prod.yml exec -T mongo \
  mongorestore --archive --gzip --drop --db "${MONGODB_DB:-relay}" < "$WORKDIR/dump.archive.gz"

echo "restore complete (app container will pick data up immediately)"
