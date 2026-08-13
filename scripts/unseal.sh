#!/usr/bin/env bash
# unseal.sh — unseals Vault via docker exec (no host port required)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"
VAULT_CONTAINER="walletmvp-vault"
MAX_WAIT=60  # seconds

log() { echo "[unseal] $*"; }
die() { echo "[unseal] ERROR: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die ".env not found — run vault operator init first"
source "$ENV_FILE"

[ -n "${VAULT_UNSEAL_KEY_1:-}" ] || die "VAULT_UNSEAL_KEY_1 not set in .env"
[ -n "${VAULT_UNSEAL_KEY_2:-}" ] || die "VAULT_UNSEAL_KEY_2 not set in .env"

# vault status exits 0 (unsealed), 1 (error/unreachable), or 2 (sealed).
# Exit code 2 means Vault is up but sealed — that's "ready" for our purposes.
vault_ready() {
  local exit_code
  docker exec "$VAULT_CONTAINER" \
    sh -c 'VAULT_ADDR=http://127.0.0.1:8200 vault status' > /dev/null 2>&1
  exit_code=$?
  # 0 = unsealed, 2 = sealed — both mean Vault is responding
  [ "$exit_code" -eq 0 ] || [ "$exit_code" -eq 2 ]
}

log "Waiting for Vault to be ready (up to ${MAX_WAIT}s)..."
elapsed=0
until vault_ready; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    die "Vault did not become ready after ${MAX_WAIT}s — check: docker logs $VAULT_CONTAINER"
  fi
done

# Check if already unsealed
SEALED=$(docker exec "$VAULT_CONTAINER" \
  sh -c 'VAULT_ADDR=http://127.0.0.1:8200 vault status -format=json 2>/dev/null || true' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sealed'])")

if [ "$SEALED" = "False" ]; then
  log "Vault is already unsealed."
  exit 0
fi

log "Unsealing Vault..."

docker exec "$VAULT_CONTAINER" \
  sh -c "VAULT_ADDR=http://127.0.0.1:8200 vault operator unseal '$VAULT_UNSEAL_KEY_1'" > /dev/null

docker exec "$VAULT_CONTAINER" \
  sh -c "VAULT_ADDR=http://127.0.0.1:8200 vault operator unseal '$VAULT_UNSEAL_KEY_2'" > /dev/null

SEALED_AFTER=$(docker exec "$VAULT_CONTAINER" \
  sh -c 'VAULT_ADDR=http://127.0.0.1:8200 vault status -format=json 2>/dev/null || true' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sealed'])")

if [ "$SEALED_AFTER" = "False" ]; then
  log "Vault is unsealed."
else
  die "Vault is still sealed after submitting both keys — check keys in .env"
fi