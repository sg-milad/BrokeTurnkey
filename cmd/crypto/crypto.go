package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"io"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/tyler-smith/go-bip32"
	"github.com/tyler-smith/go-bip39"
)

// --------------------------------------------------------------------------
// GenerateMnemonic generates a cryptographically random 24-word BIP39
// mnemonic phrase using 256-bit entropy from crypto/rand.
// --------------------------------------------------------------------------

func GenerateMnemonic() (string, error) {
	entropy, err := bip39.NewEntropy(256)
	if err != nil {
		return "", fmt.Errorf("generate entropy: %w", err)
	}

	mnemonic, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return "", fmt.Errorf("generate mnemonic: %w", err)
	}

	return mnemonic, nil
}

// --------------------------------------------------------------------------
// MnemonicToSeed converts a BIP39 mnemonic phrase into a 64-byte binary seed
// using PBKDF2-HMAC-SHA512 with 2048 iterations (no passphrase).
// The caller is responsible for zeroing the returned slice after use.
// --------------------------------------------------------------------------

func MnemonicToSeed(mnemonic string) ([]byte, error) {
	if !bip39.IsMnemonicValid(mnemonic) {
		return nil, fmt.Errorf("invalid mnemonic phrase")
	}

	// NewSeedWithErrorChecking uses PBKDF2-HMAC-SHA512 per the BIP39 spec.
	// Second argument is the optional passphrase — empty string per spec default.
	seed, err := bip39.NewSeedWithErrorChecking(mnemonic, "")
	if err != nil {
		return nil, fmt.Errorf("derive seed: %w", err)
	}

	return seed, nil
}

// --------------------------------------------------------------------------
// GenerateDEK generates a 32-byte random Data Encryption Key using
// crypto/rand. The caller must zero the returned slice after use.
// --------------------------------------------------------------------------

func GenerateDEK() ([]byte, error) {
	dek := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, fmt.Errorf("generate DEK: %w", err)
	}
	return dek, nil
}

// --------------------------------------------------------------------------
// EncryptSeed encrypts a 64-byte BIP39 seed with AES-256-GCM using the
// provided 32-byte DEK. Returns the ciphertext and a fresh 12-byte nonce.
// A new random nonce is generated for every call — never reuse nonces.
// The caller must zero seed and dek after this call returns.
// --------------------------------------------------------------------------

func EncryptSeed(seed, dek []byte) (encryptedSeed, nonce []byte, err error) {
	if len(dek) != 32 {
		return nil, nil, fmt.Errorf("DEK must be 32 bytes, got %d", len(dek))
	}

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, nil, fmt.Errorf("create AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, fmt.Errorf("create GCM: %w", err)
	}

	// Generate a fresh 12-byte nonce for this encryption.
	nonce = make([]byte, gcm.NonceSize()) // always 12 for standard GCM
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, fmt.Errorf("generate nonce: %w", err)
	}

	// Seal appends ciphertext + 16-byte auth tag to dst (nil here).
	encryptedSeed = gcm.Seal(nil, nonce, seed, nil)

	return encryptedSeed, nonce, nil
}

// --------------------------------------------------------------------------
// DecryptSeed decrypts an AES-256-GCM ciphertext back into the original
// 64-byte seed. Returns an error if the auth tag does not verify — this
// detects both corruption and tampering.
// The caller must zero the returned seed slice after use.
// --------------------------------------------------------------------------

func DecryptSeed(encryptedSeed, nonce, dek []byte) ([]byte, error) {
	if len(dek) != 32 {
		return nil, fmt.Errorf("DEK must be 32 bytes, got %d", len(dek))
	}
	if len(nonce) != 12 {
		return nil, fmt.Errorf("nonce must be 12 bytes, got %d", len(nonce))
	}

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	seed, err := gcm.Open(nil, nonce, encryptedSeed, nil)
	if err != nil {
		// This fires on any auth tag mismatch — tampered ciphertext, wrong DEK, wrong nonce.
		return nil, fmt.Errorf("decrypt seed: authentication failed: %w", err)
	}

	return seed, nil
}

// --------------------------------------------------------------------------
// DeriveAddress derives the Ethereum address and private key at BIP44 path
// m/44'/60'/0'/0/index from the given 64-byte seed.
// Returns the EIP-55 checksum address and the raw 32-byte private key bytes.
// The caller must zero privKey immediately after use — never store it.
// --------------------------------------------------------------------------

func DeriveAddress(seed []byte, index uint32) (address string, privKey []byte, err error) {
	// Build the BIP32 master key from the seed.
	masterKey, err := bip32.NewMasterKey(seed)
	if err != nil {
		return "", nil, fmt.Errorf("derive master key: %w", err)
	}

	// Derive m/44'/60'/0'/0/index step by step.
	// Hardened levels use bip32.FirstHardenedChild as the offset.
	levels := []uint32{
		bip32.FirstHardenedChild + 44, // purpose  44'
		bip32.FirstHardenedChild + 60, // coin     60' (Ethereum)
		bip32.FirstHardenedChild + 0,  // account  0'
		0,                             // change   0  (external chain)
		index,                         // address  index
	}

	key := masterKey
	for _, level := range levels {
		key, err = key.NewChildKey(level)
		if err != nil {
			return "", nil, fmt.Errorf("derive child key at level %d: %w", level, err)
		}
	}

	// go-ethereum expects a 32-byte private key scalar.
	privKeyBytes := key.Key // raw 32 bytes from go-bip32

	ecPrivKey, err := crypto.ToECDSA(privKeyBytes)
	if err != nil {
		return "", nil, fmt.Errorf("parse ECDSA private key: %w", err)
	}

	// crypto.PubkeyToAddress returns the address; .Hex() returns EIP-55 checksum format.
	ethAddress := crypto.PubkeyToAddress(ecPrivKey.PublicKey).Hex()

	// Return a copy of the private key bytes — the caller must zero this copy.
	privKeyCopy := make([]byte, len(privKeyBytes))
	copy(privKeyCopy, privKeyBytes)

	return ethAddress, privKeyCopy, nil
}

// --------------------------------------------------------------------------
// ZeroBytes overwrites every byte in b with zero.
// Call via defer in every handler that holds sensitive key material:
//
//	defer ZeroBytes(dek)
//	defer ZeroBytes(seed)
//	defer ZeroBytes(privKey)
//
// --------------------------------------------------------------------------

func ZeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
