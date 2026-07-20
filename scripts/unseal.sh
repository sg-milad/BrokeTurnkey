#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Run vault operator init first."
  exit 1
fi

source "$ENV_FILE"

# echo "Waiting for Vault to be reachable..."
# until curl -sf http://localhost:8200/v1/sys/health > /dev/null 2>&1; do
#   sleep 1
# done

STATUS=$(curl -sf http://localhost:8200/v1/sys/seal-status | python3 -c "import sys,json; print(json.load(sys.stdin)['sealed'])")

if [ "$STATUS" = "False" ]; then
  echo "Vault is already unsealed."
  exit 0
fi

echo "Unsealing Vault..."
curl -sf -X PUT http://localhost:8200/v1/sys/unseal \
  -H "Content-Type: application/json" \
  -d "{\"key\": \"$VAULT_UNSEAL_KEY_1\"}" > /dev/null

curl -sf -X PUT http://localhost:8200/v1/sys/unseal \
  -H "Content-Type: application/json" \
  -d "{\"key\": \"$VAULT_UNSEAL_KEY_2\"}" > /dev/null

echo "Done. Vault should now be unsealed."
