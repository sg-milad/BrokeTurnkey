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

| Layer | Technology | Cost |
|---|---|---|
| API framework | NestJS + TypeScript | Free |
| Crypto service | Go (long-lived HTTP sidecar) | Free |
| Key encryption (KEK) | HashiCorp Vault OSS (Docker) | Free |
| Seed encryption | AES-256-GCM (Go `crypto/aes`) | Free |
| HD wallet generation | `go-bip39` + `go-bip32` (Go) | Free |
| Transaction signing | `go-ethereum` (RLP, keccak256, secp256k1) | Free |
| Smart contract interaction | Viem (NestJS broadcast layer) | Free |
| Database | PostgreSQL (Docker) | Free |
| RPC / gas estimation | Ankr free / Alchemy free / Tenderly | Free |
| Authentication | P-256 API keys + optional WebAuthn | Free |
| Audit log | PostgreSQL append-only table + Vault audit log | Free |

**Total infrastructure cost: $0**

---

## Key design decisions

### One seed per organisation (B2B model)

Every B2B customer (organisation) gets one BIP39 mnemonic seed (24 words,
256-bit entropy) generated at onboarding. All wallet addresses for that
organisation are derived deterministically from this single seed via BIP32
paths (`m/44'/60'/0'/0/N`). No new entropy is ever needed when adding wallets.
The seed is generated once, encrypted immediately, and never stored in plaintext.

### Go owns all cryptography

All cryptographic operations happen exclusively in the Go crypto service:
BIP39 mnemonic generation, AES-256-GCM seed encryption, Vault DEK wrapping,
BIP32 child key derivation, RLP transaction encoding, keccak256 hashing, and
secp256k1 signing. NestJS receives only ciphertext and signatures. This means
plaintext key material never exists in the Node.js process — not even briefly.

### Envelope encryption with Vault as KEK

Each organisation has a random 32-byte DEK that encrypts their seed. The DEK
itself is encrypted by Vault's Transit engine (the KEK), which never leaves
Vault. Only ciphertext is stored in PostgreSQL. A database breach alone
exposes nothing; an attacker would also need to compromise the Go service
and Vault simultaneously.

### Go is a long-lived HTTP sidecar, not a spawned process

The Go crypto service runs as a separate Docker container with a persistent
HTTP server. NestJS calls it over the internal Docker network per request.
This avoids per-request process startup overhead (50–200ms) while maintaining
full process isolation — NestJS cannot directly read Go's memory.

### txHash computed inside Go

The Ethereum transaction hash (RLP encode → keccak256) is computed inside the
Go crypto service, not in NestJS. This means Go knows exactly what it is
signing and cannot be tricked into signing malicious data by a bug in NestJS.

### Single Vault AppRole for Go only

NestJS has no Vault credentials. The Go crypto service uses one AppRole
(`wallet-signer`) scoped only to `transit/encrypt` and `transit/decrypt`.
The AppRole SecretID is single-use and self-rotating — Go generates the next
SecretID immediately after each login, so credentials rotate on every restart
with no manual intervention after initial setup.

### Stamp-based authentication

Every client request carries a P-256 cryptographic stamp: a signature over
the request body and timestamp attached as an `X-Stamp` header. The API
verifies this before doing anything. This prevents request forgery, MITM
attacks, and replay attacks — the same mechanism Turnkey uses.

### Append-only audit log

Every signing event, policy decision, and wallet creation is written to an
append-only PostgreSQL table. Vault also writes its own audit log of every
encrypt/decrypt call. Together these give two independent tamper-resistant
records of all key usage.

---

## What this MVP does NOT have (vs. Turnkey)

| Turnkey feature | MVP equivalent | Gap |
|---|---|---|
| AWS Nitro Enclave (hardware TEE) | Docker process isolation | Kernel/hypervisor can still read Go process memory |
| Remote attestation (PCR hash) | None | Cannot cryptographically prove what code ran |
| HSM-backed entropy | `/dev/urandom` (OS CSPRNG) | Not hardware-certified, but cryptographically sound |
| Quorum Key (hardware-enforced) | Vault Shamir unseal keys | Trusted by software, not hardware |
| Inter-enclave signed messages | None | No provable chain of trust between services |

This gap is real. For a product above ~$50k TVL or with strict compliance
requirements, use Turnkey's production API or invest in Nitro Enclave
infrastructure.

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

1. Start all containers: `docker compose up -d`
2. Initialise and unseal Vault (see `docs/VAULT_INIT.md`)
3. Run database migrations: `pnpm db:push`
4. Start the NestJS API: `pnpm run start:dev`
5. The Go crypto service starts automatically as a Docker container
6. Call `POST /organisations/:id/onboard` to onboard your first organisation

Detailed instructions for each step are in `docs/VAULT_INIT.md` and `docs/TASKS.md`.
