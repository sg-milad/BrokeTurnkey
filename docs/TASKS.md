# WalletMVP — Task List

---

## Phase 1 — Infrastructure (complete ✅)

### 1.1 Docker Compose ✅

Vault + PostgreSQL + NestJS API containers. Internal Docker network
(`walletmvp-network`). Persistent volumes for Vault data and Postgres data.

### 1.2 Vault Shamir unseal ceremony ✅

3 shares, threshold 2. Unseal keys stored in `.env.vault`. Transit engine
enabled. `wallet-dek` key ring created with `exportable=false`. Audit log
enabled. See `docs/VAULT_INIT.md`.

### 1.3 NestJS monorepo scaffold ✅

Single root `package.json`. Six libs: `@app/db`, `@app/vault` (now removed
— see Phase 2), `@app/wallet`, `@app/gas`, `@app/policy`, `@app/auth`.

### 1.4 PostgreSQL schema migrations ✅

Nine tables via Drizzle ORM + `pnpm db:push`. Schema in `docs/schema.dbml`.

---

## Phase 2 — Go Crypto Service + Key Management

### Overview

The Go crypto service is a long-lived HTTP sidecar running in its own Docker
container. It is the single cryptographic boundary of the system. NestJS
never holds a Vault token or any plaintext key material. All key operations
(BIP39 generation, AES-GCM encryption/decryption, BIP32 derivation, RLP
encoding, keccak256 hashing, secp256k1 signing) happen exclusively in Go.

---

### 2.1 Go service infrastructure

Stand up the container and entry point. No crypto logic yet — just the
skeleton that everything else will plug into.

**Deliverables:**

- `go.mod` — add dependencies:
  - `github.com/tyler-smith/go-bip39`
  - `github.com/tyler-smith/go-bip32`
  - `github.com/ethereum/go-ethereum`
- `cmd/crypto/main.go` — reads `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`,
  `CRYPTO_PORT` from env; starts HTTP server; returns `500` on all routes until
  handlers are wired in subsequent tasks
- `Dockerfile.crypto` — multi-stage build: `golang:1.23-alpine` builder,
  minimal `alpine:3.20` runtime, non-root user
- `docker-compose.yml` — add `crypto` service: builds from `Dockerfile.crypto`,
  `env_file: .env`, no host port exposed, on `walletmvp-network`,
  `depends_on: vault`
- `.env` — `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `CRYPTO_PORT`
- create /helath path in nestjs, you should curl crypto:port/health.

**Done when:** `docker compose up` starts the crypto container without errors and /health return 200.

---

### 2.2 Vault client (`cmd/crypto/vault.go`)

Isolated Vault interaction layer. No HTTP handlers, no crypto — just Vault
communication. Can be tested against a live Vault before any wallet logic exists.

**Deliverables:**

- `AppRoleLogin()` — POSTs to `/v1/auth/approle/login`, stores token in memory
- `RenewToken()` — POSTs to `/v1/auth/token/renew-self`, resets renewal timer
- `RotateSecretID()` — POSTs to `/v1/auth/approle/role/wallet-signer/secret-id`,
  writes new SecretID to `.env.crypto` for next restart
- `StartTokenRenewalLoop()` — background goroutine, fires at 75% of token TTL (~45 min)
- `EncryptDEK(dek []byte) (string, error)` — POSTs to `/v1/transit/encrypt/wallet-dek`,
  returns `"vault:v1:..."` ciphertext string
- `DecryptDEK(ciphertext string) ([]byte, error)` — POSTs to
  `/v1/transit/decrypt/wallet-dek`, returns raw 32-byte DEK

**Startup sequence in `main.go`:**

1. `AppRoleLogin()` — consume the SecretID
2. `RotateSecretID()` — generate and persist the next one immediately
3. `StartTokenRenewalLoop()` — start the background renewal goroutine
4. Start HTTP server

**Done when:** `EncryptDEK` and `DecryptDEK` round-trip correctly against a
live Vault instance with the `wallet-signer` AppRole configured.

---

### 2.3 Crypto primitives (`cmd/crypto/crypto.go`)

Pure cryptographic functions. No HTTP, no Vault calls. All functions take
and return plain byte slices. Each can be unit-tested independently.

**Deliverables:**

- `GenerateMnemonic() (string, error)` — 256-bit entropy → 24-word BIP39 mnemonic
- `MnemonicToSeed(mnemonic string) ([]byte, error)` — PBKDF2-HMAC-SHA512 → 64-byte seed
- `GenerateDEK() ([]byte, error)` — `crypto/rand` 32 bytes
- `EncryptSeed(seed, dek []byte) (encryptedSeed, nonce []byte, err error)` — AES-256-GCM
- `DecryptSeed(encryptedSeed, nonce, dek []byte) ([]byte, error)` — AES-256-GCM
- `DeriveAddress(seed []byte, index uint32) (address string, privKey []byte, err error)` —
  BIP32 `m/44'/60'/0'/0/index` → EIP-55 Ethereum address + private key bytes
