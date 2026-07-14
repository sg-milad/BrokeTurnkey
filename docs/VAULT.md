# HashiCorp Vault — Setup, Concepts, and Usage

This document explains how Vault fits into WalletMVP, what it does and does
not do, how to configure it from scratch, and how the Go crypto service
interacts with it at runtime.

---

## What Vault does in this project

Vault plays one narrow role: it is the **Key Encryption Key (KEK) store**.

The Go crypto service never asks Vault to store wallet seeds or private keys.
It asks Vault to encrypt a small symmetric key (the DEK) when creating a
wallet, and to decrypt it when signing. Vault's Transit engine handles these
operations on data-in-transit without storing the data itself. The actual
encrypted wallet seed lives in PostgreSQL; Vault controls access to the key
that can unlock it.

**NestJS has no Vault access at all.** Only the Go crypto service holds a
Vault token and communicates with Vault. This means plaintext key material
never exists in the NestJS process.

---

## The Transit secrets engine

The Transit engine is Vault's "encryption as a service" feature. You enable
it once, create a named key ring, and call HTTP endpoints to encrypt or
decrypt arbitrary data. The encryption key never leaves Vault — the caller
only ever sees ciphertext or plaintext payloads, never the key itself.

**In practice:**

1. Go generates a random 32-byte DEK
2. Go calls `POST /v1/transit/encrypt/wallet-dek` with the DEK as base64
3. Vault returns `"vault:v1:..."` ciphertext
4. Go returns this ciphertext to NestJS, which stores it in Postgres
5. At signing time, Go calls `POST /v1/transit/decrypt/wallet-dek`
6. Vault returns the original DEK as base64
7. Go uses it to decrypt the seed, then immediately zeros it

The `vault:v1:` prefix encodes the key version. When you rotate the Transit
key, old ciphertext (`v1`) can still be decrypted, and new encryptions produce
`vault:v2:...`. Key rotation does not require re-encrypting seeds — only the
DEKs need re-wrapping.

---

## Vault's internal protection model

Vault encrypts all its own data before writing to the storage backend (a
Docker volume in this project). It uses a master key to do this.

To protect the master key, Vault uses **Shamir's secret sharing**. At
initialisation, Vault generates the master key, splits it into N shares, and
discards the original. Only the shares are given to you. To reconstruct the
master key, any K-of-N shares must be combined.

WalletMVP uses **3 shares, threshold 2**: any 2 of your 3 keys unseal Vault.
You can lose access to one key without losing access to Vault.

**The unseal ceremony:**
Every time Vault starts (container restart, server reboot), it is sealed.
Its master key is not in memory. It can read encrypted data from disk but
cannot decrypt any of it. You must provide 2 unseal keys to unseal. Vault
reconstructs the master key in memory and begins serving requests. The
master key is never written to disk.

---

## Initial setup

### Step 1 — Start Vault

Run Vault in production mode (not dev mode). Dev mode auto-unseals and loses
data on restart. Production mode requires a persistent storage backend and
a TCP listener. See `VAULT_INIT.md` for the full runbook.

### Step 2 — Initialise (one-time only)

```bash
docker exec walletmvp-vault vault operator init \
  -key-shares=3 \
  -key-threshold=2
```

This prints 3 unseal keys and 1 root token. Store them immediately. You will
never see them again.

### Step 3 — Unseal

```bash
source .env.vault
docker exec walletmvp-vault vault operator unseal "$VAULT_UNSEAL_KEY_1"
docker exec walletmvp-vault vault operator unseal "$VAULT_UNSEAL_KEY_2"
```

### Step 4 — Enable Transit and create the key ring

```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault secrets enable transit

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f transit/keys/wallet-dek type=aes256-gcm96

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write transit/keys/wallet-dek/config \
    exportable=false \
    allow_plaintext_backup=false
```

### Step 5 — Configure AppRole for the Go crypto service

WalletMVP uses a single AppRole (`wallet-signer`) for the Go crypto service.
NestJS has no AppRole and no Vault credentials.

**Create the policy** — scoped to encrypt and decrypt only:

```hcl
# wallet-signer-policy.hcl
path "transit/encrypt/wallet-dek" {
  capabilities = ["update"]
}
path "transit/decrypt/wallet-dek" {
  capabilities = ["update"]
}
path "auth/approle/role/wallet-signer/secret-id" {
  capabilities = ["update"]
}
```

The third path grants the Go service permission to generate its own next
SecretID immediately after login (self-rotating credentials).

```bash
docker cp /tmp/wallet-signer-policy.hcl walletmvp-vault:/tmp/

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault policy write wallet-signer /tmp/wallet-signer-policy.hcl

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault auth enable approle

docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write auth/approle/role/wallet-signer \
    token_policies="wallet-signer" \
    token_ttl=1h \
    token_max_ttl=24h \
    secret_id_ttl=10m \
    secret_id_num_uses=1
```

