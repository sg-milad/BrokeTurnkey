# WalletMVP — API Reference

This document describes the conceptual architecture of the WalletMVP API. It covers
authentication, resource lifecycles, error handling, validation, versioning, and
future-compatibility guarantees.

For a complete endpoint listing, see the controller source files:

- `apps/api/src/organizations/organizations.controller.ts`
- `apps/api/src/wallets/wallets.controller.ts`

---

## Authentication

Every request to the API must be authenticated using **Stamp Authentication**
(P-256 ECDSA signatures). There is no session-based or token-based auth layer;
every individual HTTP request carries its own cryptographic proof of identity.

### Stamp Authentication

The stamp mechanism follows Turnkey's authentication model. Each client holds a
P-256 keypair. The private key never leaves the client; the public key is stored
in the database alongside an API key identifier.

#### Request format

Clients sign each request by constructing a canonical payload that includes:

1. The request body (raw bytes as sent — hashed with SHA-256)
2. A Unix timestamp in milliseconds
3. The API key identifier

The client computes a P-256 signature over this payload and sends it in the
`X-Stamp` header:

```
X-Stamp: <base64url(signature)>.<timestamp_ms>.<key_id>
```

See `docs/STAMP_AUTH.md` for the canonical header construction — it is the
authoritative spec (the format above supersedes earlier drafts of this file).

#### Verification flow

The `StampVerifierGuard` (`@app/auth`) intercepts every incoming request:

1. Parses the `X-Stamp` header into its three components
2. Looks up the API key in PostgreSQL to retrieve the associated public key
3. Reconstructs the canonical payload from the **raw request bytes** (the
   body is captured before parsing — the hash covers exactly what the client
   signed, never a re-serialized version of the parsed JSON)
4. Verifies the P-256 signature (DER-encoded ES256) against the stored
   public key
5. Rejects the request if:
   - The header is missing or malformed
   - The API key does not exist, is revoked, or is expired
   - The signature is invalid
   - The timestamp is outside the allowed window (prevents replay attacks)
6. On success, attaches `{ orgId, apiKeyId, keyId, scopes }` to the request
   context and updates `last_used_at` (fire-and-forget)

#### Scopes

Every API key carries a `scopes` array. A `*` scope grants everything; a
narrowed key can only perform the listed actions. Scope checks are enforced
by a global `ScopesGuard`:

| Action                     | Required scope |
| -------------------------- | -------------- |
| Register / revoke API keys | `key:write`    |
| Create / delete users      | `key:write`    |
| Create / delete policies   | `policy:write` |

A key without the required scope gets `403 {"statusCode":403,"message":"insufficient_scope","error":"Forbidden"}`.

#### Rate limiting

Every request is rate limited by a global guard: **120 requests per minute**
per API key (when a stamp is present) or per client IP (anonymous requests).
Excess requests get `429 Too Many Requests` with a `Retry-After` header.
Limits are enforced in the NestJS gateway layer; the default storage is
in-memory (use a shared store when running multiple API instances).

#### Why stamps instead of tokens?

- **No server-side session state**: Every request is self-contained
- **MITM resistance**: Even if TLS is terminated upstream, requests cannot be
  forged without the client's private key
- **Replay protection**: Timestamps prevent captured requests from being reused
- **Auditability**: Each request is cryptographically tied to a specific API key

See `docs/STAMP_AUTH.md` for the full specification including header construction,
clock-skew tolerance, and attack scenarios.

---

## API Lifecycle

The API follows a RESTful pattern with resources organized hierarchically:

```
Organizations → Wallets → Signing Requests
```

Each resource has a well-defined lifecycle described below. Resources are created
via `POST`, read via `GET`, and transition through states as operations complete.
There are no `PUT` or `DELETE` endpoints at this stage — wallets and organizations
are immutable once created, and signing requests are append-only audit records.

