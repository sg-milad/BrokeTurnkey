# WalletMVP — Engineering Roadmap

Each phase has a clear goal, a reason it exists, concrete deliverables, and a definition of done. Phases build sequentially — completing each one leaves the system in a working, testable state before the next begins.

---

## Phase 1 — Infrastructure ✅

**Goal:** A running, networked set of containers that every subsequent phase builds on.

**Why it exists:** Nothing else can be built until the persistence layer, secrets manager, and application container are up and communicating correctly on an isolated internal network.

### Deliverables

- Docker Compose with four services: `vault`, `postgres`, `crypto`, `api` on a shared internal network (`walletmvp-network`)
- Persistent named volumes for Vault data and Postgres data
- Vault initialised with 3 Shamir unseal shares, threshold 2. Unseal keys stored in `.env.vault` (not committed). Transit engine enabled. `wallet-dek` key ring created with `exportable=false` and `allow_plaintext_backup=false`. Audit log enabled to `/vault/logs/audit.log`
- PostgreSQL schema deployed via Drizzle ORM (`pnpm db:push`). Nine tables: `organizations`, `users`, `api_keys`, `organization_seeds`, `wallets`, `signing_requests`, `wallet_nonces`, `policies`, `audit_log`
- NestJS monorepo scaffold: single root `package.json`, libs directory, `apps/api` entry point
- Go crypto service container: multi-stage Docker build, non-root user, internal port only, `GET /health` returns 200
- `scripts/unseal.sh` — sources `.env.vault`, submits keys 1 and 2 automatically on restart

**Done when:** `docker compose up -d` starts all four containers without errors. `GET /health` on the Go service returns 200. Vault status shows `Sealed: false`.

---

## Phase 2 — Secure Key Management ✅

**Goal:** The Go crypto service can generate, encrypt, derive, and sign — and NestJS can coordinate it without ever seeing plaintext key material.

**Why it exists:** This is the core security model of the entire system. The cryptographic boundary must be established before any wallet or signing functionality is built on top of it.

### Deliverables

**Go crypto service (`cmd/crypto/`)**

- `vault.go` — Vault client: AppRole login, token renewal loop (fires at 75% of TTL), SecretID rotation on startup, `EncryptDEK`, `DecryptDEK`
- `crypto.go` — pure cryptographic primitives: `GenerateMnemonic`, `MnemonicToSeed`, `GenerateDEK`, `EncryptSeed`, `DecryptSeed`, `DeriveAddress`, `ZeroBytes`
- `signing.go` — Ethereum signing: `BuildTxHash` (EIP-1559 RLP encoding + keccak256), `SignTxHash` (secp256k1)
- `handlers.go` — HTTP handlers: `POST /wallet/create`, `POST /wallet/derive`, `POST /wallet/sign`. Every handler defers `ZeroBytes` on all key material regardless of success or error

**NestJS (`libs/`)**

- `@app/crypto-client` — `CryptoClientService`: thin HTTP wrapper around the three Go endpoints. The only place in NestJS that knows the Go service address
- `@app/wallet` — `WalletService`: `onboardOrganization`, `deriveWallet`, `requestSign`. Reads and writes only ciphertext. Coordinates with `@app/crypto-client` and `@app/db`

**API routes (`apps/api/`)**

- `POST /organizations` — create organization record
- `POST /organizations/:id/onboard` — generate seed, store ciphertext, create first wallet
- `POST /wallets` — derive a new child wallet (userId optional — system wallets are created without one)
- `GET /organizations/:id/wallets` — list wallets (address only, no derivation paths)
- `GET /wallets/:id` — single wallet detail
- `POST /wallets/:id/sign` — sign a transaction
- `GET /wallets/:id/signing-requests` — signing history
- `GET /organizations/:id/signing-requests` — all signing activity for an org

**Done when:** End-to-end flow works: onboard an org, derive a wallet, sign a transaction, confirm the signature is valid against the derived address using `cast wallet verify` or equivalent.

---

