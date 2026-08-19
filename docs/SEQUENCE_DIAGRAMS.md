# WalletMVP — Sequence Diagrams

All diagrams reflect the current architecture:

- Go crypto service is a long-lived HTTP sidecar (not a spawned process)
- Go owns all cryptographic operations including Vault calls
- NestJS never holds a Vault token or any plaintext key material
- txHash is computed inside Go (RLP encode → keccak256), not in NestJS
- `POST /organizations` creates and onboards in one request — there is no separate onboard step
- Flat routes: `/api-keys`, `/policies`, `/users`, `/wallets` — not org-scoped prefixes

---

## 1. Go Crypto Service startup — AppRole login and token renewal

```mermaid
sequenceDiagram
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault

    note over GO: Container starts
    GO->>GO: Read VAULT_ADDR, VAULT_ROLE_ID, VAULT_SECRET_ID, CRYPTO_AUTH_TOKEN from env
    GO->>V: POST /v1/auth/approle/login {role_id, secret_id}
    V-->>GO: {client_token, lease_duration: 3600}
    GO->>GO: Store token in memory
    GO->>GO: Start HTTP server on CRYPTO_PORT (every request except /health requires X-Crypto-Token)
    GO->>GO: Start token renewal timer (fires at 75% of TTL = ~45 min)

    note over GO,V: Token renewal loop (every ~45 min)
    GO->>V: POST /v1/auth/token/renew-self
    V-->>GO: {client_token, lease_duration: 3600}
    GO->>GO: Reset renewal timer

    note over GO: On shutdown — token revoked automatically by TTL
```

---

## 2. Organization creation — onboarding baked in

`POST /organizations` is public (no stamp). It creates the org record, generates
the BIP39 seed, stores all ciphertext, derives the first wallet, and returns a
one-time bootstrap token. There is no separate onboard endpoint.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault

    C->>API: POST /organizations {name, slug}
    note over API: No X-Stamp — public endpoint

    API->>DB: INSERT organizations (name, slug)
    DB-->>API: org row

    API->>WS: onboardOrganization(orgId)
    WS->>GO: POST /wallet/create {X-Crypto-Token}

    note over GO: All key generation happens here
    GO->>GO: Generate 256-bit entropy
    GO->>GO: entropy → 24-word BIP39 mnemonic
    GO->>GO: mnemonic + PBKDF2 → 64-byte seed
    GO->>GO: Generate 32-byte DEK (random)
    GO->>GO: Generate 12-byte GCM nonce (random)
    GO->>GO: AES-256-GCM encrypt(seed, DEK, nonce) → encryptedSeed

    GO->>V: POST /v1/transit/encrypt/wallet-dek {plaintext: base64(DEK)}
    V-->>GO: {ciphertext: "vault:v1:..."}

    GO->>GO: BIP32 derive m/44'/60'/0'/0/0 from seed → child keypair
    GO->>GO: child pubkey → EIP-55 Ethereum address
    GO->>GO: Zero: mnemonic, seed, DEK, child private key

    GO-->>WS: {encryptedSeed, seedNonce, encryptedDek, firstAddress}

    WS->>DB: INSERT organization_seeds (orgId, encryptedSeed, seedNonce, encryptedDek)
    WS->>DB: INSERT wallets (orgId, address=firstAddress, derivIndex=0)
    WS->>DB: Generate bootstrap token → store SHA-256 hash in organizations.bootstrap_token_hash
    WS->>DB: INSERT audit_log (event=org_onboarded, orgId)

    WS-->>API: {orgId, firstAddress, bootstrapToken}
    API-->>C: 201 Created {id, slug, name, firstAddress, bootstrapToken}

    note over C: bootstrapToken shown once — use immediately to register first API key
