# Go Crypto Service — API Reference & Operations

The Go crypto service (`cmd/crypto/`) is the **single cryptographic boundary**
of the platform. It is the only component that ever handles plaintext key
material. NestJS talks to it over the internal Docker network; **you should
never call it directly from outside the stack** — but this reference covers
the endpoints, the shared-secret auth, and how to get the token.

---

## Authentication

Every endpoint **except `GET /health`** requires the shared secret on the
`X-Crypto-Token` header:

```
X-Crypto-Token: <CRYPTO_AUTH_TOKEN>
```

- The token is compared with a constant-time comparison.
- A missing or wrong token returns `401 {"error":"unauthorized"}`.
- The service **refuses to start** if `CRYPTO_AUTH_TOKEN` is not set
  (fail closed).

### How to get the auth token

The token is a shared secret between the NestJS API and the Go service. It is
not issued by Vault or by any API — you generate it yourself:

```bash
openssl rand -hex 32
# example output: 4f2a9c1e... (64 hex chars)
```

Put it in `.env` (gitignored — never commit it):

```
# .env
CRYPTO_AUTH_TOKEN=4f2a9c1e...
```

Both the `api` and `crypto` containers load `.env` (see `docker-compose.yml`).
> Production note: give each service its own env file (e.g. `.env.crypto`) so
> the API container never holds the token it does not need.

### How to test the token works

```bash
# /health is unauthenticated — liveness only
curl -s http://localhost:4000/health
# OK

# everything else requires the token
curl -s -X POST http://localhost:4000/wallet/create \
  -H 'Content-Type: application/json' \
  -H "X-Crypto-Token: $CRYPTO_AUTH_TOKEN" \
  -d '{}'
```

> `localhost:4000` only works if you are running the Go service on the host.
> Inside the stack, NestJS reaches it at `http://crypto:4000` and the port is
> **not published to the host** — see `docker-compose.dev.yml` if you need
> host access for debugging.

---

## Environment variables

| Variable            | Required | Description                                                       |
| ------------------- | -------- | ----------------------------------------------------------------- |
| `VAULT_ADDR`        | yes      | Vault base URL, e.g. `http://vault:8200`                          |
| `VAULT_ROLE_ID`     | yes      | AppRole RoleID for the `wallet-signer` role (not secret)          |
| `VAULT_SECRET_ID`   | yes      | AppRole SecretID (secret — rotate every 30 days, see VAULT_INIT.md) |
| `CRYPTO_AUTH_TOKEN` | yes      | Shared secret required on every request (see above)               |
| `CRYPTO_PORT`       | no       | Listen port (default `4000`)                                      |

The service fails to start if `VAULT_ADDR`, `VAULT_ROLE_ID`,
`VAULT_SECRET_ID`, or `CRYPTO_AUTH_TOKEN` are missing.

---

## Endpoints

### `GET /health`

Unauthenticated liveness probe.

```
200 OK
OK
```

---

### `POST /wallet/create`

Generates a BIP39 mnemonic + seed, encrypts the seed with a fresh random DEK
(AES-256-GCM), wraps the DEK via Vault Transit, and derives the first address
(`m/44'/60'/0'/0/0`). All plaintext key material is zeroed before the
response is written.

Request: any valid JSON body (the body is validated but unused).

Response `201 Created`:

```json
{
  "encryptedSeed": "<base64: nonce||ciphertext||authTag>",
  "seedNonce": "<base64: 12-byte GCM nonce>",
  "encryptedDek": "vault:v1:...",
  "firstAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
}
```

Example:

```bash
curl -s -X POST http://localhost:4000/wallet/create \
  -H 'Content-Type: application/json' \
  -H "X-Crypto-Token: $CRYPTO_AUTH_TOKEN" \
  -d '{}'
```

---

### `POST /wallet/derive`

Decrypts the org seed and derives the child address at `derivIndex`
(path `m/44'/60'/0'/0/<derivIndex>`).

Request:

```json
{
  "encryptedSeed": "<from /wallet/create>",
  "seedNonce": "<from /wallet/create>",
  "encryptedDek": "vault:v1:...",
  "derivIndex": 1
}
```

