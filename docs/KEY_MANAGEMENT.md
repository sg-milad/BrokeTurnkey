# WalletMVP — Key Management

This document covers every cryptographic decision in the wallet creation and
signing pipeline. It explains what each component does, why it was chosen,
and what the security guarantees and limits are.

---

## The key hierarchy

WalletMVP uses a three-layer key hierarchy. All cryptographic operations on
this hierarchy happen exclusively inside the Go crypto service — NestJS never
touches any key material.

```
Layer 0: Vault KEK (Key Encryption Key)
│
│  Lives inside HashiCorp Vault Transit engine.
│  Never leaves Vault. The Go crypto service calls Vault to use it,
│  but the raw key bytes never appear anywhere outside Vault's memory.
│  Protects: the DEK.
│
└──► Layer 1: DEK (Data Encryption Key)
     │
     │  32 random bytes. One per organisation seed.
     │  Exists briefly in Go crypto service memory during creation and signing.
     │  Stored encrypted (by KEK) in Postgres as "vault:v1:..." ciphertext.
     │  Protects: the wallet seed.
     │
     └──► Layer 2: BIP39 seed (256-bit entropy)
          │
          │  64-byte seed derived from a 24-word mnemonic phrase.
          │  One seed per organisation — all wallets derived from it.
          │  Exists briefly in Go crypto service memory during signing only.
          │  Stored encrypted (by DEK) in Postgres as AES-256-GCM ciphertext.
          │  Protects: all child private keys.
          │
          └──► Derived child private keys (never stored)
               │
               │  Derived on demand via BIP32 at signing time.
               │  Exist only in Go crypto service memory, zeroed immediately.
               │
               └──► Ethereum addresses (public, stored in plaintext)
```

**The rule:** NestJS only ever sees ciphertext. The only plaintext values in
the database are Ethereum addresses, which are public information.

---

## One seed per organisation

WalletMVP follows the same model as Turnkey: one BIP39 mnemonic is generated
per organisation at onboarding time. Every wallet address that organisation
ever needs is derived deterministically from that single seed via BIP32 paths:

```
m/44'/60'/0'/0/0   → first wallet address
m/44'/60'/0'/0/1   → second wallet address
m/44'/60'/0'/0/N   → Nth wallet address
```

No new entropy is needed when adding wallets. The seed is generated once,
encrypted immediately, and the plaintext never persists beyond the Go crypto
service's in-memory handling of the creation request.

---

## BIP39: mnemonic and seed generation

### What BIP39 is

BIP39 is the standard for generating a human-readable mnemonic phrase from
random entropy, and converting it to a binary seed for HD wallet initialisation.

**Stage 1 — Entropy to mnemonic:**
1. Generate 256 bits of random entropy (`crypto/rand` in Go)
2. Compute SHA256; take the first 8 bits as a checksum
3. Concatenate entropy + checksum → split into 11-bit groups
4. Map each group to a word in the BIP39 wordlist (2048 words)
5. Result: 24-word mnemonic phrase

**Stage 2 — Mnemonic to seed:**
1. Apply PBKDF2-HMAC-SHA512:
   - Password: mnemonic phrase (UTF-8 normalised)
   - Salt: `"mnemonic"` (no passphrase in this implementation)
   - Iterations: 2048
   - Output: 64 bytes
2. Result: the 64-byte binary seed

### Why 24 words (256-bit)

128 bits (12 words) is computationally infeasible to brute-force today, but
256 bits provides a margin against future advances and is the standard for
custodial services where you are responsible for other people's funds.

### Where this happens

Entirely inside the Go crypto service. The mnemonic and seed never appear
in NestJS, never cross the HTTP boundary, and are zeroed in Go immediately
after the encrypted seed and first address are produced.

---

## AES-256-GCM: encrypting the seed

### Why AES-256-GCM

AES-256-GCM provides authenticated encryption — confidentiality and integrity
together. If an attacker with DB access modifies the ciphertext, decryption
fails loudly with an authentication error. Without authentication, decryption
would silently produce garbage, potentially causing a corrupted transaction
to be signed.

### Parameters

**Key:** The 32-byte DEK. Randomly generated, unique per organisation seed.

**Nonce (IV):** 12 bytes, randomly generated fresh for every encryption.
Using the same nonce twice with the same key completely breaks GCM security.
Fresh DEK + fresh nonce per org means this never happens.

**Auth tag:** 16 bytes appended by GCM. Must be stored and verified on decrypt.

### What is stored in Postgres

The `encrypted_seed` column stores a base64-encoded blob:
`nonce (12 bytes) || ciphertext (64 bytes) || auth_tag (16 bytes)` = 92 bytes
= ~124 characters as base64.

Storing these together means decryption always has everything it needs in one
field and there is no risk of a nonce/ciphertext mismatch from a partial write.

### Memory lifecycle inside Go crypto service