```

---

## 3. API key registration — bootstrap path (first key)

The first key for an org uses `X-Bootstrap-Token` instead of `X-Stamp`.
After registration the bootstrap token is cleared and can never be used again.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant DB as PostgreSQL

    C->>API: POST /api-keys {name, publicKey, scopes} + X-Bootstrap-Token header
    API->>DB: SELECT organizations WHERE bootstrap_token_hash IS NOT NULL
    DB-->>API: org row

    API->>API: SHA-256(X-Bootstrap-Token) == bootstrap_token_hash? (constant-time)
    API->>DB: SELECT api_keys WHERE orgId=? AND status=active
    DB-->>API: 0 rows (guard: bootstrap only valid before first key exists)

    API->>DB: INSERT api_keys (orgId, name, publicKey, keyId, scopes, status=active)
    API->>DB: UPDATE organizations SET bootstrap_token_hash=null
    API->>DB: INSERT audit_log (event=api_key_registered, orgId)

    API-->>C: 201 Created {id, keyId, name, scopes, createdAt}

    note over C: Save keyId — used in every X-Stamp header from here on
```

---

## 4. API key registration — stamp path (subsequent keys)

Subsequent keys require a valid stamp from an existing key with `key:write` scope.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant Guard as StampVerifierGuard
    participant DB as PostgreSQL

    C->>API: POST /api-keys {name, publicKey, scopes} + X-Stamp header
    API->>Guard: verify stamp

    Guard->>Guard: Parse X-Stamp → signature, timestamp, key_id
    Guard->>Guard: Check timestamp within [now-5min, now+30s]
    Guard->>DB: SELECT api_keys WHERE key_id=?
    DB-->>Guard: api key row (publicKey, scopes, status)
    Guard->>Guard: Check status=active, not expired
    Guard->>Guard: ECDSA verify(payload, signature, publicKey)
    Guard->>Guard: Check scopes includes key:write
    Guard-->>API: {orgId, apiKeyId, scopes}

    API->>DB: INSERT api_keys (orgId, name, publicKey, keyId, scopes, status=active)
    API->>DB: INSERT audit_log (event=api_key_registered, orgId)
    API-->>C: 201 Created {id, keyId, name, scopes, createdAt}
```

---

## 5. Child wallet derivation

Called when an org needs a new wallet address. Derives the next child key from
the existing seed without generating new entropy. `userId` is optional.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault

    C->>API: POST /wallets (X-Stamp) {label, userId?}
    API->>API: Verify stamp signature

    opt userId provided
        API->>DB: SELECT users WHERE id=userId AND orgId=?
        DB-->>API: user row (or 404)
    end

    API->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>API: org seed row (all ciphertext)

    API->>DB: SELECT COUNT(*) FROM wallets WHERE orgId=? → derivIndex N
    DB-->>API: N

    API->>WS: deriveWallet(orgId, label, userId?, N)
    WS->>GO: POST /wallet/derive {encryptedSeed, seedNonce, encryptedDek, derivIndex: N}

    note over GO: Decryption and derivation
    GO->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>GO: {plaintext: base64(DEK)}
    GO->>GO: AES-256-GCM decrypt(encryptedSeed, DEK, nonce) → seed
    GO->>GO: DEK bytes zeroed
    GO->>GO: BIP32 derive m/44'/60'/0'/0/N from seed → child keypair
    GO->>GO: child pubkey → EIP-55 Ethereum address
    GO->>GO: seed bytes zeroed, child private key zeroed

    GO-->>WS: {address, derivationPath: "m/44'/60'/0'/0/N"}

    WS->>DB: INSERT wallets (orgId, userId=null|userId, address, derivationPath, label)
    WS->>DB: INSERT audit_log (event=wallet_created, orgId, userId?, address)

    WS-->>API: {walletId, address}
    API-->>C: 201 Created {walletId, address}
```

---

## 6. Transaction signing — full cycle