Response `200 OK`:

```json
{
  "address": "0x...",
  "derivationPath": "m/44'/60'/0'/0/1"
}
```

Example:

```bash
curl -s -X POST http://localhost:4000/wallet/derive \
  -H 'Content-Type: application/json' \
  -H "X-Crypto-Token: $CRYPTO_AUTH_TOKEN" \
  -d '{
    "encryptedSeed": "...",
    "seedNonce": "...",
    "encryptedDek": "vault:v1:...",
    "derivIndex": 1
  }'
```

---

### `POST /wallet/sign-transaction` (alias: `POST /wallet/sign`)

Decrypts the seed, derives the child key at `derivationPath`, RLP-encodes the
EIP-1559 transaction, computes the keccak256 hash **in Go**, signs it, and
returns the signature, hash, and the fully serialised raw transaction.

Request:

```json
{
  "encryptedSeed": "...",
  "seedNonce": "...",
  "encryptedDek": "vault:v1:...",
  "derivationPath": "m/44'/60'/0'/0/0",
  "txFields": {
    "chainId": 84532,
    "nonce": 0,
    "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "value": "1000000000000000000",
    "gasLimit": 21000,
    "maxFeePerGas": "30000000000",
    "maxPriorityFeePerGas": "1000000000",
    "data": "0x"
  }
}
```

Response `200 OK`:

```json
{
  "signature": "0x<65-byte hex r||s||v>",
  "txHash": "0x<32-byte keccak256 hex>",
  "rawTx": "0x<RLP-encoded signed transaction>"
}
```

Example:

```bash
curl -s -X POST http://localhost:4000/wallet/sign-transaction \
  -H 'Content-Type: application/json' \
  -H "X-Crypto-Token: $CRYPTO_AUTH_TOKEN" \
  -d '{
    "encryptedSeed": "...",
    "seedNonce": "...",
    "encryptedDek": "vault:v1:...",
    "derivationPath": "m/44'\''/60'\''/0'\''/0/0",
    "txFields": {
      "chainId": 84532,
      "nonce": 0,
      "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "value": "1000000000000000000",
      "gasLimit": 21000,
      "maxFeePerGas": "30000000000",
      "maxPriorityFeePerGas": "1000000000",
      "data": "0x"
    }
  }'
```

`rawTx` is what you hand to `eth_sendRawTransaction`.

---

### `POST /wallet/sign-hash`

Signs a raw 32-byte hash with the derived key. No encoding, no
interpretation — used for EIP-712 typed data and EIP-191 personal messages
(the caller constructs the hash). This is a **signing oracle by design**:
NestJS gates it (scope checks + EIP-712 domain allowlist) — see
`docs/STAMP_AUTH.md` and `docs/TASKS.md`.

Request:

```json
{
  "encryptedSeed": "...",
  "seedNonce": "...",
  "encryptedDek": "vault:v1:...",
  "derivationPath": "m/44'/60'/0'/0/0",
  "hashHex": "0x<64 hex chars — exactly 32 bytes>"
}
```

Response `200 OK`:

```json
{
  "signature": "0x<65-byte hex r||s||v>"
}
```

The hash must be exactly 32 bytes — anything else is rejected with
`400 {"error":"hash must be 32 bytes, got N"}`.

---

## Input validation & hardening

The service validates every field before it can influence a signature:

- `chainId` must be positive
- `value` must be a non-negative decimal string
- `maxFeePerGas` must be positive; `maxPriorityFeePerGas` non-negative
- `gasLimit` must be positive
- `to` must be empty (contract creation) or a valid 40-hex-char address
- `data` must be valid hex
- `derivationPath` must match `m/44'/60'/0'/0/<index>`
- Request bodies are capped at **1 MiB** (`http.MaxBytesReader`)
- The HTTP server enforces read/write/idle timeouts and a 1 MiB header cap

## Error responses

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| 400    | Invalid JSON body or a validation failure (`{"error":"..."}`)  |
| 401    | Missing or wrong `X-Crypto-Token` (`{"error":"unauthorized"}`) |
| 405    | Wrong HTTP method                                              |
| 500    | Internal crypto / Vault failure (details logged, never leaked) |