- `ZeroBytes(b []byte)` — fills slice with zeros; used in every handler via `defer`

**Done when:** unit tests confirm mnemonic → seed → encrypt → decrypt round-trip,
and `DeriveAddress` produces a known address for a known mnemonic and index.

---

### 2.4 Transaction hashing and signing (`cmd/crypto/signing.go`)

Ethereum-specific signing logic, separated from general crypto primitives
because it depends on `go-ethereum` and can be tested against known EIP-1559
test vectors independently.

**Deliverables:**

- `BuildTxHash(txFields TxFields) (txHash []byte, err error)` — RLP-encodes
  the EIP-1559 transaction fields (chainId, nonce, maxFeePerGas,
  maxPriorityFeePerGas, gasLimit, to, value, data), prepends the `0x02` type
  byte, and returns `keccak256(encodedTx)`
- `SignTxHash(txHash, privKey []byte) (signature string, err error)` —
  secp256k1 sign via `go-ethereum/crypto`, returns `0x`-prefixed hex `r+s+v`
- `TxFields` struct — `ChainId`, `Nonce`, `To`, `Value`, `GasLimit`,
  `MaxFeePerGas`, `MaxPriorityFeePerGas`, `Data`

**Done when:** `BuildTxHash` output matches a known EIP-1559 transaction hash
from a reference implementation (e.g. cast from Foundry or ethers.js).

---

### 2.5 HTTP handlers (`cmd/crypto/handlers.go`)

Wire everything together. Each handler calls the Vault client and crypto
primitives from the previous tasks. Memory zeroing via `defer` is mandatory
in every handler regardless of success or failure.

**Deliverables:**

`POST /wallet/create`

```json
// Request
{ "orgId": "uuid" }

// Response
{
  "encryptedSeed": "base64",
  "seedNonce": "base64",
  "encryptedDek": "vault:v1:...",
  "firstAddress": "0x..."
}
```

Flow: `GenerateMnemonic` → `MnemonicToSeed` → `GenerateDEK` → `EncryptSeed`
→ `EncryptDEK` (Vault) → `DeriveAddress(index=0)` → zero seed + DEK + privKey → respond

`POST /wallet/derive`

```json
// Request
{
  "encryptedSeed": "base64",
  "seedNonce": "base64",
  "encryptedDek": "vault:v1:...",
  "derivIndex": 5
}

// Response
{
  "address": "0x...",
  "derivationPath": "m/44'/60'/0'/0/5"
}
```

Flow: `DecryptDEK` (Vault) → `DecryptSeed` → `DeriveAddress(index)` → zero seed + DEK + privKey → respond

`POST /wallet/sign`

```json
// Request
{
  "encryptedSeed": "base64",
  "seedNonce": "base64",
  "encryptedDek": "vault:v1:...",
  "derivationPath": "m/44'/60'/0'/0/5",
  "txFields": {
    "chainId": 1,
    "nonce": 42,
    "to": "0x...",
    "value": "1000000000000000000",
    "gasLimit": 21000,
    "maxFeePerGas": "30000000000",
    "maxPriorityFeePerGas": "1000000000",
    "data": "0x"
  }
}

// Response
{
  "signature": "0x...",
  "txHash": "0x..."
}
```

Flow: `DecryptDEK` (Vault) → `DecryptSeed` → `DeriveAddress(index)` →
`BuildTxHash` → `SignTxHash` → zero seed + DEK + privKey → respond

**Memory zeroing contract:** every handler defers `ZeroBytes` on DEK, seed,
and child private key. This runs whether the handler returns success or error.

**Done when:** all three endpoints return correct responses against a live
Vault and the integration can be verified end-to-end with `curl`.

---

### 2.6 NestJS crypto client (`libs/crypto-client/`)

Thin NestJS module that wraps HTTP calls to the Go crypto service. This is
the only place in NestJS that knows the Go service's address and port.

**Deliverables:**

- Delete `libs/vault/` (or repurpose it as `libs/crypto-client/`)
- `CryptoClientModule` — global NestJS module
- `CryptoClientService` with three methods:
  - `createWallet(orgId: string)` → `{ encryptedSeed, seedNonce, encryptedDek, firstAddress }`
  - `deriveWallet(encryptedSeed, seedNonce, encryptedDek, derivIndex)` → `{ address, derivationPath }`
  - `signTransaction(encryptedSeed, seedNonce, encryptedDek, derivationPath, txFields)` → `{ signature, txHash }`
- Reads `CRYPTO_SERVICE_URL` from NestJS env (e.g. `http://crypto:4000`)
- Remove all Vault env vars from NestJS `.env`

**Done when:** `CryptoClientService.createWallet()` returns a valid response
from the running Go container.

---

### 2.7 WalletService (`libs/wallet/`)

NestJS business logic layer. Coordinates between Postgres and the Go crypto
service. Never touches key material — only ciphertext in, ciphertext out.

**Deliverables:**

`WalletService.onboardorganization(orgId: string)`