The endpoint is `POST /wallets/:id/sign-transaction`. The nonce is always
assigned server-side via atomic upsert. The response returns immediately after
broadcast; `status` reflects the broadcasted state, not confirmed.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant PE as PolicyEngine
    participant GS as GasService
    participant WS as WalletService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault
    participant RPC as External RPC

    C->>API: POST /wallets/:id/sign-transaction (X-Stamp) {txFields: {chainId, to, value, data}}
    API->>API: Verify stamp signature

    API->>DB: SELECT wallet (address, derivationPath, orgId)
    DB-->>API: wallet row

    note over API: Idempotency check
    API->>DB: SELECT signing_requests WHERE idempotency_key=sha256(walletId:chainId:to:value:data)
    DB-->>API: existing row or null
    note over API: If exists and not failed → return immediately

    API->>PE: evaluate(orgId, walletId, txPayload)
    PE->>DB: SELECT policies WHERE orgId=? AND status=active
    DB-->>PE: policy rules
    PE-->>API: allow / deny
    note over API: 403 here if policy denies — no nonce consumed

    API->>GS: estimateFees(to, value, data, chainId)
    GS->>RPC: eth_estimateGas
    RPC-->>GS: gasLimit
    GS->>RPC: eth_feeHistory
    RPC-->>GS: maxFeePerGas, maxPriorityFeePerGas
    GS-->>API: {gasLimit, maxFeePerGas, maxPriorityFeePerGas}

    API->>GS: reserveNonce(walletId, chainId)
    GS->>DB: INSERT wallet_nonces ... ON CONFLICT DO UPDATE SET nonce=nonce+1 RETURNING nonce
    DB-->>GS: reserved nonce (permanent — never released)
    GS-->>API: nonce

    API->>DB: INSERT signing_requests (walletId, idempotency_key, status=pending, nonce)
    DB-->>API: signingRequestId

    API->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>API: org seed row (all ciphertext)

    API->>WS: sign(encryptedSeed, seedNonce, encryptedDek, derivationPath, txFields+nonce+gas)
    WS->>GO: POST /wallet/sign-transaction {encryptedSeed, seedNonce, encryptedDek, derivationPath, txFields}

    note over GO: All crypto happens here
    GO->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>GO: {plaintext: base64(DEK)}
    GO->>GO: AES-256-GCM decrypt(encryptedSeed, DEK, nonce) → seed
    GO->>GO: DEK bytes zeroed
    GO->>GO: BIP32 derive child key at derivationPath from seed
    GO->>GO: seed bytes zeroed
    GO->>GO: RLP-encode txFields (EIP-1559)
    GO->>GO: keccak256(RLP bytes) → txHash
    GO->>GO: secp256k1 sign(txHash, childPrivateKey) → {r, s, v}
    GO->>GO: child private key zeroed

    GO-->>WS: {signature, txHash, rawTx}
    WS-->>API: {signature, txHash, rawTx}

    API->>DB: UPDATE signing_requests SET status=signed, tx_hash=txHash

    API->>GS: broadcastTransaction(rawTx, chainId)
    GS->>RPC: eth_sendRawTransaction(rawTx)
    RPC-->>GS: txHash

    API->>DB: UPDATE signing_requests SET status=broadcasted
    API->>DB: INSERT audit_log (event=tx_signed, orgId, walletId, txHash)

    API-->>C: 200 OK {signingRequestId, txHash, status: "broadcasted"}

    note over C: Poll GET /wallets/:id/signing-requests/:requestId for confirmation
```

---

## 7. Signing request status poll

After receiving `status: "broadcasted"`, clients poll this endpoint to check
for confirmation, failure, or drop.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant DB as PostgreSQL

    C->>API: GET /wallets/:id/signing-requests/:requestId (X-Stamp)
    API->>API: Verify stamp signature
    API->>DB: SELECT signing_requests WHERE id=requestId AND walletId=?
    DB-->>API: signing request row

    API-->>C: 200 OK {signingRequestId, status, txHash, blockNumber?, gasUsed?, effectiveGasPrice?, errorMessage?}
```

---

## 8. EIP-712 typed data signing

