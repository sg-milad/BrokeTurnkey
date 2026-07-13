#!/usr/bin/env bash
# scripts/build-signer.sh
# Compiles the Go signing binary to bin/signer.
# Run this on the host (requires Go installed), or use the Docker alternative below.
#
# Docker alternative (no Go installation needed):
#   docker compose run --rm signer-build
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$PROJECT_ROOT/bin/signer"

echo "Building Go signer binary..."
echo "  Source : $PROJECT_ROOT/cmd/signer"
echo "  Output : $OUTPUT"

mkdir -p "$PROJECT_ROOT/bin"

cd "$PROJECT_ROOT"

# CGO_ENABLED=0 produces a fully static binary — no libc dependency.
# This is important because the binary may be copied into a minimal
# container or run in an environment without shared libraries.
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build \
    -ldflags="-s -w" \
    -o "$OUTPUT" \
    ./cmd/signer

echo "Done: $OUTPUT"
ls -lh "$OUTPUT"