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
# GET /wallets/:id
# ------------------------------------------------------------

get() {
  local wallet_id="${2:?Usage: $0 get <walletId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/wallets/$wallet_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /wallets/:id/signing-requests
# ------------------------------------------------------------

list_signing_requests() {
  local wallet_id="${2:?Usage: $0 list-signing-requests <walletId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/wallets/$wallet_id/signing-requests" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /wallets/:id/signing-requests/:requestId
# ------------------------------------------------------------

get_signing_request() {
  local wallet_id="${2:?Usage: $0 get-signing-request <walletId> <requestId>}"
  local request_id="${3:?Usage: $0 get-signing-request <walletId> <requestId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/wallets/$wallet_id/signing-requests/$request_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# POST /wallets
# ------------------------------------------------------------

derive() {
  local label="${2:?Usage: $0 derive <label> [userId] [chainId]}"
  local user_id="${3:-}"
  local chain_id="${4:-}"

  BODY_FILE="$(tmp_body)"

  local body
  body="{\"label\":\"$label\""
  [[ -n "$user_id" ]]  && body="$body,\"userId\":\"$user_id\""
  [[ -n "$chain_id" ]] && body="$body,\"chainId\":$chain_id"
  body="$body}"

  printf '%s' "$body" > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/wallets" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# POST /wallets/:id/sign-transaction
# ------------------------------------------------------------

sign_transaction() {
  local wallet_id="${2:?Usage: $0 sign-transaction <walletId> <chainId> <to> <value> <data>}"
  local chain_id="${3:?Usage: $0 sign-transaction <walletId> <chainId> <to> <value> <data>}"
  local to="${4:?Usage: $0 sign-transaction <walletId> <chainId> <to> <value> <data>}"
  local value="${5:?Usage: $0 sign-transaction <walletId> <chainId> <to> <value> <data>}"
  local data="${6:-0x}"

  BODY_FILE="$(tmp_body)"
  cat > "$BODY_FILE" <<EOF
{"txFields":{"chainId":$chain_id,"to":"$to","value":"$value","data":"$data"}}
EOF

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/wallets/$wallet_id/sign-transaction" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# POST /wallets/:id/sign-typed
# ------------------------------------------------------------

sign_typed() {
  local wallet_id="${2:?Usage: $0 sign-typed <walletId> <json_file>}"
  local json_file="${3:?Usage: $0 sign-typed <walletId> <json_file>}"

  if [[ ! -f "$json_file" ]]; then
    echo "ERROR: JSON file not found: $json_file" >&2
    exit 1
  fi

  BODY_FILE="$(tmp_body)"
  cp "$json_file" "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/wallets/$wallet_id/sign-typed" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# POST /wallets/:id/sign-message
# ------------------------------------------------------------

sign_message() {
  local wallet_id="${2:?Usage: $0 sign-message <walletId> <message>}"
  local message="${3:?Usage: $0 sign-message <walletId> <message>}"

  BODY_FILE="$(tmp_body)"
  printf '{"message":"%s"}' "$message" > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/wallets/$wallet_id/sign-message" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<'EOF'

Wallets API

Usage:

  get                     <walletId>
  list-signing-requests   <walletId>
  get-signing-request     <walletId> <requestId>
  derive                  <label> [userId] [chainId]
  sign-transaction        <walletId> <chainId> <to> <value> [data]
  sign-typed              <walletId> <json_file>
  sign-message            <walletId> <message>

Examples:

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh get 660e8400-e29b-41d4-a716-446655440001

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh list-signing-requests 660e8400-e29b-41d4-a716-446655440001

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh get-signing-request 660e8400-e29b-41d4-a716-446655440001 7f795c23-5d01-4b56-a44e-ab665d6ed524

  # Derive a system wallet (no userId)
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh derive "Treasury"

  # Derive and assign to a user, on Base Sepolia
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh derive "Hot wallet" 660e8400-e29b-41d4-a716-446655440001 84532

  # Sign a transaction (data defaults to 0x)
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh sign-transaction \
      660e8400-e29b-41d4-a716-446655440001 \
      84532 \
      0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
      1000000000000000000

  # Sign a transaction with calldata
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh sign-transaction \
      660e8400-e29b-41d4-a716-446655440001 \
      84532 \
      0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
      0 \
      0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000de0b6b3a7640000

  # Sign EIP-712 typed data from a JSON file
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh sign-typed 660e8400-e29b-41d4-a716-446655440001 ./typed-data.json

  # Sign a personal message
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./wallets.sh sign-message 660e8400-e29b-41d4-a716-446655440001 "Hello, World!"

EOF
  cat <<'EOF'

Example typed-data.json:

  {
    "domain": {
      "name": "MyApp",
      "version": "1",
      "chainId": 84532,
      "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
    },
    "types": {
      "Mail": [
        { "name": "from", "type": "address" },
        { "name": "to",   "type": "address" },
        { "name": "contents", "type": "string" }
      ]
    },
    "primaryType": "Mail",
    "message": {
      "from": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "to":   "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "contents": "Hello!"
    }
  }

EOF
}


case "$COMMAND" in
  get)                    get "$@" ;;
  list-signing-requests)  list_signing_requests "$@" ;;
  get-signing-request)    get_signing_request "$@" ;;
  derive)                 derive "$@" ;;
  sign-transaction)       sign_transaction "$@" ;;
  sign-typed)             sign_typed "$@" ;;
  sign-message)           sign_message "$@" ;;
  help|-h|--help)         help ;;
  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac