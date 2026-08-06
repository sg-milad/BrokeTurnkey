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

- `POST /organizations` — create organization and auto-onboard (generate seed, store ciphertext, create first wallet, return bootstrap token)
- `POST /wallets` — derive a new child wallet (userId optional — system wallets are created without one)
- `GET /wallets` — list wallets for the authenticated org (address only, no derivation paths)
- `GET /wallets/:id` — single wallet detail
- `POST /wallets/:id/sign` — sign a transaction
- `GET /wallets/:id/signing-requests` — signing history
- `GET /wallets/:id/signing-requests` — all signing activity for an org

**Done when:** End-to-end flow works: onboard an org, derive a wallet, sign a transaction, confirm the signature is valid against the derived address using `cast wallet verify` or equivalent.

---

## Phase 3 — Transaction Lifecycle ✅

**Goal:** The system can estimate gas, manage nonces, broadcast signed transactions, and track confirmation status with full error recovery.

**Why it exists:** Signing a transaction is half the job. The platform must be able to take a signed transaction all the way to the chain and confirm it landed. Nonce management is a correctness requirement — without it, transactions collide or get stuck.

### Deliverables

**Database schema prerequisites (Phase 1)**

The following tables must exist before Phase 4 begins:

- `api_keys` table with columns: `id`, `org_id`, `name`, `public_key`, `key_id`, `scopes` (jsonb array, e.g., `["wallet:sign", "key:write"]`; default `["*"]`), `status`, `last_used_at`, `expires_at`, `created_at`, `revoked_at`
- `policies` table with columns: `id`, `org_id`, `name`, `description`, `rule_type`, `rule_config` (jsonb), `applies_to`, `target_id`, `priority`, `status`, `created_at`, `updated_at`
- `audit_log` table with columns: `id`, `org_id`, `user_id`, `wallet_id`, `api_key_id`, `event`, `status`, `metadata` (jsonb), `ip_address`, `user_agent`, `created_at`
- `users` table with columns: `id`, `org_id`, `external_id`, `email`, `role`, `status`, `created_at`, `updated_at`
- `organizations` table gains column: `bootstrap_token_hash` (varchar, nullable) — stores SHA-256 hash of one-time bootstrap token

**Database schema updates (Phase 3 → Phase 4)**

- `signing_requests` table gains columns:
  - `status` — enum: `'pending' | 'signed' | 'broadcasted' | 'confirmed' | 'failed' | 'dropped'`
  - `tx_hash` — set after successful broadcast (nullable)
  - `block_number` — set after confirmation (nullable)
  - `gas_used` — from receipt (nullable)
  - `effective_gas_price` — from receipt (nullable)
  - `error_message` — populated on failure (nullable)
  - `error_type` — enum: `'retryable' | 'permanent' | 'unknown'` for classification
  - `idempotency_key` — unique constraint, derived from
    `{ walletId, chainId, to, value, data }` (no nonce — the server reserves
    nonces; see below)
- `wallet_nonces` table: `chain_id` column added (nonces are per-wallet
  per-chain). The `reserved_at` / `reservation_expires_at` columns from the
  earlier design were **not** implemented — see the reserveNonce note above.

**`@app/gas` — GasService**

- `estimateFees(to, value, data, chainId)` — calls RPC for `eth_estimateGas` and `eth_feeHistory` (EIP-1559 fee data). Applies a 20% buffer to gas limit for safety. Returns `{ gasLimit, maxFeePerGas, maxPriorityFeePerGas }`
- `reserveNonce(walletId, chainId)` — **implemented as a single atomic
  `INSERT ... ON CONFLICT` upsert** that increments the per-wallet counter and
  returns the reserved value. The reservation is **permanent**: concurrent
  requests can never observe the same nonce, and a failed broadcast leaves a
  gap rather than reusing the nonce. (The earlier design — a `FOR UPDATE`
  lock with `reserved_at`/`reservation_expires_at` TTLs and a cleanup job
  that releases expired reservations — was simplified away because the lock
  could not span the sign+broadcast window and the release path introduced
  reuse races. There is no release path today.)
