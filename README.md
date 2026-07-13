# WalletMVP — Self-Hosted Wallet-as-a-Service

A zero-cost, Turnkey-inspired custodial wallet backend built for solo developers.
Generates HD wallets, protects private keys with envelope encryption, enforces
signing policies, and handles gas/nonce management — all without AWS or paid
cloud services.

---

## What this project is

WalletMVP is a backend service that lets your application create and control
Ethereum wallets on behalf of users, without ever exposing raw private keys to
your application code or storing them in plaintext.

It is modelled on how [Turnkey](https://turnkey.com) works architecturally, but
replaces their paid cloud infrastructure (AWS Nitro Enclaves, KMS) with
self-hosted free equivalents (HashiCorp Vault OSS, Docker, a dedicated Go
signing binary).

The project is intended as an **MVP and learning reference**, not a
production-grade replacement for a security-audited WaaS provider.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Client app                                                     │
│  Signs every HTTP request with a P-256 API key ("stamp")       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS + stamp header
┌──────────────────────────▼──────────────────────────────────────┐
│  NestJS API gateway                                             │
│  Stamp verification · rate limiting · audit log · routing       │
└───────┬───────────────────────────────┬─────────────────────────┘
        │                               │
┌───────▼───────┐             ┌─────────▼──────────┐
│ Policy engine │             │  WalletService      │
│ spend limits  │             │  createWallet       │
│ allowlists    │             │  deriveAddress      │
│ time locks    │             │  requestSign        │
└───────────────┘             └─────────┬───────────┘
                                        │
                   ┌────────────────────▼──────────────────────┐
                   │  HashiCorp Vault (self-hosted, free OSS)  │
                   │  Transit engine — wraps/unwraps DEKs      │
                   │  Shamir unseal — 2-of-3 threshold         │
                   └────────────────────┬──────────────────────┘
                                        │ plaintext DEK (short-lived)
                   ┌────────────────────▼──────────────────────┐
                   │  Go signing binary (isolated process)     │
                   │  Receives: encrypted seed + DEK via stdin │
                   │  Decrypts seed → derives child key        │
                   │  Signs tx hash → zeroes memory → exits    │
                   └────────────────────┬──────────────────────┘
                                        │ signature only
                   ┌────────────────────▼──────────────────────┐
                   │  GasService (NestJS + Viem)               │
                   │  estimateGas · manage nonce · assemble tx │
                   │  broadcast via free RPC (Ankr/Alchemy)    │
                   └────────────────────┬──────────────────────┘
                                        │
                   ┌────────────────────▼──────────────────────┐
                   │  PostgreSQL                               │
                   │  encrypted_seed · encrypted_dek           │
                   │  wallets · users · audit_log · nonces     │
                   └───────────────────────────────────────────┘
```

![Service architecture](./architecture.png)

---

## Technology stack

| Layer | Technology | Cost |
|---|---|---|
| API framework | NestJS + TypeScript | Free |
| Signing binary | Go | Free |
| Key encryption (KEK) | HashiCorp Vault OSS (Docker) | Free |
| Symmetric encryption | Node.js `crypto` — AES-256-GCM | Free |
| HD wallet generation | `@scure/bip39` + `@scure/bip32` | Free |
| Smart contract interaction | Viem | Free |
| Database | PostgreSQL (Docker) | Free |
| RPC / gas estimation | Ankr free / Alchemy free / Tenderly | Free |
| Authentication | P-256 API keys + optional WebAuthn | Free |
| Audit log | PostgreSQL append-only table | Free |

**Total infrastructure cost: $0**

---

## Key design decisions

### HD wallets (BIP32/BIP39/BIP44)

Every user gets a single BIP39 mnemonic seed (24 words, 256-bit entropy).
From that one seed, an unlimited number of child key pairs can be derived
deterministically using BIP32 paths (`m/44'/60'/0'/0/N`). The seed is
generated once, encrypted immediately, and never stored in plaintext.
Individual child private keys are derived ephemerally at signing time and
discarded after use.

### Envelope encryption with Vault as KEK

Each wallet has its own Data Encryption Key (DEK), a random 32-byte AES-256
key. The DEK encrypts the seed. The DEK itself is then encrypted by Vault's
Transit engine (the Key Encryption Key, or KEK), which never leaves Vault.
Only the ciphertext of both the seed and the DEK is stored in PostgreSQL.
This means a database breach alone exposes nothing — an attacker would also
need to compromise Vault.

### Isolated signing process

Transaction signing does not happen inside the NestJS API process. Instead,
a dedicated Go binary receives the encrypted seed and plaintext DEK via
stdin (OS pipe, never written to disk), decrypts the seed, derives the
child key, signs, zeroes all sensitive memory, and exits. The signature is
the only thing that ever leaves the signing process.

### Stamp-based authentication

Every client request must carry a cryptographic stamp: a P-256 signature
over the request body and a timestamp, attached as an HTTP header. The API
verifies this signature before doing anything. This prevents request
forgery, MITM attacks, and replay attacks — the same mechanism Turnkey uses.

### Append-only audit log

Every signing event, policy decision, and wallet creation is written to an
append-only PostgreSQL table (the `app_role` has no UPDATE or DELETE
privileges on it). This gives you a tamper-resistant history of all key usage.

---

## What this MVP does NOT have (vs. Turnkey)

| Turnkey feature | MVP equivalent | Gap |
|---|---|---|
| AWS Nitro Enclave (hardware TEE) | Docker process isolation | Kernel/hypervisor can still read Go process memory |
| Remote attestation (PCR hash) | None | Cannot cryptographically prove what code ran |
| HSM-backed entropy | `/dev/urandom` (OS) | Not hardware-certified, but cryptographically sound |
| Quorum Key (hardware-enforced) | Vault Shamir unseal keys | Trusted by software, not hardware |
| Inter-enclave signed messages | None | No provable chain of trust between services |

This gap is real. For a product above ~$50k TVL or with strict compliance
requirements, use Turnkey's production API or invest in Nitro Enclave
infrastructure.

---

## Repository structure

```
apps/
  api/           NestJS app — gateway, auth, wallet CRUD, gas, broadcast
libs/
  vault/         VaultTransitService — wraps Vault HTTP API
  wallet/        WalletService — BIP39/BIP32, seed lifecycle
  gas/           GasService — Viem estimateGas, nonce manager
  policy/        PolicyEngine — rule evaluator (allowlist, limits)
  auth/          StampVerifier — P-256 stamp verification
cmd/
  signer/        Go binary — isolated signing process
migrations/      PostgreSQL schema migrations
docker/          Docker Compose for Vault + Postgres dev environment
docs/            Architecture docs, phase plans, Vault setup guide
```

---

## Getting started (overview)

1. Start Vault and PostgreSQL via Docker Compose
2. Initialise Vault with Shamir unseal (3 shares, threshold 2)
3. Enable the Transit secrets engine and create the `wallet-dek` key ring
4. Configure Vault AppRole for the NestJS app
5. Run migrations against PostgreSQL
6. Start the NestJS API (`npm run start:dev`)
7. Build the Go signing binary (`go build ./cmd/signer`)
8. Call `POST /wallets` to create your first wallet

Detailed setup instructions for each step are in the phase task files.
