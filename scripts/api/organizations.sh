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
# POST /organizations
# Public — no X-Stamp required
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

  curl --fail-with-body -sS \
    -X POST "$API/organizations" \
    -H 'Content-Type: application/json' \
    --data-binary "@$BODY_FILE" | pretty

  echo
}


# ------------------------------------------------------------
# GET /organizations
# ------------------------------------------------------------

get() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations"
  echo

  curl --fail-with-body -sS \
    "$API/organizations" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /organizations/slug/:slug
# ------------------------------------------------------------

get_by_slug() {
  local slug="${2:?Usage: $0 get-by-slug <slug>}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/slug/$slug"
  echo

  curl --fail-with-body -sS \
    "$API/organizations/slug/$slug" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /organizations/wallets
# ------------------------------------------------------------

wallets() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/wallets"
  echo

  curl --fail-with-body -sS \
    "$API/organizations/wallets" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /organizations/signing-requests
# ------------------------------------------------------------

signing_requests() {
  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  echo "GET /organizations/signing-requests"
  echo

  curl --fail-with-body -sS \
    "$API/organizations/signing-requests" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# GET /organizations/audit-log
# ------------------------------------------------------------

audit_log() {
  local query="${2:-}"

  BODY_FILE="$(tmp_body)"
  : > "$BODY_FILE"

  local stamp
  stamp="$(make_stamp "$BODY_FILE")"

  local url="$API/organizations/audit-log"
  [[ -n "$query" ]] && url="${url}?${query}"

  echo "GET $url"
  echo

  curl --fail-with-body -sS \
    "$url" \
    -H "X-Stamp: $stamp" | pretty

  echo
}


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------

help() {
  cat <<'EOF'

Organizations API

Usage:

  create          [name] [slug]
  get
  get-by-slug     <slug>
  wallets
  signing-requests
  audit-log       [query]

Examples:

  # Create an org (public — no auth needed)
  ./organizations.sh create "Acme Corp" "acme"

  # Get org details
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./organizations.sh get

  # Look up by slug
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./organizations.sh get-by-slug acme

  # List wallets
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./organizations.sh wallets

  # Signing history
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./organizations.sh signing-requests

  # Audit log with filters
  KEY_ID=ak_prod_abc123 PRIVATE_KEY=./private.pem \
    ./organizations.sh audit-log "event=wallet.created&limit=20&offset=0"

EOF
}


case "$COMMAND" in
  create)           create "$@" ;;
  get)              get "$@" ;;
  get-by-slug)      get_by_slug "$@" ;;
  wallets)          wallets "$@" ;;
  signing-requests) signing_requests "$@" ;;
  audit-log)        audit_log "$@" ;;
  help|-h|--help)   help ;;
  *)
    echo "Unknown command: $COMMAND"
    help
    exit 1
    ;;
esac