- No `releaseNonce` / `confirmNonce` methods — the nonce is consumed at
  reservation time and there is nothing to release.
- `getRpcProvider(chainId)` — returns an RPC provider from a configured list with failover. Tries providers in order, skips failed ones, rotates on errors
- `broadcastTransaction(signedTxHex, chainId)` — submits via `eth_sendRawTransaction` using the selected RPC provider. Returns `txHash`. Implements retry logic for transient network errors (up to 3 attempts with exponential backoff)
- `waitForReceipt(txHash, chainId, timeoutMs)` — polls `eth_getTransactionReceipt` every 2 seconds until confirmed or timeout. After timeout, checks `eth_getTransactionByHash` to determine if tx is pending or dropped
- `classifyError(error)` — categorizes RPC/broadcast errors into `'retryable'` (network timeout, RPC down), `'permanent'` (insufficient funds, invalid signature, contract revert), or `'unknown'`
- `speedUpTransaction(walletId, chainId, originalTxHash, multiplier)` — creates a replacement transaction with higher gas (multiplier applied to maxFee and maxPriorityFee). Uses same nonce. Requires original tx to still be pending

**Background jobs**

- **Not implemented yet:** nonce reservation cleanup (no reservations to
  clean up — nonces are consumed permanently at reservation time), pending
  transaction monitor, stuck transaction detector. Broadcast confirmation is
  handled synchronously in the request path (`waitForReceipt`).

**Updated `POST /wallets/:id/sign` flow**

The sign endpoint now runs the full lifecycle with idempotency and error recovery:

1. **Idempotency check** — compute key from `{ walletId, chainId, to, value, data }`.
   If a signing request with this key exists and is not `'failed'`, return it
   immediately. A **unique index** on `idempotency_key` arbitrates concurrent
   duplicates; a previously failed row is reset and reused on retry
2. **Estimate fees** — call `estimateFees` with 20% gas buffer
3. **Reserve nonce** — call `reserveNonce` atomically (permanent reservation,
   see above). Creates the `signing_requests` row with `status = 'pending'`
4. **Sign transaction** — call Go sidecar with nonce and fee params. On
   success, update `status = 'signed'`
5. **Broadcast** — call `broadcastTransaction` with retry logic. On success,
   set `tx_hash`, update `status = 'broadcasted'`. On failure, set
   `status = 'failed'` and return a sanitized error — the nonce is **not**
   released (it was consumed at reservation time; a gap is left)
6. **Wait for receipt** — call `waitForReceipt`. On confirmation, set
   `block_number`, `gas_used`, `effective_gas_price`, update
   `status = 'confirmed'`. On timeout, leave as `'broadcasted'` for the
   pending monitor
7. **Return** — `{ txHash, status, receipt? }`

All steps are wrapped in a database transaction where appropriate. Nonce reservation and signing request creation happen atomically.

**RPC configuration**

- Multiple RPC providers per chain configured via environment variables (e.g., `RPC_BASE_SEPOLIA_1`, `RPC_BASE_SEPOLIA_2`)
- Provider health checked on startup and periodically
- Automatic failover: if primary provider fails 3 consecutive requests, switch to secondary
- Rate limiting awareness: respect provider rate limits, implement request queuing if needed

**Error handling strategy**

- **Retryable errors** (RPC timeout, network error): retry up to 3 times with exponential backoff (1s, 2s, 4s). If still failing, mark as `'failed'` with `error_type = 'retryable'` and return a sanitized error. The nonce is **not** released (it was consumed at reservation time — a gap is left rather than risking reuse)
- **Permanent errors** (insufficient funds, invalid signature, nonce too low): immediately mark as `'failed'` with `error_type = 'permanent'`, return a sanitized error
- **Unknown errors**: mark as `'failed'` with `error_type = 'unknown'`, log for investigation
- **Timeout during waitForReceipt**: check if tx exists on-chain. If yes, leave as `'broadcasted'` for the pending monitor (not implemented yet — see Background jobs above). If no, mark as `'dropped'`

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

## Phase 4 — Enterprise Security ✅

**Goal:** Organizations can configure signing policies, all administrative actions are logged, and API access is authenticated with cryptographic stamps.