The EIP-712 hash is constructed in NestJS using viem's `hashTypedData`.
Go receives a raw 32-byte hash and signs it without interpreting the schema.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault

    C->>API: POST /wallets/:id/sign-typed (X-Stamp) {domain, types, primaryType, message}
    API->>API: Verify stamp signature
    API->>API: Check domain.name against EIP712_DOMAIN_ALLOWLIST (if configured)

    API->>DB: SELECT wallet (derivationPath, orgId)
    DB-->>API: wallet row

    API->>WS: signEip712(orgId, walletId, domain, types, message)
    WS->>WS: hashTypedData(domain, types, primaryType, message) → 32-byte hash (viem)

    WS->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>WS: org seed row

    WS->>GO: POST /wallet/sign-hash {encryptedSeed, seedNonce, encryptedDek, derivationPath, hashHex}

    note over GO: Signs raw hash — no schema awareness
    GO->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>GO: {plaintext: base64(DEK)}
    GO->>GO: AES-256-GCM decrypt(encryptedSeed, DEK, nonce) → seed
    GO->>GO: DEK bytes zeroed
    GO->>GO: BIP32 derive child key at derivationPath from seed
    GO->>GO: seed bytes zeroed
    GO->>GO: secp256k1 sign(hashHex, childPrivateKey) → signature
    GO->>GO: child private key zeroed

    GO-->>WS: {signature}
    WS->>DB: INSERT audit_log (event=typed_data_signed, orgId, walletId)
    WS-->>API: {signature}
    API-->>C: 200 OK {signature}
```

---

## 9. Personal message signing (EIP-191)

Same flow as typed signing. NestJS constructs the EIP-191 prefixed hash;
Go signs the raw 32 bytes.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault

    C->>API: POST /wallets/:id/sign-message (X-Stamp) {message}
    API->>API: Verify stamp signature

    API->>DB: SELECT wallet (derivationPath, orgId)
    DB-->>API: wallet row

    API->>WS: signPersonalMessage(orgId, walletId, message)
    WS->>WS: hashMessage(message) → keccak256("\x19Ethereum Signed Message:\n" + len + message) → 32-byte hash

    WS->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>WS: org seed row

    WS->>GO: POST /wallet/sign-hash {encryptedSeed, seedNonce, encryptedDek, derivationPath, hashHex}

    GO->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>GO: {plaintext: base64(DEK)}
    GO->>GO: AES-256-GCM decrypt → seed, derive child key, sign hash, zero all key material
    GO-->>WS: {signature}

    WS->>DB: INSERT audit_log (event=message_signed, orgId, walletId)
    WS-->>API: {signature}
    API-->>C: 200 OK {signature}
```

---

## 10. Policy creation

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant DB as PostgreSQL

    C->>API: POST /policies (X-Stamp) {name, ruleType, ruleConfig}
    API->>API: Verify stamp signature
    API->>API: Check scopes includes policy:write

    API->>DB: INSERT policies (orgId, name, ruleType, ruleConfig, status=active)
    DB-->>API: policy row

    API->>DB: INSERT audit_log (event=policy_created, orgId)
    API-->>C: 201 Created {id, name, ruleType, status, createdAt}
```

---

## 11. Audit log retrieval

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant DB as PostgreSQL

    C->>API: GET /organizations/audit-log?event=...&limit=...&offset=... (X-Stamp)
    API->>API: Verify stamp signature

    API->>DB: SELECT audit_log WHERE orgId=? [AND event=?] ORDER BY created_at DESC LIMIT ? OFFSET ?
    DB-->>API: audit log rows

    API-->>C: 200 OK [{id, event, status, metadata, createdAt, ...}]
```

---

## 12. SecretID rotation (manual, every 30 days)

The Go crypto service does **not** self-rotate the SecretID. It is valid for
30 days (`secret_id_ttl=720h`) with unlimited uses; rotate it manually before
the TTL expires:

```bash
source .env.vault
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
# then update VAULT_SECRET_ID in .env and restart the crypto container
```

> Historical note: an earlier design had the Go service generate a new
> single-use SecretID after every login (self-rotation on startup). That code
> path was removed — see `docs/VAULT.md` → "SecretID rotation".
