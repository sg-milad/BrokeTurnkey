# WalletMVP — How It Works

This document explains how the system operates at runtime — how the four
services talk to each other, why each boundary exists, and what actually
happens during the operations clients care about.

For component definitions see `ARCHITECTURE.md`. For setup see `README.md`
and `VAULT_INIT.md`. For cryptographic decisions see `KEY_MANAGEMENT.md`.

---

## The four services and their roles

WalletMVP runs four Docker containers on a shared internal network
(`walletmvp-network`). None of them are optional.

**NestJS API** is the only service clients ever talk to. It handles HTTP
routing, stamp authentication, policy enforcement, gas estimation, nonce
management, and broadcast. It reads and writes PostgreSQL. It calls the Go
crypto service when it needs a key operation. It never touches plaintext
key material — only ciphertext in and ciphertext out.

**Go crypto service** is the cryptographic boundary. It is a long-lived HTTP
server, not a CLI tool. The NestJS API calls it over the Docker network for
three things: create a wallet seed, derive a child address, sign a
transaction or hash. It is the only service that ever handles raw key
material, and it zeroes all of it before returning a response.

**HashiCorp Vault** is the key encryption key (KEK) store. Its sole job is
wrapping and unwrapping the per-organization DEKs via the Transit engine.
It never stores seeds or private keys. Only the Go crypto service holds a
Vault token — NestJS has no Vault access at all.

**PostgreSQL** stores everything else: organizations, wallets, policies, API
keys, signing requests, nonces, and the audit log. All cryptographic
material in the database is ciphertext — encrypted seeds, encrypted DEKs.
A complete database dump is useless to an attacker without also compromising
both the Go service and Vault.

---

## Authentication layer

Every client request must carry an `X-Stamp` header — a P-256 ECDSA signature
over the raw request body and a millisecond timestamp, formatted as:

```
X-Stamp: <base64url(DER signature)>.<timestamp_ms>.<key_id>
```

The `StampVerifierGuard` runs globally on every route. It parses the header,
looks up the public key from `api_keys` by `key_id`, reconstructs the signed
payload from the raw request bytes and timestamp, and verifies the signature.
Requests with an expired timestamp (older than 5 minutes), an invalid
signature, or a revoked key are rejected with `401` before any business logic
runs.

On success the guard attaches `{ orgId, apiKeyId, scopes }` to the request
context. Every downstream service reads `orgId` from this context — clients
do not supply it in the request body for sensitive operations.

**Why stamps instead of bearer tokens:** The signature covers the request
body. An attacker who intercepts a valid stamp cannot change the `to` address
or `value` field without invalidating the signature, even if they somehow
capture TLS traffic. See `STAMP_AUTH.md` for the full construction.

### Getting the first API key

There is a chicken-and-egg problem: stamp verification requires a registered
key, but you need a key to register one. The resolution is a one-time
bootstrap token.

When `POST /organizations` creates an org it generates a random bootstrap
token, stores a SHA-256 hash of it in `organizations.bootstrap_token_hash`,
and returns the raw token in the response exactly once. The client passes it
as `X-Bootstrap-Token` on the first `POST /api-keys` call instead of a stamp.
After the first key is registered the hash is nulled and the bootstrap path
is permanently disabled for that org.

---

## Key hierarchy in practice

Every org has exactly one BIP39 seed, generated at creation time and never
regenerated. All wallet addresses for that org are derived from this seed via
BIP32 derivation paths (`m/44'/60'/0'/0/N`).

The seed is never stored in plaintext. The protection is two-layer envelope
encryption:

1. The Go service generates a random 32-byte DEK per org.
2. The seed is encrypted with AES-256-GCM using the DEK. The result
   (`encrypted_seed`) goes into PostgreSQL.
3. The DEK is sent to Vault's Transit engine, which wraps it with the
   `wallet-dek` KEK. The resulting ciphertext (`vault:v1:...`) goes into
   PostgreSQL as `encrypted_dek`.
4. The raw DEK is immediately zeroed in Go memory.

To use the seed later (for derivation or signing), the Go service reverses
the process: call Vault to unwrap the DEK, use the DEK to decrypt the seed,
do the key operation, zero the DEK and seed. The plaintext DEK exists in Go
process memory for microseconds.

The `wallet-dek` KEK itself never leaves Vault. Even the Go service never
sees the raw KEK bytes — it only calls `transit/encrypt` and
`transit/decrypt` and receives the result.

---

## How organization creation works

`POST /organizations` is the only public endpoint — no stamp required. It
does everything in one request:

1. Creates the organization row in PostgreSQL.
2. Calls the Go crypto service at `POST /wallet/create`. Go generates 256
   bits of entropy, derives a 24-word BIP39 mnemonic, runs PBKDF2 to get
   the 64-byte seed, generates a fresh 32-byte DEK and 12-byte GCM nonce,
   encrypts the seed, calls Vault to wrap the DEK, derives the first wallet
   address at index 0, zeroes all key material, and returns only ciphertext
   and the address.
