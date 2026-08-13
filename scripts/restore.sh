#!/usr/bin/env bash
# restore.sh — restores Vault + Postgres from a backup directory
# Usage: bash scripts/restore.sh backups/<timestamp>
# Run from the project root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_PATH="${1:-}"
VAULT_VOLUME="walletmvp_vault-data"
POSTGRES_VOLUME="walletmvp_postgres-data"

# ----------------------------------------------------------------

log()  { echo "[restore] $*"; }
die()  { echo "[restore] ERROR: $*" >&2; exit 1; }

confirm() {
  read -r -p "[restore] $* [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
}

# ----------------------------------------------------------------

[ -n "$BACKUP_PATH" ] || die "Usage: bash scripts/restore.sh backups/<timestamp>"
[ -d "$BACKUP_PATH" ] || die "Backup directory not found: $BACKUP_PATH"
[ -f "$BACKUP_PATH/vault-data.tar.gz" ]    || die "vault-data.tar.gz missing from backup"
[ -f "$BACKUP_PATH/postgres-data.tar.gz" ] || die "postgres-data.tar.gz missing from backup"
[ -f "$BACKUP_PATH/env.bak" ]              || die "env.bak missing from backup"

log "Backup found: $BACKUP_PATH"
cat "$BACKUP_PATH/MANIFEST.txt" 2>/dev/null || true
echo ""

confirm "This will STOP all containers and OVERWRITE current Vault + Postgres data. Continue?"

# ----------------------------------------------------------------
# 1. Stop all containers
# ----------------------------------------------------------------
log "Stopping containers..."
cd "$PROJECT_ROOT"
docker compose down 2>/dev/null || true

# ----------------------------------------------------------------
# 2. Restore .env
# ----------------------------------------------------------------
if [ -f "$PROJECT_ROOT/.env" ]; then
  log "Backing up current .env to .env.before-restore..."
  cp "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.before-restore"
fi
log "Restoring .env..."
cp "$BACKUP_PATH/env.bak" "$PROJECT_ROOT/.env"
chmod 600 "$PROJECT_ROOT/.env"

# ----------------------------------------------------------------
# 3. Restore Vault volume
# ----------------------------------------------------------------
log "Restoring Vault data volume ($VAULT_VOLUME)..."

# Ensure volume exists
docker volume inspect "$VAULT_VOLUME" > /dev/null 2>&1 || docker volume create "$VAULT_VOLUME"

# Fix ownership: Vault container runs as UID 100
docker run --rm \
  -v "${VAULT_VOLUME}:/vault-file" \
  -v "$(cd "$BACKUP_PATH" && pwd):/backup:ro" \
  alpine \
  sh -c "rm -rf /vault-file/* /vault-file/..?* /vault-file/.[!.]* 2>/dev/null || true; \
         tar xzf /backup/vault-data.tar.gz -C /vault-file; \
         chown -R 100:100 /vault-file"

log "  → vault-data restored and ownership fixed (UID 100:100)"

# ----------------------------------------------------------------
# 4. Restore Postgres volume
# ----------------------------------------------------------------
log "Restoring Postgres data volume ($POSTGRES_VOLUME)..."

docker volume inspect "$POSTGRES_VOLUME" > /dev/null 2>&1 || docker volume create "$POSTGRES_VOLUME"

docker run --rm \
  -v "${POSTGRES_VOLUME}:/pg-data" \
  -v "$(cd "$BACKUP_PATH" && pwd):/backup:ro" \
  alpine \
  sh -c "rm -rf /pg-data/* /pg-data/..?* /pg-data/.[!.]* 2>/dev/null || true; \
         tar xzf /backup/postgres-data.tar.gz -C /pg-data; \
         chown -R 999:999 /pg-data"

log "  → postgres-data restored and ownership fixed (UID 999:999)"

# ----------------------------------------------------------------
# 5. Start containers and unseal Vault
# ----------------------------------------------------------------
log ""
log "Starting containers..."
docker compose up -d

log "Unsealing Vault..."
bash "$SCRIPT_DIR/unseal.sh"

log ""
log "Restore complete. Vault is running and unsealed."
log "Run 'bash scripts/migrate.sh' if you need to re-apply DB migrations."