- Calls `CryptoClientService.createWallet(orgId)`
- Inserts into `organization_seeds` (encryptedSeed, seedNonce, encryptedDek)
- Inserts first wallet row into `wallets` (address=firstAddress, derivIndex=0)
- Writes `audit_log` entry (`event=org_onboarded`)

`WalletService.deriveWallet(orgId, label, userId?: string)`

- Reads org seed ciphertext from `organization_seeds`
- If `userId` is provided, verifies the user exists and belongs to `orgId`
- Gets next derivation index: `COUNT(*) FROM wallets WHERE orgId=?`
- Calls `CryptoClientService.deriveWallet(ciphertext, index)`
- Inserts new row into `wallets` (address, derivationPath, label, userId=null if omitted)
- Writes `audit_log` entry (`event=wallet_created`)

Note: `userId` is optional. System wallets (treasury, deployer, etc.) are created
without a user assignment. A wallet can be assigned to a user at creation time or
left unassigned indefinitely — `wallets.user_id` is nullable.

`WalletService.requestSign(orgId, walletId, txFields)`

- Reads org seed ciphertext from `organization_seeds`
- Reads `derivationPath` from `wallets WHERE id=walletId`
- Calls `CryptoClientService.signTransaction(ciphertext, derivationPath, txFields)`
- Inserts into `signing_requests` (walletId, txHash, status=signed)
- Writes `audit_log` entry (`event=tx_signed`)
- Returns `{ signature, txHash }`

---

### 2.8 API routes

Wire up NestJS controllers. Stamp verification guard applied to all routes.

**Deliverables:**

`StampVerifierGuard` from `@app/auth` applied globally or per-controller.

**organizations**

- `POST /organizations` → create org record
- `POST /organizations/:id/onboard` → `WalletService.onboardorganization()`
- `GET /organizations/:id` → fetch org details

**Users**

- `POST /organizations/:id/users` → create a user within an org
- `GET /organizations/:id/users` → list all users in an org
- `GET /organizations/:id/users/:userId` → get user details
- `DELETE /organizations/:id/users/:userId` → deactivate user

**Wallets**

- `POST /wallets` → `WalletService.deriveWallet()` — `userId` is optional in the
  request body; omit for system wallets (treasury, deployer, etc.)
- `GET /organizations/:id/wallets` → list all wallets for an org; returns `walletId`
  and `address` only (no derivation paths exposed)
- `GET /organizations/:id/users/:userId/wallets` → list wallets assigned to a specific user
- `GET /wallets/:id` → get single wallet (`walletId`, `address`, `label`, `userId` if set)
- `PATCH /wallets/:id` → update `label` only

**Signing**

- `POST /wallets/:id/sign` → `WalletService.requestSign()`
- `GET /wallets/:id/signing-requests` → signing history for a wallet
- `GET /organizations/:id/signing-requests` → all signing activity for an org

**Audit**

- `GET /organizations/:id/audit-log` → paginated audit log; supports filtering by
  `event` type and date range

**API Keys**

- `POST /organizations/:id/api-keys` → create an API key; returns public key for
  stamp setup
- `GET /organizations/:id/api-keys` → list active keys
- `DELETE /organizations/:id/api-keys/:keyId` → revoke a key

**Policies**

- `POST /organizations/:id/policies` → create a policy rule
- `GET /organizations/:id/policies` → list all rules for an org
- `DELETE /organizations/:id/policies/:policyId` → delete a rule

---

## Phase 3 — Gas, Nonce, and Broadcast

### 3.1 GasService (`libs/gas/`)

**Deliverables:**

- `GasService.estimateFees(txPayload)` — calls free RPC for gas limit and fee data
- `GasService.getNextNonce(walletId)` — reads and locks nonce from `wallet_nonces`
- `GasService.broadcastTransaction(signedTx)` — sends via `eth_sendRawTransaction`
- `GasService.incrementNonce(walletId)` — updates nonce after successful broadcast

---

## Phase 4 — Policy Engine

### 4.1 PolicyEngine (`libs/policy/`)

**Deliverables:**

- `PolicyEngine.evaluate(orgId, walletId, txPayload)` — returns allow/deny
- Rule types: spend limit (per-tx), rolling spend window (24h), address allowlist,
  address blocklist, time lock (hours of day)
- Rules stored in `policies` table, evaluated in NestJS before any signing call

---

## Phase 5 — Auth

### 5.1 StampVerifier (`libs/auth/`)

**Deliverables:**

- `StampVerifier` NestJS guard
- Parses `X-Stamp` header (P-256 signature over request body + timestamp)
- Looks up API key public key from `api_keys` table
- Verifies signature, rejects replays (timestamp window check)

---

## Deferred / Post-MVP

- WebAuthn API key support
- Vault Transit key rotation background job (rewrap all DEKs from v1 to v2)
- Key export flow (explicit user consent, separate secure channel)
- Rate limiting per API key
- Multi-chain support (chain IDs other than Ethereum mainnet)
- Monitoring / alerting on Vault seal state
