# WalletMVP — Sequence Diagrams

All diagrams reflect the current architecture:

- Go crypto service is a long-lived HTTP sidecar (not a spawned process)
- Go owns all cryptographic operations including Vault calls
- NestJS never holds a Vault token or any plaintext key material
- txHash is computed inside Go (RLP encode → keccak256), not in NestJS

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

## 2. organization creation & onboarding — create org, generate and store seed

Called once via `POST /organizations`. Creates the organization record,
generates the master BIP39 seed from which all their wallet addresses will
be derived, derives the first signing wallet, and returns a one-time
bootstrap token.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant GC as Go Crypto Service
    participant V as Vault
    participant DB as PostgreSQL

    C->>API: POST /organizations (Public, no stamp)
    API->>DB: INSERT organizations (id, name, slug)
    note over API: orgId generated as UUID, no seed yet
    API->>API: onboardOrganization(orgId)
    API->>WS: onboardorganization(orgId)

    WS->>GO: POST /wallet/create {X-Crypto-Token: CRYPTO_AUTH_TOKEN}

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
    WS->>DB: INSERT audit_log (event=org_onboarded, orgId)

    WS-->>API: {orgId, firstAddress}
    API-->>C: 201 Created {orgId, firstAddress}
```

---

## 3. Child wallet derivation

Called when an organization needs a new wallet address. Derives the next
child key from the existing org seed without generating new entropy. `userId`
is optional — omit it for system wallets (treasury, deployer, etc.).

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
    API->>WS: deriveWallet(orgId, label, userId?)

    opt userId provided
        WS->>DB: SELECT user WHERE id=userId AND orgId=?
        DB-->>WS: user row (or 404 if not found / wrong org)
    end

    WS->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>WS: org seed row (all ciphertext)

    WS->>DB: SELECT COUNT(*) FROM wallets WHERE orgId=? → derivIndex N
    DB-->>WS: N

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

## 4. Transaction signing — full cycle

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant PE as PolicyEngine
    participant WS as WalletService
    participant GS as GasService
    participant DB as PostgreSQL
    participant GO as Go Crypto Service
    participant V as HashiCorp Vault
    participant RPC as External RPC

    C->>API: POST /wallets/:id/sign (X-Stamp) {to, value, data, chainId}
    API->>API: Verify stamp signature

    API->>DB: SELECT wallet (address, derivationPath, orgId, userId)
    DB-->>API: wallet row

    API->>PE: evaluate(orgId, walletId, txPayload)
    PE->>DB: SELECT policies WHERE orgId=?
    DB-->>PE: policy rules
    PE-->>API: allow / deny

    note over API: Abort here if policy denies

    API->>GS: prepareTx(walletId, txPayload)
    GS->>RPC: eth_estimateGas
    RPC-->>GS: gasLimit
    GS->>RPC: eth_gasPrice / eth_maxFeePerGas
    RPC-->>GS: fee data
    GS->>DB: SELECT + lock nonce FROM wallet_nonces WHERE walletId=?
    DB-->>GS: nonce
    GS-->>API: {nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas}

    API->>WS: requestSign(orgId, walletId, txFields)

    WS->>DB: SELECT encryptedSeed, seedNonce, encryptedDek FROM organization_seeds WHERE orgId=?
    DB-->>WS: org seed row (all ciphertext)

    WS->>GO: POST /wallet/sign {encryptedSeed, seedNonce, encryptedDek, derivationPath, txFields}

    note over GO: All crypto happens here — NestJS receives only the signature
    GO->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>GO: {plaintext: base64(DEK)}
    GO->>GO: AES-256-GCM decrypt(encryptedSeed, DEK, nonce) → seed
    GO->>GO: DEK bytes zeroed
    GO->>GO: BIP32 derive child key at derivationPath from seed
    GO->>GO: seed bytes zeroed
    GO->>GO: RLP-encode txFields (EIP-1559 or legacy format)
    GO->>GO: keccak256(RLP bytes) → txHash
    GO->>GO: secp256k1 sign(txHash, childPrivateKey) → {r, s, v}
    GO->>GO: child private key zeroed

    GO-->>WS: {signature: "0x...", txHash: "0x..."}

    WS->>DB: INSERT signing_requests (walletId, txHash, status=signed)
    WS-->>API: {signature, txHash}

    API->>GS: broadcast(txFields, signature)
    GS->>RPC: eth_sendRawTransaction(signedTx)
    RPC-->>GS: txHash (confirmed)
    GS->>DB: UPDATE wallet_nonces SET nonce=nonce+1 WHERE walletId=?

    API->>DB: INSERT audit_log (event=tx_signed, orgId, walletId, txHash)
    API-->>C: 200 OK {signature, txHash}
```

---

## 5. SecretID rotation (manual, every 30 days)

The Go crypto service does **not** self-rotate the SecretID. It is valid for
30 days (`secret_id_ttl=720h`) with unlimited uses; you rotate it manually
before the TTL expires (full procedure in `docs/VAULT_INIT.md`):

```bash
source .env
docker exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" walletmvp-vault \
  vault write -f auth/approle/role/wallet-signer/secret-id
# then update VAULT_SECRET_ID in .env and restart the crypto container
```

> Historical note: an earlier design had the Go service generate a new
> single-use SecretID after every login (self-rotation on startup). That code
> path was removed — see `docs/VAULT.md` → "SecretID rotation".
