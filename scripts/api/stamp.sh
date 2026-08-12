#!/usr/bin/env bash

API="${API:-http://127.0.0.1:3000}"
PRIVATE_KEY="${PRIVATE_KEY:-./private.pem}"
KEY_ID="${KEY_ID:-}"

if [[ ! -f "$PRIVATE_KEY" ]]; then
  echo "ERROR: Private key not found: $PRIVATE_KEY" >&2
  exit 1
fi

base64url() {
  base64 | tr '+/' '-_' | tr -d '=' | tr -d '\n'
}

sha256_base64url() {
  openssl dgst -sha256 -binary "$1" | base64url
}

make_stamp() {
  local body_file="$1"

  if [[ -z "${KEY_ID:-}" ]]; then
    echo "ERROR: KEY_ID is not set" >&2
    exit 1
  fi

  local timestamp body_hash payload signature

  timestamp="$(date +%s%3N)"
  body_hash="$(sha256_base64url "$body_file")"
  payload="${timestamp}.${body_hash}"

  signature="$(
    printf '%s' "$payload" |
      openssl dgst -sha256 -sign "$PRIVATE_KEY" |
      base64url
  )"

  printf '%s.%s.%s' "$signature" "$timestamp" "$KEY_ID"
}