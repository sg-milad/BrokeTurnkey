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
# POST /users
# ------------------------------------------------------------

create() {
  local external_id="${2:?Usage: $0 create <externalId> [email] [role]}"
  local email="${3:-}"
  local role="${4:-}"

  BODY_FILE="$(tmp_body)"

  local body
  body="{\"externalId\":\"$external_id\""
  [[ -n "$email" ]] && body="$body,\"email\":\"$email\""
  [[ -n "$role" ]]  && body="$body,\"role\":\"$role\""
  body="$body}"

  printf '%s' "$body" > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X POST "$API/users" \
    -H 'Content-Type: application/json' \
    -H "X-Stamp: $stamp" \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# GET /users
# ------------------------------------------------------------

list() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/users" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /users/:userId
# ------------------------------------------------------------

get() {
  local user_id="${2:?Usage: $0 get <userId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    "$API/users/$user_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# DELETE /users/:userId
# ------------------------------------------------------------

delete() {
  local user_id="${2:?Usage: $0 delete <userId>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  curl --fail-with-body -sS \
    -X DELETE "$API/users/$user_id" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<'EOF'

Users API

Usage:

  create   <externalId> [email] [role]
  list
  get      <userId>
  delete   <userId>

Examples:

  # Create a user (externalId only)
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./users.sh create "customer-123"

  # Create with email and role
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./users.sh create "customer-123" "customer@example.com" "member"

  # List all users
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./users.sh list

  # Get a user by ID
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./users.sh get 660e8400-e29b-41d4-a716-446655440001

  # Delete a user
  KEY_ID=... PRIVATE_KEY=./private.pem \
    ./users.sh delete 660e8400-e29b-41d4-a716-446655440001

EOF
}


case "$COMMAND" in
  create)         create "$@" ;;
  list)           list "$@" ;;
  get)            get "$@" ;;
  delete)         delete "$@" ;;
  help|-h|--help) help ;;
  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac