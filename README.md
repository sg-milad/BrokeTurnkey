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

## Technology stack

| Layer                      | Technology                                     | Cost |
| -------------------------- | ---------------------------------------------- | ---- |
| API framework              | NestJS + TypeScript                            | Free |
| Crypto service             | Go (long-lived HTTP sidecar)                   | Free |
| Key encryption (KEK)       | HashiCorp Vault OSS (Docker)                   | Free |
| Seed encryption            | AES-256-GCM (Go `crypto/aes`)                  | Free |
| HD wallet generation       | `go-bip39` + `go-bip32` (Go)                   | Free |
| Transaction signing        | `go-ethereum` (RLP, keccak256, secp256k1)      | Free |
| Smart contract interaction | Viem (NestJS broadcast layer)                  | Free |
| Database                   | PostgreSQL (Docker)                            | Free |
| RPC / gas estimation       | Ankr free / Alchemy free / Tenderly            | Free |
| Authentication             | P-256 API keys + optional WebAuthn             | Free |
| Audit log                  | PostgreSQL append-only table + Vault audit log | Free |

**Total infrastructure cost: $0**

---

## Key design decisions

### One seed per organization (B2B model)

Every B2B customer (organization) gets one BIP39 mnemonic seed (24 words,
256-bit entropy) generated at onboarding. All wallet addresses for that
organization are derived deterministically from this single seed via BIP32
paths (`m/44'/60'/0'/0/N`). No new entropy is ever needed when adding wallets.
The seed is generated once, encrypted immediately, and never stored in plaintext.

### Go owns all cryptography

All cryptographic operations happen exclusively in the Go crypto service:
BIP39 mnemonic generation, AES-256-GCM seed encryption, Vault DEK wrapping,
BIP32 child key derivation, RLP transaction encoding, keccak256 hashing, and
secp256k1 signing. NestJS receives only ciphertext and signatures. This means
plaintext key material never exists in the Node.js process — not even briefly.

### Envelope encryption with Vault as KEK

Each organization has a random 32-byte DEK that encrypts their seed. The DEK
itself is encrypted by Vault's Transit engine (the KEK), which never leaves
Vault. Only ciphertext is stored in PostgreSQL. A database breach alone
exposes nothing; an attacker would also need to compromise the Go service
and Vault simultaneously.

### Single Vault AppRole for Go only

NestJS has no Vault credentials. The Go crypto service uses one AppRole
(`wallet-signer`) scoped only to `transit/encrypt` and `transit/decrypt`.
The AppRole SecretID is rotated **manually every 30 days** (see
`docs/VAULT_INIT.md`); the Vault token itself is renewed automatically by Go
at 75% of its TTL.

### Shared secret between NestJS and Go

Every NestJS → Go call carries the `X-Crypto-Token` header with a shared
secret (`CRYPTO_AUTH_TOKEN`) that the Go service requires on every endpoint
except `/health`. See `docs/CRYPTO_SERVICE.md` for how to generate the token
and call the Go service directly.

### Stamp-based authentication

Every client request carries a P-256 cryptographic stamp: a signature over
the request body and timestamp attached as an `X-Stamp` header. The API
verifies this before doing anything. This prevents request forgery, MITM
attacks, and replay attacks — the same mechanism Turnkey uses.

---

## Repository structure

```
apps/
  api/              NestJS app — gateway, auth, wallet CRUD, gas, broadcast
libs/
  crypto-client/    HTTP client for Go crypto service (replaces vault lib)
  wallet/           WalletService — wallet lifecycle, coordinates with Go service
  gas/              GasService — Viem estimateGas, nonce manager, broadcast
  policy/           PolicyEngine — rule evaluator (allowlist, limits, time locks)
  auth/             StampVerifier — P-256 stamp verification
  db/               DatabaseModule — Drizzle ORM, all 9 tables
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

7. Call `POST /organizations/:id/onboard` to onboard your first organization.

### First request walkthrough

```bash
# 1. Create an organization
curl -s -X POST http://localhost:3000/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Corp", "slug": "acme"}'
# → { id, slug, name, ... }

# 2. Onboard it — generates the org seed, returns the first wallet address
#    and the one-time bootstrap token for registering your first API key
curl -s -X POST http://localhost:3000/organizations/<org-id>/onboard \
  -H 'Content-Type: application/json' -d '{}'
# → { orgId, firstAddress, bootstrapToken }

# 3. Register your first API key using the bootstrap token
curl -s -X POST http://localhost:3000/organizations/<org-id>/api-keys \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: <bootstrapToken>' \
  -d '{"name": "prod", "publicKey": "<P-256 public key in PEM>", "scopes": ["*"]}'
```

From there, every request must carry a **stamp** — a P-256 signature over the
raw request body + timestamp in the `X-Stamp` header. See
`docs/STAMP_AUTH.md` (spec) and `docs/API.md` (worked examples) for the
construction.

### Calling the Go crypto service directly (debugging only)

Every endpoint except `/health` requires `X-Crypto-Token`. Example:

```bash
curl -s -X POST http://localhost:4000/wallet/create \
  -H 'Content-Type: application/json' \
  -H "X-Crypto-Token: $CRYPTO_AUTH_TOKEN" \
  -d '{}'
```

Full endpoint reference with request/response examples:
`docs/CRYPTO_SERVICE.md`.

Detailed instructions for Vault setup are in `docs/VAULT_INIT.md`.
