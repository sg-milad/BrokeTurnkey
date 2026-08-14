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

1. **Prepare `.env`** — copy `.env.example` and fill in the required values:

   ```bash
   cp .env.example .env
   # .env is gitignored — never commit it.
   ```

   Required values:

   ```bash
   # Postgres — docker compose refuses to start without this
   POSTGRES_PASSWORD=change-me-please

   # Shared secret between the NestJS API and the Go crypto service.
   # Generate one with:  openssl rand -hex 32
   CRYPTO_AUTH_TOKEN=<64 hex chars>

   # Vault AppRole credentials (see docs/VAULT_INIT.md)
   VAULT_ROLE_ID=...
   VAULT_SECRET_ID=...
   ```

2. **Start all containers**: `docker compose up -d`

   > The base compose file does **not** publish Postgres (5432) or Vault
   > (8200) to the host. If you need them for local tooling (psql,
   > drizzle-kit studio, Vault UI), use the dev override:
   > `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`

3. **Initialise and unseal Vault** (see `docs/VAULT_INIT.md`)

4. Run database migrations: `pnpm db:push`

5. Start the NestJS API: `pnpm run start:dev api`

6. The Go crypto service starts automatically as a Docker container.
   Verify it: `curl http://localhost:4000/health` (or with the dev override
   — see `docs/CRYPTO_SERVICE.md` for full usage).

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
    "name": "prod",
    "publicKey": "<contents of public.pem with \\n escapes>",
    "scopes": ["*"]
  }'
# → { "keyId": "ak_prod_abc123", ... }
```

## Feature Tasks

- implemnt ## Phase 7 — Smart Accounts (ERC-4337) in [tasks](./docs/TASKS.md)
