# WalletMVP — API Reference

This document describes the WalletMVP API: authentication, resource lifecycles,
endpoint reference, error handling, and validation rules.

For the controller source files see:

- `apps/api/src/organizations/organizations.controller.ts`
- `apps/api/src/wallets/wallets.controller.ts`
- `apps/api/src/api-keys/api-keys.controller.ts`

---

## Authentication

Every request must be authenticated using **Stamp Authentication** (P-256 ECDSA
signatures). There is no session or token layer — each HTTP request carries its
own cryptographic proof of identity.

### Stamp authentication

Each client holds a P-256 keypair. The private key never leaves the client; the
public key is stored in the database against an API key identifier.

#### Request format

```
X-Stamp: <base64url(DER-encoded signature)>.<timestamp_ms>.<key_id>
```

The client signs the payload `<timestamp_ms>.<base64url(SHA-256(raw body))>` with
their private key and attaches the result as the `X-Stamp` header on every request.
For GET requests with no body, the body is treated as empty bytes.

See `docs/STAMP_AUTH.md` for the full construction, clock-skew tolerance, and
attack scenarios.

#### Verification flow

`StampVerifierGuard` (`@app/auth`) runs on every request:

1. Parses `X-Stamp` into `signature`, `timestamp_ms`, `key_id`
2. Checks timestamp is within `[now − 5 min, now + 30 s]`
3. Looks up `api_keys` by `key_id` — rejects if missing, revoked, or expired
4. Reconstructs the payload from the raw body bytes (before any JSON parsing)
5. Verifies the P-256 / ES256 DER signature against the stored public key
6. On success, attaches `{ orgId, apiKeyId, keyId, scopes }` to the request
   context and fire-and-forgets `last_used_at`

Two endpoints bypass the stamp guard:

- `POST /organizations` — public; creates and onboards the org, returns the bootstrap token
- `POST /api-keys` — `@OptionalStamp`; accepts either a valid stamp (subsequent keys)
  or an `X-Bootstrap-Token` header (first key only)

#### Scopes

Every API key has a `scopes` array. `["*"]` grants everything. A narrower key is
rejected with `403 insufficient_scope` if it lacks the required scope.

| Route                           | Required scope  |
| ------------------------------- | --------------- |
| `POST /wallets`                 | `wallet:create` |
| `POST /wallets/:id/sign-*`      | `wallet:sign`   |
| `GET /wallets/:id`              | `wallet:read`   |
| `GET /organizations`            | `wallet:read`   |
| `GET /organizations/wallets`    | `wallet:read`   |
| `GET /organizations/signing-requests` | `wallet:read` |
| `GET /organizations/audit-log`  | `wallet:read`   |
| `POST /api-keys`                | `key:write` (or bootstrap token) |
| `DELETE /api-keys/:keyId`       | `key:write`     |
| `POST /organizations/:id/policies` | `policy:write` |
| `DELETE /organizations/:id/policies/:policyId` | `policy:write` |

#### Rate limiting

120 requests per minute per API key (authenticated) or per client IP (unauthenticated).
Excess requests return `429 Too Many Requests` with a `Retry-After` header.

---

## Endpoint Reference

### Organizations

#### `POST /organizations` — Create and onboard

Public endpoint — no stamp or bootstrap token required.

Creates the organization record, generates the BIP39 seed, derives the first wallet
at index 0, generates a one-time bootstrap token, and returns everything in a single
response. Onboarding happens automatically — there is no separate onboard step.

**Request body**

```json
{ "name": "Acme Corp", "slug": "acme" }
```

**Response `200 OK`**

