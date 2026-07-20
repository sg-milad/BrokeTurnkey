# Vault Initialisation Runbook

Run this every time you set up Vault from scratch (new machine, wiped volume,
or after `docker compose down -v`). After the first run, the only thing you
do on restart is **unseal** — not re-init.

---

## Pre-flight checklist

- [ ] `docker compose up -d` has been run
- [ ] All containers show `Up` in `docker compose ps`
- [ ] `.env.vault` does NOT yet exist (or has been emptied)
- [ ] `.gitignore` contains `.env.vault`

---

## Step 1 — Wait for Vault to be ready

```bash
curl http://localhost:8200/v1/sys/health
```

Expected: `{"initialized":false,"sealed":true,...}`

If you get `connection refused`, wait a few seconds and retry.

---

## Step 2 — Initialise (one-time only)

```bash
docker exec walletmvp-vault vault operator init \
  -key-shares=3 \
  -key-threshold=2
```

This prints **3 unseal keys** and **1 root token**. You will never see these again.

Copy the output immediately into `.env.vault`:

```bash
# .env.vault — DO NOT COMMIT THIS FILE
VAULT_ADDR=http://localhost:8200
VAULT_ROOT_TOKEN=hvs.REPLACE_ME
VAULT_UNSEAL_KEY_1=REPLACE_ME
VAULT_UNSEAL_KEY_2=REPLACE_ME
VAULT_UNSEAL_KEY_3=REPLACE_ME
```

> Keys 1 and 2 are used by the automated unseal script.
> Key 3 is your offline backup — store it separately from the other two.

---

## Step 3 — Unseal Vault

```bash
source .env.vault
docker exec walletmvp-vault vault operator unseal "$VAULT_UNSEAL_KEY_1"
docker exec walletmvp-vault vault operator unseal "$VAULT_UNSEAL_KEY_2"
```

Verify:

```bash
docker exec walletmvp-vault vault status
# Sealed: false  ← what you want
```

---

## Step 4 — Authenticate as root (this session only)

```bash
source .env.vault
docker exec -it -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault sh
# You are now inside the container with root Vault access
# Run vault commands freely, then type 'exit' when done
```

---

## Step 5 — Enable the Transit secrets engine

```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault secrets enable transit
```

---

## Step 6 — Create and lock the wallet-dek key ring

```bash
# Create the key ring
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f transit/keys/wallet-dek type=aes256-gcm96

# Disable export and plaintext backup — cannot be undone
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write transit/keys/wallet-dek/config \
    exportable=false \
    allow_plaintext_backup=false

# Verify
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault read transit/keys/wallet-dek
```

---

## Step 7 — Configure AppRole for the Go crypto service

WalletMVP has a single AppRole: `wallet-signer` used exclusively by the Go
crypto service. NestJS has no AppRole and no Vault credentials.

The policy includes permission to generate new SecretIDs for manual rotation.

```bash
# Write the policy
cat <<'EOF' > /tmp/wallet-signer-policy.hcl
path "transit/encrypt/wallet-dek" {
  capabilities = ["update"]
}
path "transit/decrypt/wallet-dek" {
  capabilities = ["update"]
}
path "auth/approle/role/wallet-signer/secret-id" {
  capabilities = ["update"]
}
EOF

docker cp /tmp/wallet-signer-policy.hcl walletmvp-vault:/tmp/wallet-signer-policy.hcl

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault policy write wallet-signer /tmp/wallet-signer-policy.hcl

# Enable AppRole auth method
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault auth enable approle

# Create the role
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write auth/approle/role/wallet-signer \
    token_policies="wallet-signer" \
    token_ttl=1h \
    token_max_ttl=24h \
    secret_id_ttl=720h \
    secret_id_num_uses=0

# Read the RoleID (not secret — safe to store in config)
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault read auth/approle/role/wallet-signer/role-id

# Generate the first SecretID (treat like a password)
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
```

Add RoleID and SecretID to the Go crypto service env:

```bash
# .env (for the Go crypto service container)
VAULT_ADDR=http://vault:8200
VAULT_ROLE_ID=REPLACE_ME
VAULT_SECRET_ID=REPLACE_ME
CRYPTO_PORT=4000
```

> **SecretID rotation:** The Go crypto service no longer self-rotates the SecretID.
> The SecretID is valid for 30 days (`720h`) and has unlimited uses (`0`) within
> that window. You must rotate it manually every 30 days (see instructions below).

---

## Step 8 — Enable audit logging

```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault audit enable file file_path=/vault/logs/audit.log
```

---

## Done checklist

```bash
source .env.vault

# 1. Status
docker exec walletmvp-vault vault status

# 2. Secrets engines
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault vault secrets list

# 3. Key ring
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault vault read transit/keys/wallet-dek

# 4. Policy
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault vault policy read wallet-signer

# 5. AppRole
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault read auth/approle/role/wallet-signer

# 6. Audit log
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault vault audit list
```

Expected state:

| Check                          | Expected value               |
| ------------------------------ | ---------------------------- |
| `Initialized`                  | `true`                       |
| `Sealed`                       | `false`                      |
| `transit/` in secrets list     | present                      |
| `wallet-dek` key exists        | present, `exportable: false` |
| `wallet-signer` policy exists  | present                      |
| AppRole `wallet-signer` exists | present                      |
| Audit log enabled              | present                      |

---

## On every restart (sealed state)

Vault comes up sealed after every container restart. Run:

```bash
bash scripts/unseal.sh
```

This sources `.env.vault` and submits keys 1 and 2 automatically.

---

## SecretID Rotation (Every 30 days)

The AppRole SecretID must be rotated manually before its 30-day TTL expires.
To rotate it, generate a new one and update the Go service:

```bash
source .env.vault
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
```

Then update `VAULT_SECRET_ID` in `.env` and restart the crypto container.

---

## Key storage reference

| Key              | Where to store                                              |
| ---------------- | ----------------------------------------------------------- |
| Unseal Key 1     | `.env.vault` (dev only) / primary password manager          |
| Unseal Key 2     | `.env.vault` (dev only) / secondary password manager        |
| Unseal Key 3     | **Not in `.env.vault`** — printed backup or offline storage |
| Root Token       | `.env.vault` (dev only) — never in application code         |
| AppRole RoleID   | `.env` — not secret                                         |
| AppRole SecretID | `.env` — rotate manually every 30 days                      |