## Phase 3 — Transaction Lifecycle

**Goal:** The system can estimate gas, manage nonces, broadcast signed transactions, and track confirmation status with full error recovery.

**Why it exists:** Signing a transaction is half the job. The platform must be able to take a signed transaction all the way to the chain and confirm it landed. Nonce management is a correctness requirement — without it, transactions collide or get stuck.

### Deliverables

**Database schema updates**

- `signing_requests` table gains columns:
  - `status` — enum: `'pending' | 'signed' | 'broadcasted' | 'confirmed' | 'failed' | 'dropped'`
  - `tx_hash` — set after successful broadcast (nullable)
  - `block_number` — set after confirmation (nullable)
  - `gas_used` — from receipt (nullable)
  - `effective_gas_price` — from receipt (nullable)
  - `error_message` — populated on failure (nullable)
  - `error_type` — enum: `'retryable' | 'permanent' | 'unknown'` for classification
  - `idempotency_key` — unique constraint, derived from `{ walletId, nonce, to, value, data }`
- `wallet_nonces` table gains columns:
  - `reserved_at` — timestamp when nonce was reserved (nullable)
  - `reservation_expires_at` — TTL for nonce reservation (default: 5 minutes)
  - `chain_id` — nonces are per-wallet per-chain

**`@app/gas` — GasService**

- `estimateFees(to, value, data, chainId)` — calls RPC for `eth_estimateGas` and `eth_feeHistory` (EIP-1559 fee data). Applies a 20% buffer to gas limit for safety. Returns `{ gasLimit, maxFeePerGas, maxPriorityFeePerGas }`
- `reserveNonce(walletId, chainId)` — atomically increments `wallet_nonces.next_nonce` within a transaction and returns the reserved value. Sets `reserved_at` and `reservation_expires_at`. If reservation expires without broadcast, a background job releases it
- `releaseNonce(walletId, chainId, nonce)` — decrements nonce if reservation expired or broadcast failed before confirmation. Called by cleanup job
- `confirmNonce(walletId, chainId, nonce)` — marks nonce as permanently used after receipt confirmation. Clears reservation fields
- `getRpcProvider(chainId)` — returns an RPC provider from a configured list with failover. Tries providers in order, skips failed ones, rotates on errors
- `broadcastTransaction(signedTxHex, chainId)` — submits via `eth_sendRawTransaction` using the selected RPC provider. Returns `txHash`. Implements retry logic for transient network errors (up to 3 attempts with exponential backoff)
- `waitForReceipt(txHash, chainId, timeoutMs)` — polls `eth_getTransactionReceipt` every 2 seconds until confirmed or timeout. After timeout, checks `eth_getTransactionByHash` to determine if tx is pending or dropped
- `classifyError(error)` — categorizes RPC/broadcast errors into `'retryable'` (network timeout, RPC down), `'permanent'` (insufficient funds, invalid signature, contract revert), or `'unknown'`
- `speedUpTransaction(walletId, chainId, originalTxHash, multiplier)` — creates a replacement transaction with higher gas (multiplier applied to maxFee and maxPriorityFee). Uses same nonce. Requires original tx to still be pending

**Background jobs**

- **Nonce reservation cleanup** — runs every 60 seconds, finds expired reservations (`reservation_expires_at < NOW()`), releases them by decrementing nonce, updates `signing_requests.status = 'dropped'`
- **Pending transaction monitor** — runs every 30 seconds, checks all `signing_requests` with `status = 'broadcasted'` and no receipt. Polls RPC to detect dropped transactions (not in mempool after 10 minutes), marks as `'dropped'`, releases nonce for retry
- **Stuck transaction detector** — identifies transactions pending > 5 minutes with low gas. Emits alert and suggests speed-up parameters

**Updated `POST /wallets/:id/sign` flow**

The sign endpoint now runs the full lifecycle with idempotency and error recovery:

1. **Idempotency check** — compute key from `{ walletId, to, value, data, chainId }`. If a signing request with this key exists and is not `'failed'`, return it immediately
2. **Estimate fees** — call `estimateFees` with 20% gas buffer
3. **Reserve nonce** — call `reserveNonce` atomically. Creates `signing_requests` row with `status = 'pending'`
4. **Sign transaction** — call Go sidecar with nonce and fee params. On success, update `status = 'signed'`
5. **Broadcast** — call `broadcastTransaction` with retry logic. On success, set `tx_hash`, update `status = 'broadcasted'`. On permanent failure, set `status = 'failed'`, release nonce, return error. On retryable failure after max retries, set `status = 'failed'`, release nonce
6. **Wait for receipt** — call `waitForReceipt`. On confirmation, set `block_number`, `gas_used`, `effective_gas_price`, update `status = 'confirmed'`, call `confirmNonce`. On timeout with tx still pending, leave as `'broadcasted'` for background monitor. On timeout with tx dropped, set `status = 'dropped'`, release nonce
7. **Return** — `{ txHash, status, receipt? }`

All steps are wrapped in a database transaction where appropriate. Nonce reservation and signing request creation happen atomically.

**RPC configuration**

- Multiple RPC providers per chain configured via environment variables (e.g., `RPC_BASE_SEPOLIA_1`, `RPC_BASE_SEPOLIA_2`)
- Provider health checked on startup and periodically
- Automatic failover: if primary provider fails 3 consecutive requests, switch to secondary
- Rate limiting awareness: respect provider rate limits, implement request queuing if needed

**Error handling strategy**

- **Retryable errors** (RPC timeout, network error): retry up to 3 times with exponential backoff (1s, 2s, 4s). If still failing, mark as `'failed'` with `error_type = 'retryable'`, release nonce
- **Permanent errors** (insufficient funds, invalid signature, nonce too low): immediately mark as `'failed'` with `error_type = 'permanent'`, release nonce, return descriptive error to client
- **Unknown errors**: mark as `'failed'` with `error_type = 'unknown'`, release nonce, log for investigation
- **Timeout during waitForReceipt**: check if tx exists on-chain. If yes, leave as `'broadcasted'` for background monitor. If no, mark as `'dropped'`, release nonce

**API response format**

```json
{
  "signingRequestId": "uuid",
  "status": "confirmed",
  "txHash": "0x...",
  "nonce": 42,
  "blockNumber": 12345678,
  "gasUsed": "21000",
  "effectiveGasPrice": "30000000000",
  "idempotencyKey": "hash-of-inputs"
}
```

For failures:

```json
{
  "signingRequestId": "uuid",
  "status": "failed",
  "errorType": "permanent",
  "errorMessage": "insufficient funds for gas * price + value",
  "nonceReleased": true
}
```

**Done when:**
- A signed transaction reaches a testnet (Base Sepolia) and `eth_getTransactionReceipt` returns a success receipt
- Nonce increments correctly in the database and is never reused
- A second transaction from the same wallet submits without collision
- A failed broadcast releases the nonce for reuse
- An expired nonce reservation is automatically cleaned up
- A stuck transaction is detected and reported
- Duplicate signing requests return the existing result (idempotency)
- RPC failover works when primary provider is down
- Error classification correctly distinguishes retryable vs permanent failures

---

## Phase 4 — Enterprise Security

**Goal:** Organizations can configure signing policies, all administrative actions are logged, and API access is authenticated with cryptographic stamps.

**Why it exists:** A custody platform without access control and auditing is not a custody platform. These three features — policy engine, audit log, stamp authentication — are what separate a key-signing service from an enterprise WaaS.

### Deliverables

**`@app/policy` — PolicyEngine**

- `evaluate(orgId, walletId, txPayload)` → `{ decision: 'allow' | 'deny', reason?: string }`
- Rule types evaluated in order:
  - Address blocklist — reject if `to` is on the org's blocklist
  - Address allowlist — reject if `to` is not on the org's allowlist (when allowlist is non-empty)
  - Per-transaction spend limit — reject if `value` exceeds the configured maximum
  - Rolling 24-hour spend window — reject if cumulative value in the last 24h would exceed the limit
  - Time lock — reject if current UTC time is outside the configured signing window