3. Stores `encrypted_seed`, `seed_nonce`, and `encrypted_dek` in
   `organization_seeds`.
4. Stores the first wallet address in `wallets`.
5. Generates a bootstrap token, stores its SHA-256 hash, and returns the
   raw token in the response.

The mnemonic never leaves the Go service. NestJS only ever sees the
ciphertext blobs and the Ethereum address.

---

## How wallet derivation works

`POST /wallets` derives a new child address from the org's existing seed.
No new entropy is generated.

NestJS reads the ciphertext from `organization_seeds`, counts the existing
wallets to get the next derivation index N, and sends everything to the Go
service at `POST /wallet/derive`. Go calls Vault to unwrap the DEK, decrypts
the seed, runs BIP32 derivation at `m/44'/60'/0'/0/N`, returns the address,
and zeroes all key material.

NestJS stores the address and derivation path in `wallets`. The address is
the only plaintext — it is public information on the blockchain.

Wallets can optionally be assigned to a `userId` for tracking purposes. If
no `userId` is provided the wallet is a system wallet (treasury, deployer, etc.).

---

## How transaction signing works

`POST /wallets/:id/sign-transaction` is the core operation. It goes through
several sequential phases before returning to the client.

**Idempotency check.** Before doing anything the API computes
`sha256(walletId:chainId:to:value:data)` and checks for an existing
`signing_requests` row with that key. If one exists and is not in `failed`
state it returns the existing result immediately. This prevents accidental
double-spends on network retries.

**Policy evaluation.** The `PolicyEngine` evaluates the transaction against
all active policies for the org: address blocklists, address allowlists,
per-transaction spend limits, rolling 24-hour spend windows, and time locks.
If any rule denies the request it returns `403` immediately. No nonce is
consumed — wasted nonces cause gaps in the sequence.

**Gas estimation.** The `GasService` calls `eth_estimateGas` and
`eth_feeHistory` on the configured RPC provider, applies a 20% buffer to the
gas limit, and returns `{ gasLimit, maxFeePerGas, maxPriorityFeePerGas }`.
Clients do not supply gas parameters — the server fills them in.

**Nonce reservation.** A single atomic `INSERT ... ON CONFLICT DO UPDATE`
upsert on `wallet_nonces` increments the counter and returns the reserved
value. The reservation is permanent — there is no release path. A failed
broadcast leaves a gap in the nonce sequence rather than risking a
double-spend by reusing a nonce that may have been accepted by the network.
Clients must not supply a nonce.

**Cryptographic signing.** NestJS reads the org's ciphertext from
`organization_seeds` and sends it along with the complete transaction fields
(including the reserved nonce and estimated gas) to `POST /wallet/sign-transaction`
on the Go service. Go calls Vault to unwrap the DEK, decrypts the seed,
derives the child private key, RLP-encodes the transaction fields, computes
the keccak256 hash, signs it with secp256k1, and returns
`{ signature, txHash, rawTx }`. All key material is zeroed before the
response is written.

The txHash is computed inside Go from the signed RLP bytes — not in NestJS
and not from the signing hash. This is the correct on-chain transaction hash.

**Broadcast.** NestJS passes `rawTx` to `eth_sendRawTransaction` via the
RPC provider. On success the signing request row is updated to
`status=broadcasted` and the response is returned to the client immediately.
The client polls `GET /wallets/:id/signing-requests/:requestId` to check for
confirmation.

**What the client gets back:**

```json
{
  "signingRequestId": "uuid",
  "txHash": "0x...",
  "status": "broadcasted"
}
```

---

## How typed data and message signing work

`POST /wallets/:id/sign-typed` and `POST /wallets/:id/sign-message` follow
the same cryptographic path but bypass the transaction lifecycle entirely —
no nonce, no gas, no broadcast.

For typed data, NestJS constructs the EIP-712 hash using viem's
`hashTypedData` (domain separator + struct hash + final hash). For personal
messages, NestJS prepends the EIP-191 prefix and hashes. Either way, NestJS
produces a 32-byte hash and sends it to `POST /wallet/sign-hash` on the Go
service.

Go signs the raw hash bytes without any awareness of the schema or message
type. The caller (NestJS) is responsible for constructing the hash correctly.
This keeps the Go service as a narrow signing oracle and avoids encoding
EIP-712 schema logic in Go.

---

## How policies work

Policies are stored in the `policies` table per org and evaluated before
every signing request. The `PolicyEngine` in `@app/policy` runs all active
rules in order:

- **address_blocklist** — rejects if `to` is on the list
- **address_allowlist** — rejects if `to` is not on the list (when the list is non-empty)
- **spend_limit** — rejects if `value` exceeds `max_amount_wei`
- **rolling_spend** — rejects if cumulative `value` in the last 24 hours would exceed the limit
- **time_lock** — rejects if current UTC time is outside the configured window

A denial returns `403` with the reason and the signing request is never
created. Nothing is logged to `signing_requests` on denial — only a
`policy_evaluation` event in `audit_log`.

---

## How the audit log works

Every significant event writes a row to the `audit_log` table: org creation,
wallet derivation, key registration, policy creation, policy evaluation
(allow or deny), and every signing request. The `GET /organizations/audit-log`
endpoint returns a paginated, filterable view of this table scoped to the
requesting org.

Vault maintains its own independent audit log at `/vault/logs/audit.log`
recording every Transit encrypt and decrypt call, keyed by the calling token.
This means every DEK access has two independent records: one in PostgreSQL
and one in Vault.

---

## How API keys and scopes work

Every API key has a `scopes` array. The default is `["*"]` (all actions). A
narrowed key can be locked to specific operations:

- `wallet:read` — read wallets and signing history
- `wallet:create` — derive new wallet addresses
- `wallet:sign` — sign transactions and messages
- `policy:write` — create and delete policies
- `key:write` — register and revoke API keys, create and delete users

The `ScopesGuard` enforces scope on sensitive routes after stamp verification.
An otherwise-valid stamp from a key that lacks the required scope gets `403
insufficient_scope`.

---

## How nonce management works

Each wallet has a row in `wallet_nonces` per chain. The counter starts at 0
and increments atomically on every signing request. The nonce is reserved
before signing, not after — so even if the broadcast fails, that nonce slot
is consumed and the next request gets the next nonce.

This is intentional. Reusing a nonce risks a double-spend if the original
transaction was accepted by the network but the RPC timed out before
returning confirmation. Gaps in the nonce sequence are harmless.

If a wallet's on-chain nonce diverges from the database counter (for example
after a transaction is dropped and the counter drifts), the nonce can be
re-synced from the chain using `eth_getTransactionCount(..., 'pending')` with
a guard that prevents backwards movement.

---

## What happens between services on a signing request

```
Client
  │  POST /wallets/:id/sign-transaction  (X-Stamp)
  ▼
NestJS API
  │  1. Verify stamp                    → api_keys table
  │  2. Idempotency check               → signing_requests table
  │  3. Policy evaluation               → policies table
  │  4. Gas estimation                  → external RPC
  │  5. Reserve nonce (atomic upsert)   → wallet_nonces table
  │  6. Read org seed ciphertext        → organization_seeds table
  │  7. POST /wallet/sign-transaction   → Go crypto service
  ▼
Go crypto service
  │  8. Unwrap DEK                      → Vault Transit decrypt
  │  9. Decrypt seed (AES-256-GCM)
  │  10. Derive child key (BIP32)
  │  11. RLP encode + keccak256 hash
  │  12. secp256k1 sign
  │  13. Zero all key material
  │  returns {signature, txHash, rawTx}
  ▼
NestJS API
  │  14. Update signing_requests status=signed
  │  15. eth_sendRawTransaction          → external RPC
  │  16. Update signing_requests status=broadcasted
  │  17. Write audit_log
  │  returns {signingRequestId, txHash, status: "broadcasted"}
  ▼
Client
     polls GET /wallets/:id/signing-requests/:requestId for confirmation
```

---

## What is and is not stored in plaintext

| Data                    | Stored as         | Where              |
| ----------------------- | ----------------- | ------------------ |
| Organization seed       | AES-256-GCM ciphertext | organization_seeds |
| DEK                     | Vault Transit ciphertext (`vault:v1:...`) | organization_seeds |
| Child private keys      | Never stored      | —                  |
| Wallet addresses        | Plaintext         | wallets            |
| Signed transaction hash | Plaintext         | signing_requests   |
| API key public keys     | Plaintext         | api_keys           |
| Bootstrap token         | SHA-256 hash only | organizations      |
| Vault KEK               | Never leaves Vault | Vault Transit     |

A full PostgreSQL dump exposes wallet addresses (public), transaction hashes
(public), and public keys (public). Nothing in the dump enables an attacker
to sign transactions or derive private keys without also compromising the Go
crypto service and Vault simultaneously.

---

## See Also

- `ARCHITECTURE.md` — component definitions and communication map
- `KEY_MANAGEMENT.md` — cryptographic decisions, key hierarchy, security properties
- `STAMP_AUTH.md` — stamp construction, replay protection, bootstrap flow
- `CRYPTO_SERVICE.md` — Go service endpoint reference and auth token guide
- `VAULT.md` — Vault concepts, Transit engine, key rotation
- `SEQUENCE_DIAGRAMS.md` — Mermaid diagrams for every major flow
- `API.md` — full API reference with curl examples
