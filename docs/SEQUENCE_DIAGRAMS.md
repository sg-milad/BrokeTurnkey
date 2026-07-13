# WalletMVP — Sequence Diagrams

---

## 1. Generate wallet seed — encrypt & store

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant V as HashiCorp Vault
    participant DB as PostgreSQL

    C->>API: POST /wallets
    API->>WS: createWallet(orgId, userId)

    WS->>WS: generate BIP39 mnemonic (256-bit)
    WS->>WS: generate 32-byte DEK (random)
    WS->>WS: AES-256-GCM encrypt(seed, DEK) → encrypted_seed + nonce

    WS->>V: POST /v1/transit/encrypt/wallet-dek {plaintext: base64(DEK)}
    V-->>WS: {ciphertext: "vault:v1:..."}

    WS->>DB: INSERT organisations_seeds (encrypted_seed, nonce, encrypted_dek)
    WS->>WS: dek.fill(0) — zero memory

    WS-->>API: walletId, address
    API-->>C: 201 Created {walletId, address}
```

---

## 2. Decrypt seed (called internally before any signing)

```mermaid
sequenceDiagram
    participant WS as WalletService
    participant V as HashiCorp Vault
    participant DB as PostgreSQL

    WS->>DB: SELECT encrypted_seed, nonce, encrypted_dek WHERE org_id = ?
    DB-->>WS: row

    WS->>V: POST /v1/transit/decrypt/wallet-dek {ciphertext: "vault:v1:..."}
    V-->>WS: {plaintext: base64(DEK)}

    WS->>WS: AES-256-GCM decrypt(encrypted_seed, nonce, DEK) → plaintext seed
    WS->>WS: dek.fill(0) — zero memory

    note over WS: plaintext seed lives in memory only.<br/>Caller must zero it after use.
```

---

## 3. Derive child wallet from seed

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant V as HashiCorp Vault
    participant DB as PostgreSQL

    C->>API: POST /wallets (userId, label)
    API->>WS: deriveWallet(orgId, userId)

    note over WS: decrypt seed — see diagram 2
    WS->>V: decrypt DEK
    V-->>WS: plaintext DEK
    WS->>WS: decrypt seed with DEK

    WS->>DB: SELECT COUNT(*) wallets WHERE user_id = ? → index N
    DB-->>WS: N

    WS->>WS: BIP32 derive m/44'/60'/0'/0/N → child keypair
    WS->>WS: derive Ethereum address from child pubkey

    WS->>DB: INSERT wallets (user_id, address, derivation_path, label)
    WS->>WS: seed.fill(0) + dek.fill(0)

    WS-->>API: {walletId, address, derivationPath}
    API-->>C: 201 Created
```

---

## 4. Sign transaction — full cycle

```mermaid
sequenceDiagram
    participant C as Client
    participant API as NestJS API
    participant WS as WalletService
    participant V as HashiCorp Vault
    participant DB as PostgreSQL
    participant GO as Go Signer

    C->>API: POST /wallets/:id/sign {txPayload}
    API->>API: verify P-256 stamp

    API->>DB: SELECT wallet (address, derivation_path, user_id)
    DB-->>API: wallet row

    API->>WS: requestSign(orgId, walletId, txPayload)

    note over WS: decrypt seed — see diagram 2
    WS->>V: decrypt DEK
    V-->>WS: plaintext DEK
    WS->>WS: decrypt seed with DEK

    WS->>GO: stdin: {encryptedSeed, nonce, plaintextDek, derivPath, txHash}

    GO->>GO: AES-GCM decrypt seed
    GO->>GO: BIP32 derive child private key
    GO->>GO: secp256k1 sign txHash
    GO->>GO: zero all key material

    GO-->>WS: stdout: {signature: "r+s+v"}

    WS->>WS: dek.fill(0)
    WS->>DB: INSERT signing_requests (wallet_id, tx_hash, status=signed)

    WS-->>API: signature
    API->>DB: INSERT audit_log (event=tx_signed, org_id, wallet_id, tx_hash)
    API-->>C: 200 OK {signature}
```