**Why it exists:** A custody platform without access control and auditing is not a custody platform. These three features — policy engine, audit log, stamp authentication — are what separate a key-signing service from an enterprise WaaS.

### Deliverables

**`@app/db/repositories` — New repositories**

- `PolicyRepository` — CRUD operations for policies, query by org_id and status
- `ApiKeyRepository` — CRUD operations for API keys, lookup by key_id, scope validation helpers

**`@app/policy` — PolicyEngine**

- `PolicyService` with methods:
  - `createPolicy(orgId, policyData)` — create a new policy rule
  - `listPolicies(orgId)` — list all active policies for an org
  - `deletePolicy(orgId, policyId)` — delete a policy
  - `evaluate(orgId, walletId, txPayload)` → `{ decision: 'allow' | 'deny', reason?: string }`
- Rule types evaluated in order:
  - Address blocklist — reject if `to` is on the org's blocklist
  - Address allowlist — reject if `to` is not on the org's allowlist (when allowlist is non-empty)
  - Per-transaction spend limit — reject if `value` exceeds the configured maximum
  - Rolling 24-hour spend window — reject if cumulative value in the last 24h would exceed the limit
  - Time lock — reject if current UTC time is outside the configured signing window
- Rules stored in the `policies` table. Evaluated in NestJS BEFORE nonce reservation and signing request creation to avoid wasting nonces on denied transactions
- Policy evaluation result logged to `audit_log` with event `policy_evaluation`

**API routes for policy management**

- `POST /policies` — create a rule
- `GET /policies` — list all rules
- `DELETE /policies/:policyId` — delete a rule

**`@app/auth` — StampVerifier**

- `AuthService` with methods:
  - `registerApiKey(orgId, name, publicKey, scopes)` — register a new API key (requires bootstrap token or key:write scope)
  - `listApiKeys(orgId)` — list active API keys
  - `revokeApiKey(orgId, keyId)` — revoke an API key
  - `validateBootstrapToken(orgId, token)` — validate one-time bootstrap token
  - `generateBootstrapToken(orgId)` — generate one-time bootstrap token
- `StampVerifierGuard` — NestJS guard applied globally
- Parses `X-Stamp: <base64url(sig)>.<timestamp_ms>.<key_id>`
- Rejects if timestamp is older than 5 minutes or more than 30 seconds in the future
- Looks up `api_keys` by `key_id`, checks `status = active`, `expires_at`, and validates scopes for sensitive operations
- Reconstructs the signed payload: `timestamp + "." + base64url(SHA-256(body))`
- Verifies P-256 (ES256) signature against the registered public key
- Attaches `{ orgId, apiKeyId, scopes }` to the request context on success
- Scope validation: operations like creating/deleting API keys require
  `key:write` scope; signing requires `wallet:sign` scope. Scope names follow
  `docs/STAMP_AUTH.md` (e.g. `wallet:create`, `wallet:sign`, `wallet:read`,
  `policy:write`, `key:write`, `*`).

**API key management routes**

- `POST /api-keys` — register a public key with scopes (e.g., `["wallet:sign", "key:write"]`). First key uses a one-time bootstrap token (`X-Bootstrap-Token`) generated during org creation and stored hashed in `organizations.bootstrap_token_hash`. Subsequent keys require a valid stamp from a key with `key:write` scope
- `GET /api-keys` — list active keys
- `DELETE /api-keys/:keyId` — revoke a key (requires `key:write` scope)

**Bootstrap token mechanism**

- Generated during `POST /organizations` (auto-onboard) as a UUID v4
- Stored as SHA-256 hash in `organizations.bootstrap_token_hash`
- Returned once in the create response (never stored or logged after that)
- Valid for single use only — cleared after first API key registration
- Passed via `X-Bootstrap-Token` header (no signature required)

**User management**

- `UserService` in `@app/users` with methods:
  - `createUser(orgId, externalId, email?, role?)` — create a user
  - `listUsers(orgId)` — list all users for an org
  - `getUser(userId)` — get user details
  - `deleteUser(orgId, userId)` — delete a user (requires key:write scope)

**API routes for user management**