- Rules stored in the `policies` table. Evaluated in NestJS before any call to the Go service

**API routes for policy management**

- `POST /organizations/:id/policies` — create a rule
- `GET /organizations/:id/policies` — list all rules
- `DELETE /organizations/:id/policies/:policyId` — delete a rule

**`@app/auth` — StampVerifier**

- `StampVerifierGuard` — NestJS guard applied globally
- Parses `X-Stamp: <base64url(sig)>.<timestamp_ms>.<key_id>`
- Rejects if timestamp is older than 5 minutes or more than 30 seconds in the future
- Looks up `api_keys` by `key_id`, checks `status = active` and `expires_at`
- Reconstructs the signed payload: `timestamp + "." + base64url(SHA-256(body))`
- Verifies P-256 (ES256) signature against the registered public key
- Attaches `{ orgId, apiKeyId }` to the request context on success

**API key management routes**

- `POST /organizations/:id/api-keys` — register a public key. First key uses a one-time bootstrap token (`X-Bootstrap-Token`). Subsequent keys require a valid stamp from a key with `key:write` scope
- `GET /organizations/:id/api-keys` — list active keys
- `DELETE /organizations/:id/api-keys/:keyId` — revoke a key

**User management routes**

- `POST /organizations/:id/users`
- `GET /organizations/:id/users`
- `GET /organizations/:id/users/:userId`
- `DELETE /organizations/:id/users/:userId`

**Audit log**

- Every signing request, policy evaluation, wallet creation, and key management action writes a row to `audit_log`
- `GET /organizations/:id/audit-log` — paginated, filterable by `event` type and date range

**Done when:** A signing request blocked by policy returns 403 with a reason. A valid stamp authenticates successfully. A replayed stamp is rejected. The audit log records all events end-to-end.

---

## Phase 5 — Typed Signing

**Goal:** The Go crypto service becomes a general-purpose signing service, not an Ethereum-transaction-specific one. It can sign any EIP-712 structured data hash.

**Why it exists:** Real custody platforms sign far more than raw transactions. EIP-712 structured data signing is required for permits, off-chain approvals, typed messages, and Sign-In With Ethereum. Making the Go service a generic hash signer is the correct abstraction — the application layer constructs the hash, the signing service signs it.

### Deliverables

**Go crypto service**

- Rename `POST /wallet/sign` to `POST /wallet/sign-transaction` (backward-compatible alias)
- Add `POST /wallet/sign-hash` — accepts a raw 32-byte hash (`hashHex`) and the seed ciphertext. Derives the key, signs the hash directly with secp256k1, returns the signature. No encoding, no interpretation — the Go service signs whatever hash it receives
- The hash construction (EIP-712 domain separator, struct hash, final hash) always happens in NestJS or the calling service — Go is not aware of the schema

**NestJS**

- `CryptoClientService.signHash(encryptedSeed, seedNonce, encryptedDek, derivationPath, hashHex)` → `{ signature }`
- `SigningService` in `@app/wallet`:
  - `signEip712(orgId, walletId, domain, types, value)` — constructs the EIP-712 hash using viem's `hashTypedData`, calls `signHash`
  - `signPersonalMessage(orgId, walletId, message)` — constructs the personal sign prefix hash, calls `signHash`

**API routes**

- `POST /wallets/:id/sign-typed` — EIP-712 structured data signing. Body: `{ domain, types, primaryType, message }`
- `POST /wallets/:id/sign-message` — personal message signing. Body: `{ message }`

**Done when:** A typed data hash constructed with viem's `hashTypedData` can be signed by the Go service and the recovered address matches the wallet's EOA address. A Sign-In With Ethereum message can be signed and verified.

---

## Phase 6 — Multi-Chain Support

**Goal:** The platform supports multiple EVM chains without duplicating logic per chain.

