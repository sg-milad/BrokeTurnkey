package main

import (
	"bytes"
	"strings"
	"testing"
)

// knownVector is a well-known BIP39 test vector used to verify DeriveAddress
// produces a deterministic, correct result.
// Mnemonic source: BIP39 reference — 256-bit entropy test vector.
// Address verified independently with ethers.js:
//
//	const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath("m/44'/60'/0'/0/0")
//	wallet.address → "0x..."
const knownMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
const knownAddress0 = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb" // m/44'/60'/0'/0/0
const knownAddress1 = "0xf785bD075874b8423D3583728a981399f31e95aA" // m/44'/60'/0'/0/1
// --------------------------------------------------------------------------
// GenerateMnemonic
// --------------------------------------------------------------------------

func TestGenerateMnemonic_Length(t *testing.T) {
	mnemonic, err := GenerateMnemonic()
	if err != nil {
		t.Fatalf("GenerateMnemonic failed: %v", err)
	}

	words := strings.Fields(mnemonic)
	if len(words) != 24 {
		t.Errorf("expected 24 words, got %d: %q", len(words), mnemonic)
	}
}

func TestGenerateMnemonic_Uniqueness(t *testing.T) {
	a, err := GenerateMnemonic()
	if err != nil {
		t.Fatalf("first GenerateMnemonic failed: %v", err)
	}
	b, err := GenerateMnemonic()
	if err != nil {
		t.Fatalf("second GenerateMnemonic failed: %v", err)
	}

	if a == b {
		t.Error("two sequential mnemonics are identical — entropy source may be broken")
	}
}

// --------------------------------------------------------------------------
// MnemonicToSeed
// --------------------------------------------------------------------------