- `POST /users` — create a user (requires `key:write` scope)
- `GET /users` — list all users
- `GET /users/:userId` — get user details
- `DELETE /users/:userId` — delete a user (requires `key:write` scope)

**Audit log**

- Every signing request, policy evaluation, wallet creation, and key management action writes a row to `audit_log`
- `GET /organizations/audit-log` — paginated, filterable by `event` type and date range

**Done when:** A signing request blocked by policy returns 403 with a reason. A valid stamp authenticates successfully. A replayed stamp is rejected. The audit log records all events end-to-end.

---

## Phase 5 — Typed Signing ✅

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

## Phase 6 — Multi-Chain Support ✅

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

- **Implemented:** global rate limiting via `@nestjs/throttler` — 120
  requests per minute per tracker, where the tracker is the API key (from
  the stamp) for authenticated requests and the client IP otherwise
- Returns `429 Too Many Requests` with a `Retry-After` header on breach
- Not yet implemented: per-key configurable limits via an
  `api_keys.rate_limit_rpm` column; in-memory storage should be replaced
  with a shared store (Redis) when running multiple API instances

**Vault key rotation**

- Background job: reads all `organization_seeds` rows, calls `transit/decrypt` (old version) then `transit/encrypt` (new version) for each DEK, writes the new ciphertext back to Postgres
- Triggered manually via `POST /admin/rotate-deks` (admin-only route, separate API key scope)
- Job progress tracked in a `key_rotation_jobs` table: `{ id, startedAt, completedAt, totalOrgs, processedOrgs, status }`

**Webhook system**

- `webhooks` table: `{ id, orgId, url, secret, events[], status }`
- Events: `wallet.created`, `tx.signed`, `tx.confirmed`, `tx.failed`, `policy.denied`
- Outbound HTTP POST to registered URLs with HMAC-SHA256 signature in `X-Webhook-Signature` header
- Retry with exponential backoff on delivery failure (up to 3 attempts)
- `POST /organizations/webhooks` — register a webhook
- `GET /organizations/webhooks` — list webhooks
- `DELETE /organizations/webhooks/:webhookId` — deactivate

**Metrics and health**

- `GET /health` — liveness: returns 200 if API is up, Postgres is reachable, and Go crypto service is reachable
- `GET /ready` — readiness: same as health plus Vault seal check
- Prometheus-compatible metrics endpoint at `/metrics`: request count, signing latency histogram, policy denial rate, Vault call latency

**Vault seal monitoring**

- Background poller: checks `GET /v1/sys/health` on Vault every 60 seconds
- If Vault is sealed, emits a structured log event and fires a webhook event `vault.sealed` to all orgs

**Done when:** Rate limiting rejects excess requests with the correct headers. The DEK rotation job completes against a live Vault without data loss. Webhook events are delivered and verifiable with the HMAC signature. The `/health` endpoint correctly reflects the state of all downstream dependencies.

---

## Phase 9 — Async Transaction Lifecycle

**Goal:** Move confirmation tracking out of the HTTP request path. `POST /wallets/:id/sign` returns immediately after broadcast. A `@nestjs/schedule` poller inside `apps/api` owns everything after that.

**Why it exists:** Blocking an HTTP request on `waitForReceipt` is fragile — it ties up a connection for seconds to minutes and fails silently on timeout. `signing_requests` already tracks status; a scheduler that polls that table periodically is all that's needed to drive the lifecycle forward. No new container, no new infrastructure.

### Changes to Phase 3 sign flow

`POST /wallets/:id/sign` is trimmed to fire-and-forget:

1. Idempotency check
2. Policy evaluation
3. Estimate fees
4. Reserve nonce → create `signing_requests` row (`status = 'pending'`)
5. Sign → `status = 'signed'`
6. Broadcast → `status = 'broadcasted'`
7. **Return immediately:** `{ signingRequestId, txHash, status: "broadcasted" }`

`waitForReceipt` is removed from the request path entirely. The scheduler owns everything after `broadcasted`.

### New polling endpoint

- `GET /wallets/:id/signing-requests/:requestId` — returns current status of a single signing request. Used by clients to poll after receiving `broadcasted`. Requires valid stamp.