**Why it exists:** A WaaS that only works on one chain is not useful in practice. The gas and broadcast layer must be chain-aware. The signing layer is already chain-agnostic (chainId is a parameter).

### Deliverables

**Chain abstraction**

- `ChainConfig` type: `{ chainId, name, rpcUrl, blockExplorerUrl, nativeCurrency }`
- `SUPPORTED_CHAINS` registry: Ethereum mainnet, Base, Optimism, Arbitrum, Polygon. Loaded from environment configuration
- `ChainService` in `@app/gas`: resolves a chain config from `chainId`, selects the correct RPC endpoint

**`@app/gas` updates**

- All methods accept `chainId` as a parameter
- `wallet_nonces` table gains a `chain_id` column — nonces are per-wallet per-chain
- `broadcastTransaction` routes to the correct RPC based on `chainId`

**API updates**

- `POST /wallets/:id/sign-transaction` body gains `chainId` (was previously optional, now explicit)
- `GET /wallets/:id/signing-requests` returns `chainId` on each row

**Done when:** The same wallet address can sign and broadcast transactions on Base Sepolia and Ethereum Sepolia in the same test run, with correct independent nonce tracking per chain.

---

## Phase 7 — Smart Accounts (ERC-4337)

**Goal:** Organizations can optionally create ERC-4337 smart account wallets in addition to EOA wallets. The EOA from the Go crypto service becomes the owner key of the smart account. Gas sponsorship is handled via a Paymaster.

**Why it exists:** Smart accounts are the current industry direction for programmable wallet infrastructure. Session keys, batched transactions, and gas sponsorship require account abstraction. This phase adds smart accounts as an optional wallet type — existing EOA wallets are preserved and unchanged.

**This is an extension, not a replacement.** The encryption model, Go signing service, Vault, and BIP39 derivation are all unchanged. The EOA derived by the Go sidecar is reused as the smart account owner key.

### Wallet model comparison

```
EOA Wallet (existing)
  BIP32 child key → EOA address = user's wallet
  Transactions signed and broadcast by the platform
  Gas paid by the EOA — must hold ETH

Smart Account Wallet (Phase 7)
  BIP32 child key → EOA address = owner key (internal)
  EOA owns a SimpleAccount contract = user's wallet
  UserOperations signed by the EOA owner key
  Gas paid by a Paymaster — user needs no ETH
```

### Deliverables

**Contracts (`contracts/`)**

- `SimpleAccount.sol` — ERC-4337 smart account. Implements `validateUserOp` (verifies owner EOA signature) and `execute` (forwards calls to target contracts). Based on the eth-infinitism reference implementation
- `SimpleAccountFactory.sol` — deterministic factory using `CREATE2`. `getAddress(owner, salt)` returns the counterfactual address before deployment. `createAccount(owner, salt)` deploys if not yet deployed
- Foundry project: `foundry.toml`, `script/Deploy.s.sol`

**Go crypto service**

- `POST /wallet/sign-hash` from Phase 5 covers UserOp signing without modification — a UserOp hash is just a 32-byte hash. No new Go endpoint needed

**`@app/smart-account` (new lib)**

- `SmartAccountFactory` — wraps `factory.getAddress(ownerEOA, salt)` using viem. Computes counterfactual address deterministically
- `UserOpBuilder` — constructs the full `UserOperation` struct: `sender`, `nonce` (read from EntryPoint), `initCode` (on first UserOp, includes factory calldata to deploy the account), `callData` (encodes `SmartAccount.execute`), gas limits (fetched via `eth_estimateUserOperationGas`), `paymasterAndData` (Pimlico verifying paymaster)
- `BundlerClient` — wraps Pimlico's Bundler RPC using viem's `bundlerActions`: `eth_estimateUserOperationGas`, `eth_sendUserOperation`, `eth_getUserOperationReceipt`
- `UserOpHash` — computes `keccak256(abi.encode(userOp, entryPointAddress, chainId))` using viem