All timestamps use ISO 8601 format with timezone information (`created_at`,
`updated_at`, `signed_at`). UUIDs are used as primary identifiers across all
tables.

---

## Organization Lifecycle

An organization represents a tenant in the system. Each organization owns its own
set of wallets, policies, and signing history.

### Creation & Onboarding

Organizations are created via `POST /organizations`. The caller provides a name
and slug. Creation **automatically onboards** the organization in the same
request — no separate step is required:

1. The organization record is created in PostgreSQL
2. The NestJS API calls the Go crypto service to generate a BIP39 mnemonic and
   derive the organization seed
3. A random Data Encryption Key (DEK) is generated
4. The seed is encrypted with AES-256-GCM using the DEK
5. The DEK is sent to HashiCorp Vault's Transit engine for encryption under the
   `wallet-dek` key ring
6. The ciphertext values (`encrypted_seed`, `seed_nonce`, `encrypted_dek`) are
   stored in the `organization_seeds` table
7. The first signing wallet is derived at index 0
8. A one-time bootstrap token is generated and returned with the response
9. All plaintext key material is zeroed in memory immediately after encryption

**Critical:** Onboarding can only happen once per organization (it is baked into
`POST /organizations`). Attempting to create an organization with a slug that
already exists returns a `409 Conflict`.

### Retrieval

Organizations can be fetched by ID (`GET /organizations`) or by slug
(`GET /organizations/slug/:slug`). The response includes metadata but never
exposes any encrypted fields.

### Child Resources

- `GET /organizations/wallets` — lists all wallets belonging to the org
- `GET /organizations/signing-requests` — lists all signing requests for the org

---

## Wallet Lifecycle

Wallets are hierarchical deterministic (HD) wallets derived from the organization
seed. Each wallet corresponds to a specific derivation index and has a unique
Ethereum address.

### Creation (Derivation)

Wallets are created via `POST /wallets`. The caller provides:

- `orgId`: The organization ID
- `derivationIndex`: The BIP32 derivation index (integer)
- `userId` (optional): If provided, the wallet is assigned to a specific user;
  if omitted, the wallet is a system wallet (treasury, deployer, etc.)

The derivation process:

1. The NestJS API retrieves the organization's encrypted seed from PostgreSQL
2. The ciphertext is forwarded to the Go crypto service along with the derivation
   index
3. The Go service calls Vault to decrypt the DEK, then decrypts the seed
4. The child key is derived at the specified index using BIP32
5. The Ethereum address is computed from the public key
6. The address is returned to NestJS and stored in the `wallets` table
7. All plaintext key material is zeroed in the Go service

**Important:** The wallet address is stored in plaintext because addresses are
public information on the blockchain. Only the seed and DEK remain encrypted.

### Retrieval

- `GET /wallets/:id` — fetches wallet metadata including address, derivation
  index, and creation timestamp
- `GET /wallets/:id/signing-requests` — lists all signing requests for this wallet

### Immutability

Once a wallet is created, its address and derivation index cannot be changed.
There is no update or delete operation for wallets.

---

## Signing Lifecycle

Signing is the core operation of the system. It transforms a raw transaction
into a signed transaction ready for broadcast to the Ethereum network.

### Request Creation

A signing request is initiated via `POST /wallets/:id/sign-transaction`. The caller provides:

- Transaction fields: `to`, `value`, `data`, `chainId`
- `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas` are estimated server-side when omitted
- The nonce is always assigned server-side — do not supply one

The signing lifecycle proceeds through these phases:

#### Phase 1: Policy Evaluation

The `PolicyEngine` (`@app/policy`) evaluates the request against configured rules:

- Spend limits (per-transaction and rolling window)
- Address allowlists and blocklists
- Time locks (e.g., business-hours-only restrictions)

If any policy check fails, the request is rejected immediately with a descriptive
error. No cryptographic operations are performed.

#### Phase 2: Fee Estimation & Nonce Management

The `GasService` (`@app/gas`) handles transaction assembly:

- Estimates gas via `eth_estimateGas` on the configured RPC provider
  - **Reserves the nonce atomically**: a single `INSERT ... ON CONFLICT`
    upsert increments the per-wallet counter and returns the reserved value.
    A signing failure before any broadcast returns the nonce only if it is
    still the most recent reservation. Once a broadcast is attempted, the
    reservation is permanent because RPC failure may still mean the network
    accepted the transaction; gaps are safe, but reusing that nonce is not.
    Clients must not supply a nonce.
- Assembles the complete raw transaction fields

#### Phase 3: Cryptographic Signing

The transaction fields are sent to the Go crypto service:

1. The org's encrypted seed is retrieved from PostgreSQL
2. The Go service decrypts the DEK via Vault, then decrypts the seed
3. The child key is derived at the wallet's index
4. The transaction is RLP-encoded and hashed with keccak256
5. The hash is signed with secp256k1
6. The signature and transaction hash are returned
7. All plaintext key material is zeroed

#### Phase 4: Broadcast & Confirmation

The signed transaction is broadcast via `eth_sendRawTransaction` to the RPC
provider. The system waits for the transaction receipt and records:

- Transaction hash
- Block number
- Gas used
- Status (success/failure)

The signing request record in the `signing_requests` table is updated with the
outcome and timestamp.

### Idempotency

Signing requests are idempotent by design. If a client submits the same
transaction fields multiple times, the system returns the existing signing
request rather than creating a new one. This prevents accidental
double-spends caused by network retries.

The idempotency key is derived server-side as
`sha256(walletId:chainId:to:value:data)` and enforced by a **unique index**
on `signing_requests.idempotency_key` — the index is the arbiter even when
two identical requests race: the loser returns the winner's result. A
previously failed request is reused (reset to pending) on retry.

---

## Errors

The API uses standard HTTP status codes with structured JSON error bodies
(NestJS default shape: `{ statusCode, message, error }`):

| Status Code | Meaning                          | Example Causes                                                |
| ----------- | -------------------------------- | ------------------------------------------------------------- |
| 400         | Bad Request / validation failure | Invalid input, org not onboarded, permanent signing failure   |
| 401         | Unauthorized                     | Missing/invalid/expired stamp, revoked key                    |
| 403         | Forbidden                        | Policy denial, insufficient API key scope                     |
| 404         | Not Found                        | Wallet or org does not exist                                  |
| 429         | Too Many Requests                | Rate limit exceeded (per API key or IP)                       |
| 500         | Internal Server Error            | Go service unreachable, Vault down, transient signing failure |

### Error Response Format

```json
{
  "statusCode": 400,
  "message": "organization has not been onboarded",
  "error": "Bad Request"
}
```

Validation failures return an array of messages:

```json
{
  "statusCode": 400,
  "message": [
    "label must be longer than or equal to 1 characters",
    "orgId must be a UUID"
  ],
  "error": "Bad Request"
}
```

### Stamp authentication errors (all `401 Unauthorized`)

The guard returns the reason directly in `message`:

| `message`                               | Cause                                                |
| --------------------------------------- | ---------------------------------------------------- |
| `Missing X-Stamp header`                | `X-Stamp` header absent                              |
| `Invalid stamp format`                  | Header does not parse into three dot-separated parts |
| `Invalid timestamp in stamp`            | Timestamp is not an integer                          |
| `Stamp timestamp is out of valid range` | Older than 5 minutes or more than 30 s in the future |
| `API key not found`                     | `key_id` not in `api_keys` table                     |
| `API key is not active`                 | `status = revoked`                                   |
| `API key has expired`                   | `expires_at` is in the past                          |
| `Invalid signature encoding`            | Signature is not valid base64url                     |
| `Invalid signature length`              | Decoded signature outside 68–75 bytes (DER P-256)    |
| `Invalid signature`                     | Signature verification failed or key malformed       |

### Common Error Scenarios

