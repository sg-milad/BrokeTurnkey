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
1. The request body (JSON-serialized)
2. A Unix timestamp (seconds since epoch)
3. The HTTP method and path

The client computes a P-256 signature over this payload and sends it in the
`X-Stamp` header:

```
X-Stamp: <api_key_id>:<timestamp>:<signature>
```

#### Verification flow

The `StampVerifierGuard` (`@app/auth`) intercepts every incoming request:

1. Parses the `X-Stamp` header into its three components
2. Looks up the API key in PostgreSQL to retrieve the associated public key
3. Reconstructs the canonical payload from the request
4. Verifies the P-256 signature against the stored public key
5. Rejects the request if:
   - The header is missing or malformed
   - The API key does not exist or has been revoked
   - The signature is invalid
   - The timestamp is outside the allowed window (prevents replay attacks)

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

### Creation

Organizations are created via `POST /organizations`. The caller provides a name
and receives back a unique organization ID and slug. No cryptographic material is
generated at this stage.

### Onboarding

After creation, an organization must be **onboarded** before it can create wallets.
Onboarding (`POST /organizations/:id/onboard`) triggers the following sequence:

1. The NestJS API calls the Go crypto service to generate a BIP39 mnemonic and
   derive the organization seed
2. A random Data Encryption Key (DEK) is generated
3. The seed is encrypted with AES-256-GCM using the DEK
4. The DEK is sent to HashiCorp Vault's Transit engine for encryption under the
   `wallet-dek` key ring
5. The ciphertext values (`encrypted_seed`, `seed_nonce`, `encrypted_dek`) are
   stored in the `organization_seeds` table
6. All plaintext key material is zeroed in memory immediately after encryption

**Critical:** Onboarding can only happen once per organization. Attempting to
onboard an already-onboarded organization returns a `400 Bad Request`.

### Retrieval

Organizations can be fetched by ID (`GET /organizations/:id`) or by slug
(`GET /organizations/slug/:slug`). The response includes metadata but never
exposes any encrypted fields.

### Child Resources

- `GET /organizations/:id/wallets` — lists all wallets belonging to the org
- `GET /organizations/:id/signing-requests` — lists all signing requests for the org

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

A signing request is initiated via `POST /wallets/:id/sign`. The caller provides:
- Transaction fields: `to`, `value`, `data`, `nonce`, `gasLimit`, `maxFeePerGas`,
  `maxPriorityFeePerGas`
- Optional policy context for evaluation

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
- Manages nonce sequencing per wallet using the `wallet_nonces` table
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
transaction fields multiple times (same nonce, same destination, same value),
the system will detect the duplicate and return the existing signing request
rather than creating a new one. This prevents accidental double-spends caused
by network retries.

The idempotency key is derived from the transaction fields themselves (nonce +
to + value + data), not from a client-provided header. This ensures that even
if a client loses track of its own request IDs, the system maintains consistency.

---

## Errors

The API uses standard HTTP status codes with structured JSON error bodies:

| Status Code | Meaning                                    | Example Causes                          |
| ----------- | ------------------------------------------ | --------------------------------------- |
| 400         | Bad Request                                | Invalid input, org not onboarded        |
| 401         | Unauthorized                               | Missing/invalid stamp, expired timestamp|
| 404         | Not Found                                  | Wallet or org does not exist            |
| 409         | Conflict                                   | Duplicate signing request               |
| 422         | Unprocessable Entity                       | Policy violation                        |
| 500         | Internal Server Error                      | Go service unreachable, Vault down      |

### Error Response Format

```json
{
  "statusCode": 400,
  "message": "organization has not been onboarded",
  "error": "Bad Request"
}
```

Error messages are deliberately specific to aid debugging. Unlike some APIs that
return vague errors to avoid leaking implementation details, this API provides
precise failure reasons because:
1. Clients need actionable feedback to correct their requests
2. The security model does not rely on obscurity — authentication is cryptographic
3. Integrating organizations benefit from clear diagnostics

### Common Error Scenarios

- **"organization has not been onboarded"** (400): The org exists but has not
  completed the onboarding flow. Call `POST /organizations/:id/onboard` first.
- **"User with id \"...\" does not exist"** (404): The `userId` provided in a
  wallet creation request does not match any user in the database.
- **"Wallet does not belong to this org"** (400): The wallet ID and org ID do
  not match — likely a logic error in the client.
- **"stamp_expired"** (401): The timestamp in the X-Stamp header is outside the
  allowed window (default: ±5 minutes from server time).
- **"invalid_stamp"** (401): The P-256 signature does not verify against the
  stored public key for the given API key.

---

## Request Validation

All request bodies are validated using `class-validator` decorators before reaching
business logic. Validation occurs at the DTO (Data Transfer Object) layer:

### Validation Rules

- **Strings**: Required fields enforce minimum length, optional fields use
  `IsOptional()`
- **UUIDs**: Enforced via `IsUUID()` decorator
- **Numbers**: Validated with `IsNumber()` and range checks where applicable
- **Nested objects**: Validated recursively

### Validation Failure

Invalid requests return `400 Bad Request` with a detailed error message listing
all validation failures. For example:

```json
{
  "statusCode": 400,
  "message": [
    "derivationIndex must be a positive integer",
    "orgId must be a valid UUID"
  ],
  "error": "Bad Request"
}
```

Validation happens before authentication checks in some cases (malformed JSON
or missing required fields), but stamp verification always runs before any
business logic executes.

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

Rate limiting is applied per API key to prevent abuse. Limits are configurable
and enforced at the NestJS API gateway layer.

---

## See Also

- `docs/ARCHITECTURE.md` — System architecture and component definitions
- `docs/STAMP_AUTH.md` — Detailed stamp authentication specification
- `docs/KEY_MANAGEMENT.md` — Key generation, storage, and rotation procedures
- `docs/VAULT.md` — HashiCorp Vault setup and operational guide
- `docs/TASKS.md` — Implementation roadmap and completion status