**`@app/wallet` updates**

- `deriveWallet` extended: when `type = 'smart-account'`, computes the counterfactual `SimpleAccount` address and stores it in `wallets.smart_account_address`. Sets `wallets.smart_account_deployed = false`
- `SmartAccountService.sendUserOp(orgId, walletId, target, value, calldata)` — orchestrates the full UserOp flow: build → hash → sign → submit to Bundler → poll receipt. Sets `smart_account_deployed = true` on first successful UserOp

**Database**

- `wallets.wallet_type` — enum: `eoa` (default) | `smart-account`
- `wallets.smart_account_address` — the `SimpleAccount` contract address (nullable, set on creation for smart-account type)
- `wallets.smart_account_deployed` — boolean, false until the first UserOp goes through

**API routes**

- `POST /wallets` — `type` field added to body: `'eoa'` (default, existing behaviour) | `'smart-account'`
- `POST /wallets/:id/userop` — build and submit a UserOperation. Body: `{ to, value, data, chainId }`. Returns `{ userOpHash }`
- `GET /wallets/:id/userop/:userOpHash` — poll UserOp receipt from the Bundler

**External dependencies**

- Pimlico account (free) — provides Bundler RPC and verifying Paymaster on Base Sepolia and other testnets
- EntryPoint contract at `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` — canonical, already deployed on all major EVM chains

**Done when:** A smart account wallet is created (counterfactual address stored in DB). USDC is sent to the smart account address. A UserOp is submitted that transfers USDC to another address. The Bundler confirms the UserOp. The `smart_account_deployed` flag is set to true. The gas was paid by the Pimlico Paymaster, not the smart account.

---

## Phase 8 — Hardening and Observability

**Goal:** The platform is observable, operable, and resilient enough to run unattended.

**Why it exists:** An infrastructure project without monitoring and rate limiting cannot be operated in practice. These features are not optional for a system managing signing keys.

### Deliverables

**Rate limiting**

- Per-API-key rate limiting on the stamp verifier guard
- Configurable limits per key via `api_keys.rate_limit_rpm` (requests per minute)
- Returns `429 Too Many Requests` with a `Retry-After` header on breach

**Vault key rotation**

- Background job: reads all `organization_seeds` rows, calls `transit/decrypt` (old version) then `transit/encrypt` (new version) for each DEK, writes the new ciphertext back to Postgres
- Triggered manually via `POST /admin/rotate-deks` (admin-only route, separate API key scope)
- Job progress tracked in a `key_rotation_jobs` table: `{ id, startedAt, completedAt, totalOrgs, processedOrgs, status }`

**Webhook system**

- `webhooks` table: `{ id, orgId, url, secret, events[], status }`
- Events: `wallet.created`, `tx.signed`, `tx.confirmed`, `tx.failed`, `policy.denied`
- Outbound HTTP POST to registered URLs with HMAC-SHA256 signature in `X-Webhook-Signature` header
- Retry with exponential backoff on delivery failure (up to 3 attempts)
- `POST /organizations/:id/webhooks` — register a webhook
- `GET /organizations/:id/webhooks` — list webhooks
- `DELETE /organizations/:id/webhooks/:webhookId` — deactivate

**Metrics and health**

- `GET /health` — liveness: returns 200 if API is up, Postgres is reachable, and Go crypto service is reachable
- `GET /ready` — readiness: same as health plus Vault seal check
- Prometheus-compatible metrics endpoint at `/metrics`: request count, signing latency histogram, policy denial rate, Vault call latency

**Vault seal monitoring**

- Background poller: checks `GET /v1/sys/health` on Vault every 60 seconds
- If Vault is sealed, emits a structured log event and fires a webhook event `vault.sealed` to all orgs

**Done when:** Rate limiting rejects excess requests with the correct headers. The DEK rotation job completes against a live Vault without data loss. Webhook events are delivered and verifiable with the HMAC signature. The `/health` endpoint correctly reflects the state of all downstream dependencies.