- **`"organization has not been onboarded"` (400)**: The org exists but has
  no seed. This should not normally occur since onboarding is automatic at
  creation time. Contact support if you see this error.
- **`"User with id \"...\" does not exist"` (404)**: The `userId` provided in a
  wallet creation request does not match any user in the database.
- **`"Wallet does not belong to this org"` (400)**: The wallet ID and org ID do
  not match — likely a logic error in the client.
- **`"Transaction signing failed (permanent)"` / `"Transaction signing failed (retryable)"` (400/500)**:
  Signing or broadcast failed. Details are logged server-side and stored in
  the signing request's `failure_reason` — they are deliberately **not**
  returned to the client to avoid leaking crypto/RPC internals.
- **`"Policy denied: ..."` (403)**: The signing request was blocked by a
  policy rule (spend limit, allowlist, time lock).
- **`"insufficient_scope"` (403)**: The API key is valid but lacks the scope
  required by the route (see Scopes above).

---

## Request Validation

All request bodies are validated by a **global `ValidationPipe`** before
reaching business logic, using `class-validator` decorators at the DTO layer:

- `whitelist: true` — properties without a validator decorator are stripped
- `forbidNonWhitelisted: true` — unknown properties are **rejected** (400),
  which prevents mass-assignment
- `transform: true` — payloads are coerced to their declared types

### Validation Rules

- **Strings**: Required fields enforce minimum length, optional fields use
  `IsOptional()`
- **UUIDs**: Enforced via `IsUUID()` decorator
- **Numbers**: Validated with `IsNumber()` / `IsInt()` and range checks where
  applicable
- **Nested objects**: Validated recursively (`ValidateNested` + `Type`)

### Notable DTO behaviours

- `POST /wallets/:id/sign-transaction` — the server assigns the nonce itself;
  `txFields.nonce` is **optional** and ignored if provided.
- `POST /wallets/:id/sign-message` — `message` is capped at 4096 characters.
- `POST /wallets/:id/sign-typed` — EIP-712 `domain.name` must be on the
  `EIP712_DOMAIN_ALLOWLIST` env allowlist when it is non-empty (empty =
  allow all domains).

Invalid requests return `400 Bad Request` with an array of messages listing
all validation failures (see Errors).

---

## Versioning Strategy

The API currently operates at **v1** with no explicit version prefix in URLs.
Versioning is handled implicitly through backward-compatible evolution:

### Current Approach

- No `/v1/` prefix in routes (cleaner URLs, easier migration later)
- New fields are added to responses without breaking existing clients
- Deprecated fields are marked in documentation before removal
- Breaking changes require a major version bump and a new route prefix

### Future Versioning

When a breaking change becomes necessary, the API will adopt URL-based versioning:

```
/v1/organizations
/v2/organizations
```

Clients can migrate at their own pace. The old version remains available until
all known clients have migrated, with a deprecation period of at least 6 months.

### Header-Based Negotiation (Future)

An alternative approach under consideration is header-based version negotiation:

```
Accept-Version: 2024-01-15
```

This allows more granular versioning without URL proliferation, but adds
complexity to caching and debugging. The current strategy favors simplicity.

---

## Future Compatibility

The API is designed with forward compatibility in mind:

### Additive Changes

New endpoints, new response fields, and new optional request parameters can be
added without breaking existing clients. Clients that ignore unknown fields will
continue to work.

### Deprecation Policy

Deprecated features follow this timeline:

1. **Announcement**: Documentation updated, deprecation warning added to logs
2. **Grace period**: 6 months minimum for clients to migrate
3. **Removal**: Feature removed in next major version

### Schema Evolution

Database schema changes are handled via Drizzle migrations. Backward-compatible
changes (adding nullable columns, adding indexes) can be deployed without
downtime. Breaking changes (removing columns, changing types) require a
migration script and coordination with the deployment process.

### Crypto Service Compatibility

