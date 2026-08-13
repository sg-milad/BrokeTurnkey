#!/usr/bin/env bash
# migrate.sh — runs pnpm db:push inside the running api container
# Run from the project root: bash scripts/migrate.sh
set -euo pipefail

API_CONTAINER="walletmvp-api"

log() { echo "[migrate] $*"; }
die() { echo "[migrate] ERROR: $*" >&2; exit 1; }

# Confirm the api container is running
docker inspect --format='{{.State.Running}}' "$API_CONTAINER" 2>/dev/null | grep -q true \
  || die "Container '$API_CONTAINER' is not running. Start it first: docker compose up -d"

log "Running db:push inside $API_CONTAINER..."
docker exec "$API_CONTAINER" pnpm db:push

log "Migration complete."