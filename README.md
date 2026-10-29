# WalletMVP — Self-Hosted Wallet-as-a-Service

A zero-cost, Turnkey-inspired custodial wallet backend built for B2B use.
Generates HD wallets, protects private keys with envelope encryption, enforces
signing policies, and handles gas/nonce management — all without AWS or paid
cloud services.

---

## What this project is

WalletMVP is a backend service that lets your application create and control
Ethereum wallets on behalf of your B2B customers, without ever exposing raw
private keys to your application code or storing them in plaintext.

It is modelled on how [Turnkey](https://turnkey.com) works architecturally,
replacing their paid cloud infrastructure (AWS Nitro Enclaves, KMS) with
self-hosted free equivalents (HashiCorp Vault OSS, Docker, a dedicated Go
crypto service).

The project is intended as an **MVP and learning reference**, not a
production-grade replacement for a security-audited WaaS provider.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Client app                                                     │
│  Signs every HTTP request with a P-256 API key ("stamp")       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS + X-Stamp header
┌──────────────────────────▼──────────────────────────────────────┐
│  NestJS API (port 3000)                                         │
│  Stamp verification · policy enforcement · audit log           │
│  Coordinates wallet CRUD, gas, nonce, broadcast                 │
│  Never holds key material — only passes ciphertext              │
└───────┬───────────────────────────────┬─────────────────────────┘
        │                               │ HTTP (internal network)
        │                    ┌──────────▼──────────────────────────┐
        │                    │  Go Crypto Service (internal only)  │
        │                    │  Single cryptographic boundary      │
        │                    │  BIP39 · BIP32 · AES-256-GCM        │
        │                    │  RLP · keccak256 · secp256k1        │
        │                    │  Vault AppRole (wallet-signer)      │
        │                    └──────────┬──────────────────────────┘
        │                               │ AppRole + transit calls
        │                    ┌──────────▼──────────────────────────┐
        │                    │  HashiCorp Vault (port 8200)        │
        │                    │  Transit engine — wraps/unwraps DEKs│
        │                    │  Shamir unseal — 2-of-3 threshold   │
        │                    │  Single AppRole: wallet-signer      │
        │                    └─────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────────────────┐
│  PostgreSQL (port 5432)                                         │
│  encrypted_seed · encrypted_dek · wallets · audit_log · nonces  │
│  All key material stored as ciphertext — no plaintext keys      │
└─────────────────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────────────────┐
│  External RPC (Ankr / Alchemy free tier)                        │
│  eth_estimateGas · eth_sendRawTransaction                       │
└─────────────────────────────────────────────────────────────────┘
```

**Key principle:** NestJS never holds a Vault token or any plaintext key
material. The Go crypto service is the only component that touches keys.
A full database breach alone exposes nothing — an attacker would also need
to compromise the Go service and Vault simultaneously.

---

## Stack

The NestJS API is TypeScript throughout. The Go crypto service is a separate
long-lived HTTP sidecar that handles all cryptographic operations: BIP39/BIP32
key derivation, AES-256-GCM encryption, RLP encoding, keccak256 hashing, and
secp256k1 signing. HashiCorp Vault OSS runs in Docker as the KEK store.
PostgreSQL for everything else. Viem in NestJS for gas estimation and broadcast.
Free RPC (Alchemy / Ankr) for testnet; swap in your own endpoint for mainnet.

Total infra cost: $0.

---

## Repository structure

```
apps/
  api/              NestJS app — gateway, auth, wallet CRUD, gas, broadcast
libs/
  crypto-client/    HTTP client for Go crypto service
  wallet/           WalletService — wallet lifecycle, coordinates with Go service
  gas/              GasService — Viem estimateGas, nonce manager, broadcast
  policy/           PolicyEngine — rule evaluator (allowlist, limits, time locks)
  auth/             StampVerifier — P-256 stamp verification
  db/               DatabaseModule — Drizzle ORM, all 9 tables
  monitor/          Transaction Monitor Service
cmd/
  crypto/           Go crypto service — HTTP server, all cryptographic operations
docs/
  ARCHITECTURE.md   Component definitions, communication map, architecture diagram
  KEY_MANAGEMENT.md Cryptographic decisions, key hierarchy, security properties
  STAMP_AUTH.md     P-256 stamp authentication spec (X-Stamp construction, replay)
  API.md            API reference with worked curl examples
  CRYPTO_SERVICE.md Go crypto service API reference + auth token guide
  SEQUENCE_DIAGRAMS.md All flow diagrams (Mermaid)
  VAULT.md          Vault concepts, runtime behaviour, key rotation
  VAULT_INIT.md     Step-by-step Vault setup runbook
  TASKS.md          Phased implementation task list
  schema.dbml       Database schema reference
vault/
  config/           HashiCorp Vault HCL configuration
scripts/
  unseal.sh         Automated Vault unseal on restart
  build-crypto.sh   Build the Go crypto service binary
  api/*             sending request with bash
```

---

## Getting started

1. **Prepare split env files** — each trust boundary gets its own file:

   ```bash
   cp .env.example .env.api                    # API: DB, crypto token, RPC, allowlists
   cp .env.crypto.example .env.crypto          # crypto sidecar: Vault + SIGNER_* limits
   cp .env.operator.example .env.operator      # operator only: root token + unseal keys
   chmod 600 .env.api .env.crypto .env.operator
   # All are gitignored — never commit them. Never load .env.operator in a container.
   ```

   Required values:

   ```bash
   # POSTGRES_PASSWORD in .env.api — compose refuses to start without it
   POSTGRES_PASSWORD=change-me-please

   # Same value in .env.api and .env.crypto. Generate with: openssl rand -hex 32
   CRYPTO_AUTH_TOKEN=<64 hex chars>

   # .env.crypto only (see docs/VAULT_INIT.md)
   VAULT_ROLE_ID=...
   VAULT_SECRET_ID=...
   ```

   `SIGNER_*` limits in `.env.crypto` are enforced by Go **before** it decrypts
   a seed. Keep them conservative; `SIGNER_ALLOW_HASH_SIGNING=false` disables
   EIP-712/EIP-191 until you explicitly allowlist domains in `.env.api`.

2. **Start the dev stack**:

   ```bash
   docker compose --env-file .env.api -f docker-compose.yml -f docker-compose.dev.yml up -d
   ```

   Prod-like (no host ports, production API image, no source mount):

   ```bash
   docker compose --env-file .env.api up -d
   ```

   > Vault (8200) and Postgres (5432) are never internet-reachable. The dev
   > override binds them to `127.0.0.1` only. The base stack attaches Vault to
   > its own internal network and the crypto sidecar to both Vault and the app
   > network; the API has no route to Vault.

3. **Initialise and unseal Vault** (see `docs/VAULT_INIT.md`). Operator
   commands source `.env.operator`:

   ```bash
   set -a; source .env.operator; set +a
   bash scripts/unseal.sh
   ```

4. Run database migrations: `pnpm db:push`

5. For host-side development only, start the NestJS API: `pnpm run start:dev api`
   (the dev container already runs it; the host process needs `.env.api`).

6. The Go crypto service starts automatically. It is not published to the host;
   verify from inside the stack (or with the dev override) — see
   `docs/CRYPTO_SERVICE.md`.

7. Make your first request (see walkthrough below).

### First request walkthrough

-> recommendation: use [scripts](./scripts/api/) for sending request.

```bash
# 1. Create and onboard an organization in one step.
#    Returns the first wallet address and a one-time bootstrap token.
curl -s -X POST http://localhost:3000/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Corp", "slug": "acme"}'
# → { "id": "<org-id>", "slug": "acme", "firstAddress": "0x...", "bootstrapToken": "<token>", ... }

# 2. Register your first API key using the bootstrap token.
#    Generate a P-256 keypair first — the private key never leaves your machine.
openssl ecparam -name prime256v1 -genkey -noout -out private.pem
openssl ec -in private.pem -pubout -out public.pem

curl -s -X POST http://localhost:3000/api-keys \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: <bootstrapToken>' \
  -d '{
    "name": "prod-admin",
    "publicKey": "<contents of public.pem with \\n escapes>",
    "scopes": ["key:write", "wallet:read", "wallet:create", "policy:write"]
  }'
# → { "keyId": "ak_prod_abc123", ... }

# 3. A signing key must be registered separately with wallet:sign.
#    Wildcard "*" is rejected. Signing also needs at least one applicable
#    active policy (create one before the first sign request).
```

## Feature Tasks

- implemnt ## Phase 7 — Smart Accounts (ERC-4337) in [tasks](./docs/TASKS.md)