The Go crypto service communicates with NestJS via a stable HTTP interface.
Changes to the internal cryptography (e.g., switching from secp256k1 to a
different curve) would require a versioned API contract between the two services.
The current contract is documented in the Go service's handler definitions.

### Vault Integration

The Vault Transit integration uses the `wallet-dek` key ring. Rotating this key
(creating `vault:v2:...`) is supported and transparent to clients. Existing
ciphertext encrypted with v1 can still be decrypted while the minimum decryption
version is set appropriately. A background job re-wraps old ciphertext to the
new key version.

---

## Security Considerations

### What Crosses the Network

- **Client → NestJS**: Signed requests (no key material)
- **NestJS → Go Crypto**: Ciphertext + transaction fields (no plaintext keys)
- **Go Crypto → Vault**: AppRole credentials + encrypt/decrypt calls
- **NestJS → PostgreSQL**: SQL queries with ciphertext values
- **NestJS → RPC**: Signed transactions for broadcast

**Plaintext key material never crosses any network boundary.** It exists only
in the Go crypto service's process memory for the duration of a single
operation and is zeroed immediately after use.

### Replay Protection

The stamp timestamp prevents replay attacks. Requests with timestamps older than
5 minutes (configurable) are rejected. This window balances clock skew tolerance
with security.

### Rate Limiting

Rate limiting is applied globally to prevent abuse: **120 requests per
minute** per tracker, where the tracker is the API key (from the stamp) for
authenticated requests and the client IP otherwise. Breaches return
`429 Too Many Requests` with a `Retry-After` header. The default storage is
in-memory — switch to a shared store (e.g. Redis) when running more than one
API instance.

---

## Examples

### Constructing an X-Stamp (Node.js)

The stamp is a DER-encoded P-256 signature over
`<timestamp_ms>.<base64url(SHA-256(raw body))>`. Generate a keypair once,
register the public key, then sign every request:

```js
const { generateKeyPairSync, createHash, sign } = require('node:crypto');

// 1. Generate the P-256 keypair ONCE (client side). The private key never
//    leaves your machine — only the public key is registered with the API.
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
console.log(
  'Register this public key:',
  publicKey.export({ type: 'spki', format: 'pem' }),
);

// 2. Sign a request. body must be the EXACT raw bytes you send.
function makeStamp(bodyBytes, keyId) {
  const timestamp = Date.now();
  const bodyHash = createHash('sha256').update(bodyBytes).digest('base64url');
  const payload = `${timestamp}.${bodyHash}`;
  const signature = sign('sha256', Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: 'der', // must match the server (DER, not raw r||s)
  }).toString('base64url');
  return `${signature}.${timestamp}.${keyId}`;
}

// 3. Use it:
//    const rawBody = JSON.stringify({ orgId: '...' });
//    fetch(url, {
//      method: 'POST',
//      headers: { 'Content-Type': 'application/json', 'X-Stamp': makeStamp(rawBody, '<key_id>') },
//      body: rawBody,
//    });
```

> The server hashes the **raw body bytes** it receives. Serialize the body
> exactly once and sign those same bytes (do not rely on JSON.stringify
> round-tripping after parsing). For GET requests with no body, sign
> `SHA-256("")` — `base64url` is `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`.

## Recommendation

- Every authenticated request should be signed with `X-Stamp`, except the
  first `POST /api-keys` call for an organization when it uses
  `X-Bootstrap-Token` instead.
- Keep the private key local and never send it to the API. Only the public
  key is registered on `POST /api-keys`.
- Add `@ApiHeader({ name: 'X-Stamp', ... })` to all authenticated controllers
  where Swagger docs are exposed. That improves developer clarity.
- Use the bash scripts (`wallets.sh`, `organizations.sh`, etc.) for all API
  calls — they handle stamp construction automatically via `stamp.sh`.

### Generating a keypair

Generate a P-256 keypair with `openssl` (no extra tooling required):