```json
{
  "id": "<org-id>",
  "name": "Acme Corp",
  "slug": "acme",
  "walletAddress": "0x...",
  "bootstrapToken": "<one-time token>",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

`bootstrapToken` is shown exactly once and cleared after the first API key is
registered. Store it immediately.

A duplicate slug returns `409 Conflict`.

---

#### `GET /organizations` — Get current organization

Returns the authenticated org's metadata. `orgId` is taken from the stamp context
— no path parameter needed.

**Response `200 OK`**

```json
{
  "id": "<org-id>",
  "name": "Acme Corp",
  "slug": "acme",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

---

#### `GET /organizations/slug/:slug` — Get organization by slug

Scoped to the caller's own org — returns `undefined` if the slug belongs to a
different org.

---

#### `GET /organizations/wallets` — List wallets

Lists all wallets for the authenticated org.

---

#### `GET /organizations/signing-requests` — List signing requests

Lists all signing requests for the authenticated org.

---

#### `GET /organizations/audit-log` — Query audit log

**Query parameters** (all optional):

| Parameter   | Type   | Description                      |
| ----------- | ------ | -------------------------------- |
| `event`     | string | Filter by event type             |
| `userId`    | string | Filter by user ID                |
| `walletId`  | string | Filter by wallet ID              |
| `startDate` | string | ISO 8601 lower bound             |
| `endDate`   | string | ISO 8601 upper bound             |
| `limit`     | number | Max results (default 50)         |
| `offset`    | number | Pagination offset (default 0)    |

---

### API Keys

#### `POST /api-keys` — Register a new API key

Accepts either `X-Bootstrap-Token` (first key) or a valid `X-Stamp` with
`key:write` scope (subsequent keys). The `orgId` is resolved automatically from
whichever auth mechanism is used.

**Request body**

```json
{
  "name": "prod-signer",
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n",
  "keyId": "ak_prod_abc123",
  "scopes": ["wallet:sign"]
}
```

`scopes` defaults to `["*"]` when omitted.

**Response `201 Created`**

```json
{
  "id": "<uuid>",
  "keyId": "ak_prod_abc123",
  "name": "prod-signer",
  "scopes": ["wallet:sign"],
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

---

#### `GET /api-keys` — List API keys

Lists all active API keys for the authenticated org.

---

#### `DELETE /api-keys/:keyId` — Revoke an API key

Requires `key:write` scope. Marks the key as revoked — it is immediately rejected
by the stamp guard on subsequent requests.

---

### Wallets

#### `POST /wallets` — Derive a new wallet

Requires `wallet:create` scope. `orgId` is taken from the stamp context.

The server auto-increments the derivation index — callers do not supply one.

**Request body**

```json
{
  "label": "Treasury",
  "userId": "<user-id>",
  "chainId": 84532
}
```

`userId` is optional — omit for system wallets (treasury, deployer, etc.).

**Response `201 Created`**

```json
{
  "walletId": "<wallet-id>",
  "address": "0x...",
  "derivationPath": "m/44'/60'/0'/0/1",
  "label": "Treasury"
}
```

---

#### `GET /wallets/:id` — Get wallet details

Requires `wallet:read` scope. Returns wallet metadata for a wallet belonging to the
authenticated org.

---

#### `GET /wallets/:id/signing-requests` — List signing requests

Returns all signing requests for a given wallet.

---

#### `GET /wallets/:id/signing-requests/:requestId` — Poll signing request status

Returns the current status of a single signing request. Use this to poll after
`POST /wallets/:id/sign-transaction` returns.

**Response `200 OK`**

```json
{
  "id": "<request-id>",
  "status": "confirmed",
  "txHash": "0x...",
  "blockNumber": 12345678,
  "gasUsed": "21000",
  "effectiveGasPrice": "30000000000",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

Possible `status` values: `pending` → `signed` → `broadcasted` → `confirmed` / `failed` / `dropped`.

---

#### `POST /wallets/:id/sign-transaction` — Sign and broadcast a transaction

Requires `wallet:sign` scope. `orgId` is taken from the stamp context.

The server handles gas estimation, nonce assignment, signing, and broadcast.
**Do not supply `nonce`, `gasLimit`, `maxFeePerGas`, or `maxPriorityFeePerGas`** —
they are estimated and assigned server-side.

**Request body**

```json
{
  "txFields": {
    "chainId": 84532,
    "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "value": "1000000000000000000",
    "data": "0x"
  }
}
```

**Response `200 OK`**

```json
{
  "signingRequestId": "<uuid>",
  "txHash": "0x...",
  "status": "broadcasted"
}
```

The response returns as soon as the transaction is broadcast. Poll
`GET /wallets/:id/signing-requests/:requestId` for confirmation.

A repeated request with identical `{ walletId, chainId, to, value, data }` returns
the existing signing request (idempotent).

---

#### `POST /wallets/:id/sign-typed` — Sign EIP-712 typed data

Requires `wallet:sign` scope.

**Request body**

```json
{
  "domain": { "name": "MyApp", "version": "1", "chainId": 1 },
  "types": { "Permit": [{ "name": "owner", "type": "address" }, ...] },
  "primaryType": "Permit",
  "message": { "owner": "0x...", ... }
}
```

When `EIP712_DOMAIN_ALLOWLIST` is set, `domain.name` must be on the list.

**Response `200 OK`**

```json
{ "signature": "0x..." }
```

---

#### `POST /wallets/:id/sign-message` — Sign a personal message (EIP-191)

Requires `wallet:sign` scope. `message` is capped at 4096 characters.

**Request body**

```json
{ "message": "Sign in to MyApp" }
```

**Response `200 OK`**

```json
{ "signature": "0x..." }
```

---

## Signing Lifecycle

`POST /wallets/:id/sign-transaction` runs through four phases:

**Phase 1 — Policy evaluation**

`PolicyEngine` checks the request against all active rules for the org (spend
limits, address allowlists/blocklists, time locks). If any rule denies, the request
is rejected immediately with `403` — no nonce is consumed, no crypto work happens.

**Phase 2 — Fee estimation and nonce reservation**

`GasService` calls `eth_estimateGas` and `eth_feeHistory` via the configured RPC
provider, applies a 20% gas buffer, and atomically increments the per-wallet nonce
counter. The nonce reservation is permanent — a failed broadcast leaves a gap rather
than risking nonce reuse.

**Phase 3 — Cryptographic signing (Go service)**

The encrypted org seed is fetched from PostgreSQL and forwarded to the Go crypto
service. Go decrypts the DEK via Vault, decrypts the seed, derives the child key,
RLP-encodes the transaction, computes the keccak256 hash, signs with secp256k1, and
zeros all key material. NestJS receives only the signature and raw transaction bytes.

**Phase 4 — Broadcast**

NestJS broadcasts the raw transaction via `eth_sendRawTransaction`. The signing
request status is updated to `broadcasted` and the response is returned immediately.
A background `TransactionMonitorService` polls every 15 seconds for receipts,
updates status to `confirmed`/`failed`, and triggers speed-ups for stuck
transactions (1.2× gas bump, same nonce).

---

## Errors

All error responses use the NestJS default shape: `{ statusCode, message, error }`.

| Status | Meaning                 | Common causes                                      |
| ------ | ----------------------- | -------------------------------------------------- |
| 400    | Bad request             | Validation failure, permanent signing error        |
| 401    | Unauthorized            | Missing/invalid/expired stamp, revoked key         |
| 403    | Forbidden               | Policy denial, insufficient scope                  |
| 404    | Not found               | Wallet or org does not exist                       |
| 409    | Conflict                | Duplicate org slug                                 |
| 429    | Too many requests       | Rate limit exceeded                                |
| 500    | Internal server error   | Go service unreachable, Vault down                 |

### Stamp errors (`401 Unauthorized`)

| `message`                               | Cause                                        |
| --------------------------------------- | -------------------------------------------- |
| `Missing X-Stamp header`                | Header absent on a non-public route          |
| `Invalid stamp format`                  | Header does not split into exactly three parts |
| `Invalid timestamp in stamp`            | Timestamp is not an integer                  |
| `Stamp timestamp is out of valid range` | Older than 5 min or more than 30 s in future |
| `API key not found`                     | `key_id` not in `api_keys`                   |
| `API key is not active`                 | Key has been revoked                         |
| `API key has expired`                   | `expires_at` is in the past                  |
| `Invalid signature encoding`            | Signature is not valid base64url             |
| `Invalid signature length`              | DER P-256 signature outside 68–75 bytes      |
| `Invalid signature`                     | Signature verification failed                |

### Common errors

- `"organization has not been onboarded"` (400) — org exists but has no seed; should not occur since `POST /organizations` onboards automatically.
- `"User with id \"...\" does not exist"` (404) — `userId` in wallet creation does not match any user.
- `"Wallet does not belong to this org"` (400) — wallet ID / org ID mismatch.
- `"Policy denied: ..."` (403) — signing request blocked by a rule.
- `"insufficient_scope"` (403) — API key lacks the required scope.

---

## Request Validation

A global `ValidationPipe` runs before every handler:

- `whitelist: true` — unknown properties are stripped
- `forbidNonWhitelisted: true` — unknown properties are rejected (400)
- `transform: true` — values are coerced to their declared types

---

## Worked Examples

### Step 1 — Create and onboard an organization

```bash
curl -s -X POST http://localhost:3000/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Corp", "slug": "acme"}'
# → { "id": "<org-id>", "slug": "acme", "firstAddress": "0x...", "bootstrapToken": "<token>", ... }
```

Save `id` and `bootstrapToken`. The token is shown exactly once.

### Step 2 — Generate a P-256 keypair and register your first API key

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private.pem
openssl ec -in private.pem -pubout -out public.pem

# Format public key for JSON (escape newlines)
awk '{printf "%s\\n", $0}' public.pem
```

```bash
curl -s -X POST http://localhost:3000/api-keys \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: <bootstrapToken>' \
  -d '{
    "name": "prod",
    "publicKey": "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n",
    "keyId": "ak_prod_abc123",
    "scopes": ["*"]
  }'
# → { "id": "...", "keyId": "ak_prod_abc123", "name": "prod", "scopes": ["*"], "createdAt": "..." }
```

Save the `keyId` — it goes in every `X-Stamp` header.

### Step 3 — Construct a stamp (Node.js)

```js
const { createHash, sign } = require('node:crypto');
const fs = require('node:fs');

const privateKey = fs.readFileSync('./private.pem');

function makeStamp(bodyBytes, keyId) {
  const timestamp = Date.now();
  const bodyHash = createHash('sha256').update(bodyBytes).digest('base64url');
  const payload = `${timestamp}.${bodyHash}`;
  const signature = sign('sha256', Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: 'der',
  }).toString('base64url');
  return `${signature}.${timestamp}.${keyId}`;
}
```

For GET requests with no body, pass an empty buffer: `makeStamp(Buffer.alloc(0), keyId)`.

A development helper is available at `scripts/stamp-helper.js`:

```bash
pnpm stamp:helper generate-keypair ./private.pem ./public.pem
pnpm stamp:helper make-stamp <key_id> ./private.pem ./payload.json
```

### Step 4 — Derive a wallet

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -H 'X-Stamp: <stamp>' \
  -d '{"label": "Treasury", "chainId": 84532}'
# → { "walletId": "<wallet-id>", "address": "0x..." }
```

