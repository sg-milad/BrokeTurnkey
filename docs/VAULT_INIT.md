# Vault Initialisation Runbook

Run this every time you set up Vault from scratch (new machine, wiped volume,
or after `docker compose --env-file .env.api down -v`). After the first run, the only thing you
do on restart is **unseal** — not re-init.

> **Host ports:** the base `docker compose --env-file .env.api up -d` does **not** publish Vault
> (8200) or Postgres (5432) to the host. This runbook's `curl localhost:8200`
> checks and the Vault UI need the dev override:
>
> ```bash
> docker compose --env-file .env.api -f docker-compose.yml -f docker-compose.dev.yml up -d
> ```
>
> Everything else (`docker exec`, the unseal script) works without it.

---

## Pre-flight checklist

- [ ] `docker compose --env-file .env.api up -d` has been run (add `-f docker-compose.dev.yml`
      if you need host access to ports 8200/5432)
- [ ] All containers show `Up` in `docker compose ps`
- [ ] `.env.operator` does NOT yet exist (or has been emptied)
- [ ] `.env.api` and `.env.crypto` exist (copy the `*.example` files)
- [ ] `.gitignore` ignores `.env*` and tracks only the examples

---


## Step 0 — Ensure Volume Exists & Fix Ownership
When Docker creates the walletmvp_vault-data volume, it defaults to root
ownership. Vault runs as UID 100 and will crash if it cannot write to its
data directory.

# 0.1. Safely fix ownership using an isolated Alpine container
docker run --rm -v walletmvp_vault-data:/vault-file alpine chown -R 100:100 /vault-file


## Step 1 — Wait for Vault to be ready

```bash
# Needs the dev override (host port 8200) OR run inside the container:
docker exec walletmvp-vault vault status
```

With the dev override, the HTTP check also works:

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

Copy the output immediately into `.env.operator` — a file that is **never**
loaded by the API or crypto containers:

```bash
# .env.operator — DO NOT COMMIT THIS FILE
VAULT_ADDR=http://127.0.0.1:8200
VAULT_ROOT_TOKEN=hvs.REPLACE_ME
VAULT_UNSEAL_KEY_1=REPLACE_ME
VAULT_UNSEAL_KEY_2=REPLACE_ME
VAULT_UNSEAL_KEY_3=REPLACE_ME
```

> Keys 1 and 2 are used by the automated unseal script.
> Key 3 is your offline backup — store it separately from the other two.
> The root token and unseal keys must not be in `.env.api` or `.env.crypto`.

---

## Step 3 — Unseal Vault

```bash
set -a; source .env.operator; set +a
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
set -a; source .env.operator; set +a
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

Two policies are used. The runtime `wallet-signer` policy **excludes** the
`secret-id` path; a separate `wallet-operator` policy is attached only to the
human/operator token used for rotation.

```bash
docker cp vault/policies/wallet-signer.hcl walletmvp-vault:/tmp/wallet-signer.hcl
docker cp vault/policies/wallet-operator.hcl walletmvp-vault:/tmp/wallet-operator.hcl

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault policy write wallet-signer /tmp/wallet-signer.hcl
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault policy write wallet-operator /tmp/wallet-operator.hcl

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

# Generate the first SecretID (treat like a password). Use an operator token
# with wallet-operator, or the root token during initial setup.
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
```

Add RoleID, SecretID, the shared auth token, and signer limits to
`.env.crypto` (the crypto container's only env file):

```bash
# .env.crypto (for the Go crypto service container)
VAULT_ADDR=http://vault:8200
VAULT_ROLE_ID=REPLACE_ME
VAULT_SECRET_ID=REPLACE_ME
CRYPTO_AUTH_TOKEN=REPLACE_ME   # same as .env.api — openssl rand -hex 32
CRYPTO_PORT=4000
SIGNER_MAX_VALUE_WEI=1000000000000000000
SIGNER_ALLOWED_CHAIN_IDS=
SIGNER_ALLOWED_TO=
SIGNER_ALLOWED_SELECTORS=
SIGNER_ALLOW_HASH_SIGNING=false
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
set -a; source .env.operator; set +a

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

This sources `.env.operator` and submits keys 1 and 2 automatically.

---

## SecretID Rotation (Every 30 days)

The AppRole SecretID must be rotated manually before its 30-day TTL expires.
To rotate it, generate a new one and update the Go service:

```bash
set -a; source .env.operator; set +a
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
```

Then update `VAULT_SECRET_ID` in `.env.crypto` and restart the crypto container:

```bash
docker compose --env-file .env.api up -d --force-recreate crypto
```

---

## Key storage reference

| Key              | Where to store                                        |
| ---------------- | ----------------------------------------------------- |
| Unseal Key 1     | `.env.operator` (dev only) / primary password manager |
| Unseal Key 2     | `.env.operator` (dev only) / secondary password manager |
| Unseal Key 3     | **Not in `.env.operator`** — printed backup/offline   |
| Root Token       | `.env.operator` (dev only) — never in app env        |
| AppRole RoleID   | `.env.crypto` — not secret                           |
| AppRole SecretID | `.env.crypto` — rotate manually every 30 days        |