```bash
# Generate private key (keep secret, never commit)
openssl ecparam -name prime256v1 -genkey -noout -out private.pem

# Extract public key
openssl ec -in private.pem -pubout -out public.pem
```

For stamp construction and all API calls, use the bash scripts — they read
`PRIVATE_KEY` and `KEY_ID` from the environment and sign requests automatically:

```bash
export KEY_ID=<keyId>
export PRIVATE_KEY=./private.pem

./wallets.sh derive "Treasury"
./organizations.sh wallets
./wallets.sh sign-transaction <walletId> 84532 0xABC... 1000000000000000000
```

### Why this matters

- The `X-Stamp` value proves the request body was signed by a registered key.
- The API stores the public key; the private key stays with your client.
- The first key registration uses `X-Bootstrap-Token`, which is a separate
  one-time auth path and is not equivalent to `X-Stamp`.

### When to use each header

- `X-Bootstrap-Token`: only for the initial API key creation via
  `POST /api-keys` when there is no existing signed key.
- `X-Stamp`: for every subsequent authenticated API request.

### Result

This makes it clear in docs and developer tooling that stamps are required
for normal API calls, while bootstrap tokens are a special one-time setup
mechanism.

---

### Quickstart walkthrough

#### Step 1 — Create an organization

```bash
curl -s -X POST $API/organizations \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Corp", "slug": "acme"}'
# → { "id": "<org-id>", "slug": "acme", "name": "Acme Corp", "firstAddress": "0x...", "bootstrapToken": "<token>" }
```

Save the returned `id` as `ORG_ID` and `bootstrapToken` — it is shown exactly
once and cleared after first use.

#### Step 2 — Generate a P-256 key pair and register your first API key

Generate the keypair locally with `openssl`. The private key never leaves your machine.

```bash
# Generate private key (keep secret, never commit)
openssl ecparam -name prime256v1 -genkey -noout -out private.pem

# Extract public key
openssl ec -in private.pem -pubout -out public.pem
```

Register the public key using the bootstrap token from Step 1:

```bash
BOOTSTRAP_TOKEN=<bootstrapToken> \
  ./api-keys.sh register "prod" ./public.pem
# → { "id": "...", "keyId": "<key-id>", "name": "prod", "scopes": ["*"], "createdAt": "..." }
```

Save the returned `keyId` — export it as `KEY_ID` for all subsequent script calls.

```bash
export KEY_ID=<keyId>
export PRIVATE_KEY=./private.pem
```

#### Step 3 — Derive a wallet

```bash
./wallets.sh derive "Treasury"
# → { "walletId": "<wallet-id>", "address": "0x..." }
```

#### Step 4 — Create a policy

```bash
./policies.sh create ./policy-block-address.json
# → { "id": "<policy-id>", "ruleType": "address_blocklist", "status": "active", ... }
```

Other supported rule types: `address_allowlist`, `spend_limit`, `time_lock`.
See `policy-block-address.json`, `policy-allowlist.json`, `policy-spend-limit.json`
for example payloads.

#### Step 5 — Sign and broadcast a transaction

```bash
./wallets.sh sign-transaction <walletId> 84532 \
  0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
  1000000000000000000
# → { "txHash": "0x...", "status": "broadcasted", "signingRequestId": "..." }
# Gas is estimated server-side. The nonce is always assigned by the server.
```

#### Step 6 — Inspect signing history

```bash
./organizations.sh signing-requests
```

---

## See Also

- `docs/ARCHITECTURE.md` — System architecture and component definitions
- `docs/STAMP_AUTH.md` — Detailed stamp authentication specification
- `docs/CRYPTO_SERVICE.md` — Go crypto service API reference and auth token guide
- `docs/KEY_MANAGEMENT.md` — Key generation, storage, and rotation procedures
- `docs/VAULT.md` — HashiCorp Vault setup and operational guide
- `docs/TASKS.md` — Implementation roadmap and completion status