### Step 5 — Create a policy

```bash
curl -s -X POST http://localhost:3000/organizations/<org-id>/policies \
  -H 'Content-Type: application/json' \
  -H 'X-Stamp: <stamp>' \
  -d '{
    "name": "Block known drainer",
    "ruleType": "address_blocklist",
    "ruleConfig": { "addresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] },
    "appliesTo": "all",
    "priority": 0
  }'
```

Supported `ruleType` values:

- `address_blocklist` — config: `{ "addresses": string[] }`
- `address_allowlist` — config: `{ "addresses": string[] }`
- `spend_limit` — config: `{ "max_amount_wei": string }`
- `time_lock` — config: `{ "start_time": "<ISO 8601>", "end_time": "<ISO 8601>" }`

### Step 6 — Sign and broadcast a transaction

```bash
curl -s -X POST http://localhost:3000/wallets/<wallet-id>/sign-transaction \
  -H 'Content-Type: application/json' \
  -H 'X-Stamp: <stamp>' \
  -d '{
    "txFields": {
      "chainId": 84532,
      "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "value": "1000000000000000000",
      "data": "0x"
    }
  }'
# → { "signingRequestId": "...", "txHash": "0x...", "status": "broadcasted" }
```

### Step 7 — Poll for confirmation

```bash
curl -s http://localhost:3000/wallets/<wallet-id>/signing-requests/<request-id> \
  -H 'X-Stamp: <stamp>'
# → { "id": "...", "status": "confirmed", "txHash": "0x...", "blockNumber": 12345678, ... }
```

### Step 8 — Inspect full signing history

```bash
curl -s http://localhost:3000/organizations/signing-requests \
  -H 'X-Stamp: <stamp>'
```

---

## See Also

- `docs/ARCHITECTURE.md` — System architecture and component definitions
- `docs/STAMP_AUTH.md` — Full stamp authentication specification
- `docs/CRYPTO_SERVICE.md` — Go crypto service API reference
- `docs/KEY_MANAGEMENT.md` — Key generation, storage, and rotation
- `docs/VAULT.md` — HashiCorp Vault setup and operations
- `docs/TASKS.md` — Implementation roadmap and phase status