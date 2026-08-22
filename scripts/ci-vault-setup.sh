#!/usr/bin/env bash
# ci-vault-setup.sh — provisions a THROWAWAY Vault for CI and prints the
# three environment variables the Go tests need:
#
#   VAULT_ADDR
#   VAULT_ROLE_ID
#   VAULT_SECRET_ID
#
# Usage (CI):  bash scripts/ci-vault-setup.sh > /tmp/vault-env
#
# Handles two Vault states:
#   1. Dev mode (hashicorp/vault image default: initialized + unsealed,
#      root token "root") — skips init/unseal.
#   2. Sealed/empty Vault — inits with a single Shamir share and unseals.
#
# Everything here is ephemeral and disposable — this is CI-only tooling.
# Never use single-share init anywhere near production.
set -euo pipefail

export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_BIN="${VAULT_BIN:-vault}"
DEV_ROOT_TOKEN="${VAULT_DEV_ROOT_TOKEN_ID:-root}"

# ---------------------------------------------------------------------------
# Wait for the Vault HTTP API to be reachable (any HTTP status counts — a
# fresh dev-mode or sealed Vault returns 501/503, connection refused is 000).
# ---------------------------------------------------------------------------
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$VAULT_ADDR/v1/sys/health" || true)"
  if [ "$code" != "000" ]; then
    break
  fi
  sleep 1
done
if [ "$code" = "000" ]; then
  echo "[ci-vault-setup] Vault not reachable at $VAULT_ADDR" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine state: 200 = initialized + unsealed (dev mode). 501/503 = needs
# init and/or unseal.
# ---------------------------------------------------------------------------
if [ "$code" = "200" ]; then
  echo "[ci-vault-setup] Vault already initialized + unsealed (dev mode); using root token" >&2
  export VAULT_TOKEN="$DEV_ROOT_TOKEN"
else
  echo "[ci-vault-setup] Initializing Vault with a single Shamir share (CI only)" >&2
  INIT_OUT="$("$VAULT_BIN" operator init -key-shares=1 -key-threshold=1 -format=json)"
  UNSEAL_KEY="$(printf '%s' "$INIT_OUT" | jq -r '.unseal_keys_b64[0]')"
  ROOT_TOKEN="$(printf '%s' "$INIT_OUT" | jq -r '.root_token')"
  export VAULT_TOKEN="$ROOT_TOKEN"

  "$VAULT_BIN" operator unseal "$UNSEAL_KEY" >/dev/null
fi

# ---------------------------------------------------------------------------
# Shared setup: transit engine, wallet-dek key ring, wallet-signer AppRole.
# Mirrors docs/VAULT_INIT.md Steps 5-7 (minimal policy — tests only need
# transit encrypt/decrypt on the one key).
# ---------------------------------------------------------------------------
"$VAULT_BIN" secrets enable transit

"$VAULT_BIN" write -f transit/keys/wallet-dek type=aes256-gcm96

POLICY_FILE="$(mktemp)"
cat > "$POLICY_FILE" <<'EOF'
path "transit/encrypt/wallet-dek" {
  capabilities = ["update"]
}
path "transit/decrypt/wallet-dek" {
  capabilities = ["update"]
}
EOF
"$VAULT_BIN" policy write wallet-signer "$POLICY_FILE"
rm -f "$POLICY_FILE"

"$VAULT_BIN" auth enable approle
"$VAULT_BIN" write auth/approle/role/wallet-signer \
  token_policies="wallet-signer" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=720h \
  secret_id_num_uses=0

ROLE_ID="$("$VAULT_BIN" read -format=json auth/approle/role/wallet-signer/role-id | jq -r '.data.role_id')"
SECRET_ID="$("$VAULT_BIN" write -f -format=json auth/approle/role/wallet-signer/secret-id | jq -r '.data.secret_id')"

# Print the env vars for the caller to export (never print the token).
echo "VAULT_ADDR=$VAULT_ADDR"
echo "VAULT_ROLE_ID=$ROLE_ID"
echo "VAULT_SECRET_ID=$SECRET_ID"

echo "[ci-vault-setup] done" >&2