```
createWallet():
  entropy  = crypto/rand 32 bytes
  mnemonic = bip39.NewMnemonic(entropy)   ← string in Go heap
  seed     = bip39.MnemonicToByteArray()  ← 64-byte slice
  dek      = crypto/rand 32 bytes         ← 32-byte slice
  nonce    = crypto/rand 12 bytes
  encryptedSeed = aesGCMEncrypt(seed, dek, nonce)
  encryptedDek  = vault.Transit.Encrypt(dek)
  zero(dek)                               ← DEK zeroed ✓
  address  = bip32Derive(seed, "m/44'/60'/0'/0/0") → pubkey → address
  zero(seed)                              ← seed zeroed ✓
  zero(childPrivKey)                      ← child key zeroed ✓
  return { encryptedSeed, nonce, encryptedDek, address }
  ← mnemonic string goes out of scope, GC eligible
```

Go strings are immutable (same limitation as JS), so the mnemonic string
cannot be explicitly zeroed. Mitigation: it exists only for the duration of
this function call and is never written to disk or logs.

---

## BIP32: hierarchical deterministic key derivation

### What BIP32 does

BIP32 takes a 64-byte seed and produces a deterministic tree of child key
pairs, addressed by a derivation path. The same seed + same path always
produces the same child key.

### The BIP44 path

`m/44'/60'/0'/0/N`

| Segment | Value | Meaning |
|---|---|---|
| `44'` | BIP44 purpose | Hardened |
| `60'` | Ethereum coin type | Hardened |
| `0'` | Account index | Hardened |
| `0` | External chain | Non-hardened |
| `N` | Address index | Non-hardened, increments per wallet |

The first three levels are hardened, meaning the extended public key at
`m/44'/60'/0'/0` cannot be used to reveal the root seed even if leaked.

### Why child keys are never stored

Storing child private keys multiplies the number of secrets to protect.
Instead, the encrypted seed is the single protected artifact per organisation.
At signing time, the child key is derived in Go memory in microseconds, used
immediately, and zeroed. The derivation is deterministic and fast — there is
no performance reason to cache child keys.

### Go library

The Go crypto service uses `tyler-smith/go-bip32` for BIP32 and
`tyler-smith/go-bip39` for BIP39. Both are standard in the Go Ethereum
ecosystem.

---

## Per-organisation DEK

One DEK per organisation seed (not one global DEK for all organisations).

**Why not one global DEK:**
If a single global DEK is compromised, every encrypted seed in the database
is immediately decryptable — all organisations are exposed simultaneously.

**With per-organisation DEKs:**
A compromised DEK exposes only that organisation's seed. Rotating the
compromised DEK and re-encrypting that organisation's seed contains the damage.

**DEK and Vault key ring distinction:**

- Transit key ring (`wallet-dek`): the KEK. One key ring, managed by Vault,
  versioned. Shared across all organisations.
- DEK: 32 random bytes generated by Go per organisation, encrypted BY the
  key ring. Stored as `"vault:v1:..."` ciphertext in Postgres.

You do not create one Transit key ring per organisation. You have one key
ring and encrypt many different DEKs under it.

---

## Transaction hashing: Go owns it entirely

The Ethereum transaction hash is computed by:
1. RLP-encoding the transaction fields (nonce, gasLimit, maxFeePerGas,
   maxPriorityFeePerGas, to, value, data, chainId, etc.)
2. keccak256-hashing the RLP-encoded bytes

This computation happens inside the Go crypto service, not in NestJS.

**Why Go owns this:**
If NestJS computed the hash and passed it to Go, Go would be blindly signing
whatever bytes it received. A bug or crafted input in NestJS could cause Go
to sign something unintended, with no way for Go to detect this. By receiving
raw transaction fields and computing the hash itself, Go controls the entire
signing surface and knows exactly what it is signing.

NestJS sends `{ to, value, data, chainId, nonce, gasLimit, maxFeePerGas,
maxPriorityFeePerGas }` to Go. Go produces `{ signature, txHash }`.

---

## Address caching

Ethereum addresses are public information — not sensitive. After the Go
service derives an address for the first time during wallet creation or
derivation, NestJS caches it in the `wallets` table alongside the derivation
path and index.

Every subsequent address lookup reads from the cache. No seed decryption
required for address queries.

Always store and return addresses in EIP-55 checksum format (mixed-case hex).
Go's `go-ethereum` crypto package returns EIP-55 format from public key
derivation. Do not lowercase addresses when storing them.

---

## Security properties

| Property | Achieved | How | Limit |
|---|---|---|---|
| Seed never in DB plaintext | ✓ | AES-256-GCM encryption in Go | Compromised DEK + DB = exposed |
| DEK never in DB plaintext | ✓ | Vault Transit wrapping | Compromised Vault = exposed |
| KEK never in application memory | ✓ | Vault handles it internally | Compromised Vault host = exposed |
| Private key never in NestJS process | ✓ | Go crypto service isolation | Go process memory dump (brief window) |
| txHash computed by signer | ✓ | Go RLP + keccak256 | Go must be trusted |
| NestJS has zero Vault access | ✓ | Single AppRole for Go only | NestJS process has no crypto fallback |
| Key material zeroed after use | ✓ | Explicit Go zero loops | Mnemonic string (GC, not zeroable) |
| Audit trail of all decryptions | ✓ | Vault audit log + app audit_log | Log files must be protected |
| Per-org blast radius | ✓ | One DEK per organisation | Compromising Vault exposes all DEKs |
| Key rotation | ✓ | Vault key versioning + rewrap job | Requires background job to complete |