### `@app/monitor` — TransactionMonitorService (new lib)

A NestJS lib running inside `apps/api`. Uses `@nestjs/schedule` — no new container, no Redis, no separate process. `signing_requests` acts as the implicit job queue: the `status` column drives all state transitions.

**`PendingMonitor`** — scheduled every `PENDING_POLL_INTERVAL_SECONDS` (default: 15):

- Queries `signing_requests WHERE status = 'broadcasted'`
- For each row, calls `eth_getTransactionReceipt` on the correct chain's RPC
- **Receipt found** → update `status = 'confirmed'`, set `block_number`, `gas_used`, `effective_gas_price`
- **No receipt + age < `STUCK_THRESHOLD_MINUTES`** → skip, check again next cycle
- **No receipt + age ≥ `STUCK_THRESHOLD_MINUTES`** → call `SpeedUpService`

**`SpeedUpService`** — called by PendingMonitor for stuck transactions:

- Calls `eth_getTransactionByHash` to determine actual mempool state
- **Not found (dropped)** → mark `status = 'dropped'`, done
- **Found (still pending)** → proceed with speed-up:
  - Check `speed_up_attempts` — if ≥ `MAX_SPEED_UP_ATTEMPTS` (default: 3) → mark `status = 'failed'`, `error_type = 'permanent'`, `error_message = 'max speed-up attempts reached'`, done
  - Build replacement tx: same nonce, same `to`/`value`/`data`, `maxFeePerGas * GAS_BUMP_MULTIPLIER`, `maxPriorityFeePerGas * GAS_BUMP_MULTIPLIER` (default: 1.2 — above the 10% minimum required by most nodes)
  - Call `WalletService.requestSign` directly (in-process — no HTTP, no stamp needed)
  - Broadcast replacement via `eth_sendRawTransaction`
  - Update row: new `tx_hash`, increment `speed_up_attempts`, `last_speed_up_at = now()`, `status = 'broadcasted'`
  - On next poll cycle, PendingMonitor picks it up again with the new hash

### Database schema additions

New columns on `signing_requests`:

- `speed_up_attempts` int, default 0
- `original_tx_hash` varchar (nullable) — set on first speed-up, never overwritten again
- `last_speed_up_at` timestamp (nullable)

### Environment variables (added to `apps/api`)

| Variable                        | Default | Description                                                       |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `PENDING_POLL_INTERVAL_SECONDS` | 15      | How often PendingMonitor runs                                     |
| `STUCK_THRESHOLD_MINUTES`       | 5       | Age after which a broadcasted tx is considered stuck              |
| `MAX_SPEED_UP_ATTEMPTS`         | 3       | Speed-ups before marking failed                                   |
| `GAS_BUMP_MULTIPLIER`           | 1.2     | Applied to maxFeePerGas and maxPriorityFeePerGas on each speed-up |

### Migration path (future — Phase 8)

When running multiple API instances, the in-memory scheduler causes duplicate polling. At that point, replace `@nestjs/schedule` with BullMQ backed by Redis (already planned in Phase 8 for rate limiting). The business logic inside `TransactionMonitorService` and `SpeedUpService` does not change — only the trigger mechanism is swapped.

### Done when

- `POST /wallets/:id/sign` returns `{ signingRequestId, txHash, status: "broadcasted" }` without waiting for confirmation
- `GET /wallets/:id/signing-requests/:requestId` returns current status at any point in the lifecycle
- Scheduler picks up `broadcasted` rows and updates them to `confirmed` on receipt
- A stuck tx (no receipt after 5 min) is resubmitted with 1.2x gas and eventually confirms
- After 3 failed speed-ups, tx is marked `failed` with `error_type = 'permanent'`
- A dropped tx is detected and marked `dropped`
- Scheduler runs are idempotent — restarting the API does not double-process rows
- `original_tx_hash` is preserved across speed-ups so the audit trail is intact

### Future (Phase 8 webhook extension)

When Phase 8 webhooks are implemented, `TransactionMonitorService` fires `tx.confirmed`, `tx.failed`, and `tx.dropped` events after each status transition. No webhook logic today — Postgres status updates are the only output.
