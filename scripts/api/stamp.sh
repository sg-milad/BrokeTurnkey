#!/usr/bin/env bash

set -euo pipefail

API="http://127.0.0.1:3000"

PRIVATE_KEY="${PRIVATE_KEY:-./private.pem}"
KEY_ID="${KEY_ID:-}"


if [[ ! -f "$PRIVATE_KEY" ]]; then
  echo "ERROR: Private key not found: $PRIVATE_KEY"
  exit 1
fi

base64url() {
  base64 | tr '+/' '-_' | tr -d '='
}

sha256_base64url() {
  local file="$1"

  openssl dgst -sha256 -binary "$file" | base64url
}

make_stamp() {
  local body_file="$1"

  local timestamp
  local body_hash
  local payload
  local signature

  timestamp="$(date +%s%3N)"

  body_hash="$(sha256_base64url "$body_file")"

  payload="${timestamp}.${body_hash}"

  signature="$(
    printf '%s' "$payload" |
      openssl dgst -sha256 \
        -sign "$PRIVATE_KEY" |
      base64url
  )"

  printf '%s.%s.%s' "$signature" "$timestamp" "$KEY_ID"
}