func TestMnemonicToSeed_Length(t *testing.T) {
	mnemonic, _ := GenerateMnemonic()

	seed, err := MnemonicToSeed(mnemonic)
	if err != nil {
		t.Fatalf("MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed)

	if len(seed) != 64 {
		t.Errorf("expected 64-byte seed, got %d bytes", len(seed))
	}
}

func TestMnemonicToSeed_Deterministic(t *testing.T) {
	mnemonic, _ := GenerateMnemonic()

	seed1, err := MnemonicToSeed(mnemonic)
	if err != nil {
		t.Fatalf("first MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed1)

	seed2, err := MnemonicToSeed(mnemonic)
	if err != nil {
		t.Fatalf("second MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed2)

	if !bytes.Equal(seed1, seed2) {
		t.Error("same mnemonic produced different seeds — PBKDF2 is not deterministic")
	}
}

func TestMnemonicToSeed_InvalidMnemonic(t *testing.T) {
	_, err := MnemonicToSeed("this is not a valid mnemonic phrase at all")
	if err == nil {
		t.Fatal("expected error for invalid mnemonic, got nil")
	}
}

// --------------------------------------------------------------------------
// GenerateDEK
// --------------------------------------------------------------------------

func TestGenerateDEK_Length(t *testing.T) {
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatalf("GenerateDEK failed: %v", err)
	}
	defer ZeroBytes(dek)

	if len(dek) != 32 {
		t.Errorf("expected 32-byte DEK, got %d bytes", len(dek))
	}
}

func TestGenerateDEK_Uniqueness(t *testing.T) {
	a, _ := GenerateDEK()
	b, _ := GenerateDEK()
	defer ZeroBytes(a)
	defer ZeroBytes(b)

	if bytes.Equal(a, b) {
		t.Error("two sequential DEKs are identical — entropy source may be broken")
	}
}

// --------------------------------------------------------------------------
// EncryptSeed / DecryptSeed
// --------------------------------------------------------------------------

func TestEncryptDecryptSeed_RoundTrip(t *testing.T) {
	mnemonic, _ := GenerateMnemonic()
	seed, err := MnemonicToSeed(mnemonic)
	if err != nil {
		t.Fatalf("MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed)

	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	encryptedSeed, nonce, err := EncryptSeed(seed, dek)
	if err != nil {
		t.Fatalf("EncryptSeed failed: %v", err)
	}

	recovered, err := DecryptSeed(encryptedSeed, nonce, dek)
	if err != nil {
		t.Fatalf("DecryptSeed failed: %v", err)
	}
	defer ZeroBytes(recovered)

	if !bytes.Equal(seed, recovered) {
		t.Error("decrypted seed does not match original")
	}
}

func TestEncryptSeed_NonceIsRandom(t *testing.T) {
	seed := make([]byte, 64)
	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	_, nonce1, _ := EncryptSeed(seed, dek)
	_, nonce2, _ := EncryptSeed(seed, dek)

	if bytes.Equal(nonce1, nonce2) {
		t.Error("two encryptions produced the same nonce — nonce generation is broken")
	}
}

func TestEncryptSeed_SamePlaintextDifferentCiphertext(t *testing.T) {
	seed := make([]byte, 64)
	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	ct1, _, _ := EncryptSeed(seed, dek)
	ct2, _, _ := EncryptSeed(seed, dek)

	if bytes.Equal(ct1, ct2) {
		t.Error("same plaintext + same key produced identical ciphertext — nonce reuse")
	}
}

func TestDecryptSeed_TamperedCiphertext(t *testing.T) {
	seed := make([]byte, 64)
	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	encryptedSeed, nonce, _ := EncryptSeed(seed, dek)

	// Flip one bit in the ciphertext.
	encryptedSeed[0] ^= 0xFF

	_, err := DecryptSeed(encryptedSeed, nonce, dek)
	if err == nil {
		t.Fatal("expected DecryptSeed to fail with tampered ciphertext, got nil")
	}
}

func TestDecryptSeed_WrongDEK(t *testing.T) {
	seed := make([]byte, 64)
	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	encryptedSeed, nonce, _ := EncryptSeed(seed, dek)

	wrongDEK, _ := GenerateDEK()
	defer ZeroBytes(wrongDEK)

	_, err := DecryptSeed(encryptedSeed, nonce, wrongDEK)
	if err == nil {
		t.Fatal("expected DecryptSeed to fail with wrong DEK, got nil")
	}
}

func TestDecryptSeed_WrongNonce(t *testing.T) {
	seed := make([]byte, 64)
	dek, _ := GenerateDEK()
	defer ZeroBytes(dek)

	encryptedSeed, nonce, _ := EncryptSeed(seed, dek)

	// Flip one bit in the nonce.
	nonce[0] ^= 0xFF

	_, err := DecryptSeed(encryptedSeed, nonce, dek)
	if err == nil {
		t.Fatal("expected DecryptSeed to fail with wrong nonce, got nil")
	}
}

func TestEncryptSeed_BadDEKLength(t *testing.T) {
	seed := make([]byte, 64)
	shortDEK := make([]byte, 16) // AES-128, not AES-256

	_, _, err := EncryptSeed(seed, shortDEK)
	if err == nil {
		t.Fatal("expected error for 16-byte DEK, got nil")
	}
}

// --------------------------------------------------------------------------
// DeriveAddress — known-vector tests
// --------------------------------------------------------------------------

func TestDeriveAddress_KnownVector_Index0(t *testing.T) {
	seed, err := MnemonicToSeed(knownMnemonic)
	if err != nil {
		t.Fatalf("MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed)

	address, privKey, err := DeriveAddress(seed, 0)
	if err != nil {
		t.Fatalf("DeriveAddress failed: %v", err)
	}
	defer ZeroBytes(privKey)

	if address != knownAddress0 {
		t.Errorf("address mismatch at index 0\n  got:  %s\n  want: %s", address, knownAddress0)
	}
	t.Logf("index 0 address: %s", address)
}

func TestDeriveAddress_KnownVector_Index1(t *testing.T) {
	seed, err := MnemonicToSeed(knownMnemonic)
	if err != nil {
		t.Fatalf("MnemonicToSeed failed: %v", err)
	}
	defer ZeroBytes(seed)

	address, privKey, err := DeriveAddress(seed, 1)
	if err != nil {
		t.Fatalf("DeriveAddress failed: %v", err)
	}
	defer ZeroBytes(privKey)

	if address != knownAddress1 {
		t.Errorf("address mismatch at index 1\n  got:  %s\n  want: %s", address, knownAddress1)
	}
	t.Logf("index 1 address: %s", address)
}

func TestDeriveAddress_Deterministic(t *testing.T) {
	seed, _ := MnemonicToSeed(knownMnemonic)
	defer ZeroBytes(seed)

	addr1, priv1, _ := DeriveAddress(seed, 0)
	addr2, priv2, _ := DeriveAddress(seed, 0)
	defer ZeroBytes(priv1)
	defer ZeroBytes(priv2)

	if addr1 != addr2 {
		t.Errorf("same seed+index produced different addresses: %s vs %s", addr1, addr2)
	}
	if !bytes.Equal(priv1, priv2) {
		t.Error("same seed+index produced different private keys")
	}
}

func TestDeriveAddress_DifferentIndexesDifferentAddresses(t *testing.T) {
	seed, _ := MnemonicToSeed(knownMnemonic)
	defer ZeroBytes(seed)

	addr0, priv0, _ := DeriveAddress(seed, 0)
	addr1, priv1, _ := DeriveAddress(seed, 1)
	defer ZeroBytes(priv0)
	defer ZeroBytes(priv1)

	if addr0 == addr1 {
		t.Error("different indexes produced the same address")
	}
	if bytes.Equal(priv0, priv1) {
		t.Error("different indexes produced the same private key")
	}
}

func TestDeriveAddress_PrivKeyLength(t *testing.T) {
	seed, _ := MnemonicToSeed(knownMnemonic)
	defer ZeroBytes(seed)

	_, privKey, err := DeriveAddress(seed, 0)
	if err != nil {
		t.Fatalf("DeriveAddress failed: %v", err)
	}
	defer ZeroBytes(privKey)

	if len(privKey) != 32 {
		t.Errorf("expected 32-byte private key, got %d bytes", len(privKey))
	}
}

func TestDeriveAddress_EIP55Format(t *testing.T) {
	seed, _ := MnemonicToSeed(knownMnemonic)
	defer ZeroBytes(seed)

	address, privKey, err := DeriveAddress(seed, 0)
	if err != nil {
		t.Fatalf("DeriveAddress failed: %v", err)
	}
	defer ZeroBytes(privKey)

	if !strings.HasPrefix(address, "0x") {
		t.Errorf("address missing 0x prefix: %s", address)
	}
	if len(address) != 42 {
		t.Errorf("expected 42-char address (0x + 40 hex), got %d chars: %s", len(address), address)
	}
	// EIP-55: address must not be all-lowercase (it has mixed case checksum).
	lower := strings.ToLower(address)
	upper := strings.ToUpper(address)
	if address == lower || address == upper {
		t.Errorf("address does not appear to be EIP-55 checksummed: %s", address)
	}
}

// --------------------------------------------------------------------------
// ZeroBytes
// --------------------------------------------------------------------------

func TestZeroBytes(t *testing.T) {
	b := []byte{0x01, 0x02, 0x03, 0xFF, 0xAB}
	ZeroBytes(b)

	for i, v := range b {
		if v != 0 {
			t.Errorf("byte at index %d not zeroed, got 0x%02x", i, v)
		}
	}
}

func TestZeroBytes_EmptySlice(t *testing.T) {
	// Should not panic on empty input.
	ZeroBytes([]byte{})
	ZeroBytes(nil)
}

// --------------------------------------------------------------------------
// Full pipeline: GenerateMnemonic → MnemonicToSeed → EncryptSeed →
//                DecryptSeed → DeriveAddress
// --------------------------------------------------------------------------

func TestFullPipeline(t *testing.T) {
	// 1. Generate mnemonic.
	mnemonic, err := GenerateMnemonic()
	if err != nil {
		t.Fatalf("GenerateMnemonic: %v", err)
	}

	// 2. Derive seed.
	seed, err := MnemonicToSeed(mnemonic)
	if err != nil {
		t.Fatalf("MnemonicToSeed: %v", err)
	}
	defer ZeroBytes(seed)

	// 3. Generate DEK.
	dek, err := GenerateDEK()
	if err != nil {
		t.Fatalf("GenerateDEK: %v", err)
	}
	defer ZeroBytes(dek)

	// 4. Encrypt seed.
	encryptedSeed, nonce, err := EncryptSeed(seed, dek)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}

	// 5. Decrypt seed.
	recoveredSeed, err := DecryptSeed(encryptedSeed, nonce, dek)
	if err != nil {
		t.Fatalf("DecryptSeed: %v", err)
	}
	defer ZeroBytes(recoveredSeed)

	if !bytes.Equal(seed, recoveredSeed) {
		t.Fatal("recovered seed does not match original after encrypt/decrypt")
	}

	// 6. Derive address from the recovered seed.
	address, privKey, err := DeriveAddress(recoveredSeed, 0)
	if err != nil {
		t.Fatalf("DeriveAddress: %v", err)
	}
	defer ZeroBytes(privKey)

	if !strings.HasPrefix(address, "0x") || len(address) != 42 {
		t.Errorf("unexpected address format: %s", address)
	}

	t.Logf("pipeline OK — address: %s", address)
}