Read the RoleID (not sensitive — safe to store in config):
```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault read auth/approle/role/wallet-signer/role-id
```

Generate the first SecretID (treat like a password):
```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
```

Add to the Go crypto service's env:
```bash
VAULT_ROLE_ID=REPLACE_ME
VAULT_SECRET_ID=REPLACE_ME
```

### Step 6 — Enable audit logging

```bash
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault audit enable file file_path=/vault/logs/audit.log
```

---

## Runtime behaviour: how the Go crypto service uses Vault

### At startup

1. Go reads `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` from env
2. Go calls `POST /v1/auth/approle/login` — the SecretID is consumed (single-use)
3. Vault returns a token with a 1-hour TTL
4. Go immediately calls `POST /v1/auth/approle/role/wallet-signer/secret-id`
   to generate a new SecretID and writes it to the env file for the next restart
5. Go stores the Vault token in memory and starts the HTTP server
6. Go starts a background token renewal timer

### Token renewal timing

The Vault token has a 1-hour TTL. Go renews it at **~75% of TTL (≈45 minutes)**
via `POST /v1/auth/token/renew-self`.

Renewing at 75% rather than close to expiry provides a safe buffer: if the
renewal call fails due to a network hiccup or Vault restart, there is still
~15 minutes to retry before the token expires. A token that expires before
renewal requires a full re-login with a new SecretID, which interrupts service.

The `token_max_ttl=24h` sets a hard ceiling — after 24 hours the token cannot
be renewed regardless of how many renewal calls were made, and Go must perform
a fresh AppRole login.

### SecretID self-rotation

The SecretID is configured as single-use (`secret_id_num_uses=1`) and expires
in 10 minutes. This means:

- After the Go service consumes the SecretID at login, it is permanently invalidated
- If an attacker intercepts the SecretID before it is used, they have at most 10 minutes to use it
- After the Go service logs in, it immediately generates the next SecretID and
  persists it to the env file — the next restart is always covered

This rotation is fully automatic. The only manual step is the very first
SecretID generated in `VAULT_INIT.md`.

### At wallet creation

1. Go generates a 32-byte DEK in memory
2. Go calls `POST /v1/transit/encrypt/wallet-dek` with `base64(DEK)` as plaintext
3. Vault returns `{ "data": { "ciphertext": "vault:v1:..." } }`
4. Go returns the ciphertext to NestJS
5. Go zeros the raw DEK buffer

### At signing time

1. Go receives `encryptedDek` from NestJS (the `"vault:v1:..."` ciphertext)
2. Go calls `POST /v1/transit/decrypt/wallet-dek` with the ciphertext
3. Vault returns `{ "data": { "plaintext": "<base64 DEK>" } }`
4. Go decodes the base64 DEK, uses it to decrypt the seed, zeros it immediately

---

## Key rotation

When you rotate the `wallet-dek` key ring:

1. `vault write -f transit/keys/wallet-dek/rotate`
2. Vault creates key version 2. New encryptions use `vault:v2:...`
3. Existing `vault:v1:...` ciphertext can still be decrypted — Vault remembers all versions
4. Run a background job: read each `encrypted_dek`, call decrypt (Vault uses v1),
   call encrypt (Vault uses v2), write the new ciphertext back to Postgres
5. After all records are re-wrapped, set the minimum decryption version to 2:
   `vault write transit/keys/wallet-dek/config min_decryption_version=2`
6. v1 ciphertext is now permanently unreadable — even by Vault

Only the DEKs need re-wrapping. The encrypted seeds in Postgres do not change.
This is the power of two-layer envelope encryption.

---

## Vault audit log

Every Transit encrypt and decrypt call is logged with the calling token,
timestamp, and key name (never the key material itself). This is an
independent record of every time a DEK was accessed, separate from the
application audit log in Postgres.

---

## What Vault does NOT protect you from

**Compromised host OS:** Root access to the Vault machine allows memory
inspection of the Vault process, including the master key. `mlock` prevents
swap but not an active attacker with root. This is the gap vs. a hardware TEE.

**Stolen unseal keys:** If 2 or more Shamir shares are compromised, an
attacker can unseal Vault on their own infrastructure.

**Compromised Go crypto service:** If the Go service is compromised, the
attacker has a valid Vault token with decrypt capability. The 1-hour TTL
limits the exposure window.

**Go process memory dump:** The plaintext DEK exists briefly in Go's memory
between the Vault decrypt call and the AES-GCM seed decryption. Go's explicit
zeroing minimises this window.
