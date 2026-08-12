#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/stamp.sh"

COMMAND="${1:-help}"

ORG_ID="${ORG_ID:-}"
ORG_SLUG="${ORG_SLUG:-}"

tmp_body() {
  mktemp
}

cleanup() {
  rm -f "${BODY_FILE:-}" 2>/dev/null || true
}

trap cleanup EXIT


# ------------------------------------------------------------
# POST /organizations
# Public endpoint - NO X-Stamp required
# ------------------------------------------------------------

create() {
  local name="${2:-My Organization}"
  local slug="${3:-my-organization}"

  BODY_FILE="$(tmp_body)"

  cat > "$BODY_FILE" <<EOF
{"name":"$name","slug":"$slug"}
EOF

  echo "POST /organizations"
  echo "Body:"
  cat "$BODY_FILE"
  echo
  echo

  curl --fail-with-body \
    -sS \
    -X POST "$API/organizations" \
    -H 'Content-Type: application/json' \
    --data-binary "@$BODY_FILE"

  echo
}


# ------------------------------------------------------------
# GET /organizations
# Authenticated
# ------------------------------------------------------------

get() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations"

  curl --fail-with-body \
    -sS \
    "$API/organizations" \
    -H "X-Stamp: $stamp"

  echo
}


# ------------------------------------------------------------
# GET /organizations/slug/:slug
# Authenticated
# ------------------------------------------------------------

get_by_slug() {
  local slug="${2:-$ORG_SLUG}"

  if [[ -z "$slug" ]]; then
    echo "ERROR: slug is required"
    echo "Usage:"
    echo "  $0 get-by-slug <slug>"
    exit 1
  fi

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/slug/$slug"

  curl --fail-with-body \
    -sS \
    "$API/organizations/slug/$slug" \
    -H "X-Stamp: $stamp"

  echo
}


# ------------------------------------------------------------
# GET /organizations/wallets
# Authenticated
# ------------------------------------------------------------

wallets() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/wallets"

  curl --fail-with-body \
    -sS \
    "$API/organizations/wallets" \
    -H "X-Stamp: $stamp"

  echo
}


# ------------------------------------------------------------
# GET /organizations/signing-requests
# Authenticated
# ------------------------------------------------------------

signing_requests() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/signing-requests"

  curl --fail-with-body \
    -sS \
    "$API/organizations/signing-requests" \
    -H "X-Stamp: $stamp"

  echo
}


# ------------------------------------------------------------
# GET /organizations/audit-log
# Authenticated
# ------------------------------------------------------------

audit_log() {
  local query="${2:-}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  local url="$API/organizations/audit-log"

  if [[ -n "$query" ]]; then
    url="${url}?${query}"
  fi

  echo "GET $url"

  curl --fail-with-body \
    -sS \
    "$url" \
    -H "X-Stamp: $stamp"

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<EOF

Organizations API

Usage:

  $0 create [name] [slug]

  $0 get

  $0 get-by-slug <slug>

  $0 wallets

  $0 signing-requests

  $0 audit-log [query]

Examples:

  $0 create "My Organization" "my-org"

  KEY_ID=ak_prod_123 PRIVATE_KEY=./private.pem \
    $0 get

  KEY_ID=ak_prod_123 PRIVATE_KEY=./private.pem \
    $0 get-by-slug my-org

  KEY_ID=ak_prod_123 PRIVATE_KEY=./private.pem \
    $0 wallets

  KEY_ID=ak_prod_123 PRIVATE_KEY=./private.pem \
    $0 signing-requests

  KEY_ID=ak_prod_123 PRIVATE_KEY=./private.pem \
    $0 audit-log "event=wallet.created&limit=20&offset=0"

EOF
}


case "$COMMAND" in
  create)
    create "$@"
    ;;

  get)
    get "$@"
    ;;

  get-by-slug)
    get_by_slug "$@"
    ;;

  wallets)
    wallets "$@"
    ;;

  signing-requests)
    signing_requests "$@"
    ;;

  audit-log)
    audit_log "$@"
    ;;

  help|-h|--help)
    help
    ;;

  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac