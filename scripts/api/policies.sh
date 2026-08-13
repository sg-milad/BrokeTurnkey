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
# POST /policies
# ------------------------------------------------------------

create() {
  local json_file="${2:?Usage: $0 create <json_file>}"

  if [[ ! -f "$json_file" ]]; then
    echo "ERROR: JSON file not found: $json_file" >&2
    exit 1
  fi

  BODY_FILE="$(tmp_body)"
  cp "$json_file" "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/policies" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# GET /policies
# ------------------------------------------------------------

list() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/policies" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# DELETE /policies/:policyId
# ------------------------------------------------------------

delete() {
  local policy_id="${2:?Usage: $0 delete <policyId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X DELETE "$API/policies/$policy_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<'EOF'

Policies API

Usage:

  create   <json_file>
  list
  delete   <policyId>

Examples:

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./policies.sh create ./policy.json

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./policies.sh list

  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./policies.sh delete a3f5c9a8-7d4b-4f6e-9b2c-1e8d6a4f0c33

Example policy JSON files:

  # address_blocklist
  {
    "name": "Block drainer",
    "ruleType": "address_blocklist",
    "ruleConfig": { "addresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] }
  }

  # address_allowlist
  {
    "name": "Allowlist only",
    "ruleType": "address_allowlist",
    "ruleConfig": { "addresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] }
  }

  # spend_limit (max 1 ETH per tx)
  {
    "name": "1 ETH spend cap",
    "ruleType": "spend_limit",
    "ruleConfig": { "max_amount_wei": "1000000000000000000" }
  }

  # time_lock (business hours UTC)
  {
    "name": "Business hours only",
    "ruleType": "time_lock",
    "ruleConfig": { "start_time": "09:00", "end_time": "17:00" }
  }

EOF
}


case "$COMMAND" in
  create)       create "$@" ;;
  list)         list "$@" ;;
  delete)       delete "$@" ;;
  help|-h|--help) help ;;
  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac