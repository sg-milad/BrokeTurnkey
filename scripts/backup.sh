#!/usr/bin/env bash
# backup.sh — backs up Vault data volume, Postgres data volume, and .env
# Run from the project root: bash scripts/backup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
BACKUP_DIR="$PROJECT_ROOT/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/$TIMESTAMP"

# --- Docker volume names (must match docker-compose.yml) ---
VAULT_VOLUME="walletmvp_vault-data"
POSTGRES_VOLUME="walletmvp_postgres-data"

# ----------------------------------------------------------------

log()  { echo "[backup] $*"; }
die()  { echo "[backup] ERROR: $*" >&2; exit 1; }

# ----------------------------------------------------------------

[ -f "$ENV_FILE" ] || die ".env not found at $PROJECT_ROOT/.env"

source "$ENV_FILE"

[ -n "${VAULT_UNSEAL_KEY_1:-}" ] || die "VAULT_UNSEAL_KEY_1 not set in .env — refusing to back up without unseal keys present"
[ -n "${VAULT_UNSEAL_KEY_2:-}" ] || die "VAULT_UNSEAL_KEY_2 not set in .env"

mkdir -p "$BACKUP_PATH"

# ----------------------------------------------------------------
# 1. Back up .env (contains unseal keys — critical)
# ----------------------------------------------------------------
log "Backing up .env..."
cp "$ENV_FILE" "$BACKUP_PATH/env.bak"
chmod 600 "$BACKUP_PATH/env.bak"

# ----------------------------------------------------------------
# 2. Back up Vault data volume
# ----------------------------------------------------------------
log "Backing up Vault data volume ($VAULT_VOLUME)..."
docker run --rm \
  -v "${VAULT_VOLUME}:/vault-file:ro" \
  -v "$BACKUP_PATH:/backup" \
  alpine \
  tar czf /backup/vault-data.tar.gz -C /vault-file .
log "  → vault-data.tar.gz"

# ----------------------------------------------------------------
# 3. Back up Postgres data volume
# ----------------------------------------------------------------
log "Backing up Postgres data volume ($POSTGRES_VOLUME)..."
docker run --rm \
  -v "${POSTGRES_VOLUME}:/pg-data:ro" \
  -v "$BACKUP_PATH:/backup" \
  alpine \
  tar czf /backup/postgres-data.tar.gz -C /pg-data .
log "  → postgres-data.tar.gz"

# ----------------------------------------------------------------
# 4. Write a manifest
# ----------------------------------------------------------------
cat > "$BACKUP_PATH/MANIFEST.txt" <<EOF
WalletMVP Backup
Created:  $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Hostname: $(hostname)

Contents:
  env.bak              — .env file (contains unseal keys — keep this secure)
  vault-data.tar.gz    — Vault data volume ($VAULT_VOLUME)
  postgres-data.tar.gz — Postgres data volume ($POSTGRES_VOLUME)

Restore:
  bash scripts/restore.sh backups/$TIMESTAMP
EOF

# ----------------------------------------------------------------
# 5. Restrict permissions on the whole backup directory
# ----------------------------------------------------------------
chmod 700 "$BACKUP_PATH"

log ""
log "Backup complete: $BACKUP_PATH"
log ""
log "  IMPORTANT: This directory contains your Vault unseal keys."
log "  Store it in a secure location (encrypted drive, password manager, etc)."
log "  Without both the volume AND the unseal keys, recovery is impossible."