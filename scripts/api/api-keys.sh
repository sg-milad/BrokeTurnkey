#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/stamp.sh"

COMMAND="${1:-help}"

tmp_body() { mktemp; }

cleanup() { rm -f "${BODY_FILE:-}" 2>/dev/null || true; }
trap cleanup EXIT

pretty() {
  if command -v jq &>/dev/null; then
    jq .
  else
    cat
  fi
}


# ------------------------------------------------------------
# POST /api-keys
# Bootstrap path:  BOOTSTRAP_TOKEN=xxx  (no KEY_ID needed)
# Stamp path:      KEY_ID=xxx           (key:write scope required)
# ------------------------------------------------------------

register() {
  local name="${2:?Usage: $0 register <name> <public_key_file> [scopes]}"
  local pubkey_file="${3:?Usage: $0 register <name> <public_key_file> [scopes]}"
  local scopes_arg="${4:-}"

  if [[ ! -f "$pubkey_file" ]]; then
    echo "ERROR: Public key file not found: $pubkey_file" >&2
    exit 1
  fi

  local pubkey
  pubkey="$(awk '{printf "%s\\n", $0}' "$pubkey_file")"

  local scopes_json='"*"'
  if [[ -n "$scopes_arg" ]]; then
    scopes_json="$(printf '%s' "$scopes_arg" | tr ',' '\n' | jq -R . | jq -s .)"
  fi

  BODY_FILE="$(tmp_body)"
  cat > "$BODY_FILE" <<EOF
{"name":"$name","publicKey":"$pubkey","scopes":[$scopes_json]}
EOF

  echo "POST /api-keys"
  echo "Body:"
  cat "$BODY_FILE"
  echo
  echo

  # Bootstrap path: no KEY_ID, use X-Bootstrap-Token header
  if [[ -n "${BOOTSTRAP_TOKEN:-}" ]]; then
    curl --fail-with-body -sS \
      -X POST "$API/api-keys" \
      -H 'Content-Type: application/json' \
      -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" \
      --data-binary "@$BODY_FILE" | pretty
  else
    # Stamp path: KEY_ID must be set, key must have key:write scope
    local stamp
    stamp="$(make_stamp "$BODY_FILE")"

    curl --fail-with-body -sS \
      -X POST "$API/api-keys" \
      -H 'Content-Type: application/json' \
      -H "X-Stamp: $stamp" \
      --data-binary "@$BODY_FILE" | pretty
  fi

  echo
}


# ------------------------------------------------------------
# GET /api-keys
# ------------------------------------------------------------

list() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /api-keys"
  echo

  curl --fail-with-body -sS \
    "$API/api-keys" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# DELETE /api-keys/:keyId
# ------------------------------------------------------------

revoke() {
  local key_id="${2:?Usage: $0 revoke <keyId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "DELETE /api-keys/$key_id"
  echo

  curl --fail-with-body -sS \
    -X DELETE "$API/api-keys/$key_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<'EOF'

API Keys

Usage:

  register  <name> <public_key_file> [scopes]
  list
  revoke    <keyId>

Examples:

  # First key — bootstrap token (returned by POST /organizations)
  BOOTSTRAP_TOKEN=abc123 \
    ./api-keys.sh register "prod-signer" ./public.pem

  # First key with narrow scopes
  BOOTSTRAP_TOKEN=abc123 \
    ./api-keys.sh register "read-only" ./public.pem "wallet:read,wallet:sign"

  # Additional key — stamp auth (existing key must have key:write scope)
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./api-keys.sh register "ci-key" ./ci-public.pem "wallet:sign"

  # List all active keys
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./api-keys.sh list

  # Revoke a key
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./api-keys.sh revoke a3f5c9a8-7d4b-4f6e-9b2c-1e8d6a4f0c33

EOF
}


case "$COMMAND" in
  register)  register "$@" ;;
  list)      list "$@" ;;
  revoke)    revoke "$@" ;;
  help|-h|--help) help ;;
  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac