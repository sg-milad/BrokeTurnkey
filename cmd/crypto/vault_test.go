package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"testing"

	"github.com/joho/godotenv"
)

// loadEnv loads .env.crypto from the repo root (../../ relative to cmd/crypto/).
// It is called at the top of every test that needs Vault — safe to call multiple times.
func loadEnv(t *testing.T) {
	t.Helper()
	// godotenv.Load does not overwrite vars already set in the environment,
	// so CI can inject them directly without a file being present.
	_ = godotenv.Load("../../.env.crypto")
	t.Logf("VAULT_ADDR     = %s", os.Getenv("VAULT_ADDR"))
	t.Logf("VAULT_ROLE_ID  = %s", os.Getenv("VAULT_ROLE_ID"))
	t.Logf("VAULT_SECRET_ID = %s...", os.Getenv("VAULT_SECRET_ID")[:8]) // first 8 chars only
	required := []string{"VAULT_ADDR", "VAULT_ROLE_ID", "VAULT_SECRET_ID"}
	for _, key := range required {
		if os.Getenv(key) == "" {
			fmt.Println("ens", os.Getenv(key))
			t.Skipf("skipping vault integration test: %s not set", key)
		}
	}

	// Set the package-level vaultAddr used by all vault.go functions.
	vaultAddr = os.Getenv("VAULT_ADDR")
}

// loginOnce is a test helper that performs AppRoleLogin and fails the test
// immediately if login does not succeed. Used by every test that needs a token.
func loginOnce(t *testing.T) {
	t.Helper()
	roleID := os.Getenv("VAULT_ROLE_ID")
	secretID := os.Getenv("VAULT_SECRET_ID")

	if err := AppRoleLogin(roleID, secretID); err != nil {
		t.Fatalf("AppRoleLogin failed: %v", err)
	}
}

// --------------------------------------------------------------------------
// TestAppRoleLogin — verifies that login succeeds and populates vaultState
// --------------------------------------------------------------------------

func TestAppRoleLogin(t *testing.T) {
	loadEnv(t)

	roleID := os.Getenv("VAULT_ROLE_ID")
	secretID := os.Getenv("VAULT_SECRET_ID")

	if err := AppRoleLogin(roleID, secretID); err != nil {
		t.Fatalf("expected login to succeed, got: %v", err)
	}

	vaultState.mu.Lock()
	token := vaultState.token
	leaseDur := vaultState.leaseDurSec
	vaultState.mu.Unlock()

	if token == "" {
		t.Error("expected vaultState.token to be populated after login, got empty string")
	}
	if leaseDur <= 0 {
		t.Errorf("expected leaseDurSec > 0 after login, got %d", leaseDur)
	}

	t.Logf("login OK — token prefix: %s..., lease_duration: %ds", token[:8], leaseDur)
}

// --------------------------------------------------------------------------
// TestAppRoleLogin_BadCredentials — verifies that wrong credentials are
// rejected and the function returns an error (not a panic or silent success)
// --------------------------------------------------------------------------

func TestAppRoleLogin_BadCredentials(t *testing.T) {
	loadEnv(t)

	err := AppRoleLogin("bad-role-id", "bad-secret-id")
	if err == nil {
		t.Fatal("expected login to fail with bad credentials, but it succeeded")
	}
	t.Logf("correctly rejected bad credentials: %v", err)
}

// --------------------------------------------------------------------------
// TestRenewToken — verifies that an already-valid token can be renewed
// --------------------------------------------------------------------------

func TestRenewToken(t *testing.T) {
	loadEnv(t)
	loginOnce(t)

	vaultState.mu.Lock()
	tokenBefore := vaultState.token
	vaultState.mu.Unlock()

	if err := RenewToken(); err != nil {
		t.Fatalf("RenewToken failed: %v", err)
	}

	vaultState.mu.Lock()
	tokenAfter := vaultState.token
	leaseDur := vaultState.leaseDurSec
	vaultState.mu.Unlock()

	// Vault may return the same token or a new one depending on configuration —
	// either is valid. We just verify the call succeeded and state is intact.
	if tokenAfter == "" {
		t.Error("expected token to remain populated after renewal, got empty string")
	}
	if leaseDur <= 0 {
		t.Errorf("expected leaseDurSec > 0 after renewal, got %d", leaseDur)
	}

	t.Logf("renewal OK — token before: %s..., token after: %s..., lease_duration: %ds",
		tokenBefore[:8], tokenAfter[:8], leaseDur)
}

// --------------------------------------------------------------------------
// TestEncryptDEK — verifies that a 32-byte DEK produces a vault:v1: ciphertext
// --------------------------------------------------------------------------

func TestEncryptDEK(t *testing.T) {
	loadEnv(t)
	loginOnce(t)

	dek := make([]byte, 32)
	if _, err := rand.Read(dek); err != nil {
		t.Fatalf("failed to generate random DEK: %v", err)
	}
	defer func() {
		for i := range dek {
			dek[i] = 0
		}
	}()

	ciphertext, err := EncryptDEK(dek)
	if err != nil {
		t.Fatalf("EncryptDEK failed: %v", err)
	}

	if len(ciphertext) < 10 {
		t.Errorf("ciphertext looks too short: %q", ciphertext)
	}
	if ciphertext[:9] != "vault:v1:" {
		t.Errorf("expected ciphertext to start with 'vault:v1:', got: %q", ciphertext[:9])
	}

	t.Logf("EncryptDEK OK — ciphertext prefix: %s", ciphertext[:16])
}

// --------------------------------------------------------------------------
// TestDecryptDEK — verifies that a DEK survives a full encrypt → decrypt round-trip
// --------------------------------------------------------------------------

func TestDecryptDEK(t *testing.T) {
	loadEnv(t)
	loginOnce(t)

	// Generate a fresh random DEK.
	original := make([]byte, 32)
	if _, err := rand.Read(original); err != nil {
		t.Fatalf("failed to generate random DEK: %v", err)
	}

	// Encrypt.
	ciphertext, err := EncryptDEK(original)
	if err != nil {
		t.Fatalf("EncryptDEK failed: %v", err)
	}

	// Decrypt.
	recovered, err := DecryptDEK(ciphertext)
	if err != nil {
		t.Fatalf("DecryptDEK failed: %v", err)
	}
	defer func() {
		for i := range recovered {
			recovered[i] = 0
		}
		for i := range original {
			original[i] = 0
		}
	}()

	// Compare byte-by-byte.
	if len(recovered) != len(original) {
		t.Fatalf("length mismatch: got %d bytes, want %d", len(recovered), len(original))
	}
	for i := range original {
		if recovered[i] != original[i] {
			t.Errorf("byte mismatch at index %d: got 0x%02x, want 0x%02x", i, recovered[i], original[i])
		}
	}

	t.Logf("round-trip OK — DEK[0:4]: %x", original[:4])
}

// --------------------------------------------------------------------------
// TestDecryptDEK_BadCiphertext — verifies that a tampered ciphertext is rejected
// --------------------------------------------------------------------------

func TestDecryptDEK_BadCiphertext(t *testing.T) {
	loadEnv(t)
	loginOnce(t)

	_, err := DecryptDEK("vault:v1:thisisnotvalidciphertext")
	if err == nil {
		t.Fatal("expected DecryptDEK to fail with invalid ciphertext, but it succeeded")
	}
	t.Logf("correctly rejected bad ciphertext: %v", err)
}

// --------------------------------------------------------------------------
// TestEncryptDecryptDEK_MultipleRoundTrips — encrypts 5 different DEKs and
// decrypts each one, verifying that distinct DEKs produce distinct ciphertexts
// and all recover correctly
// --------------------------------------------------------------------------

func TestEncryptDecryptDEK_MultipleRoundTrips(t *testing.T) {
	loadEnv(t)
	loginOnce(t)

	const n = 5
	deks := make([][]byte, n)
	ciphertexts := make([]string, n)

	// Encrypt all DEKs.
	for i := range deks {
		dek := make([]byte, 32)
		if _, err := rand.Read(dek); err != nil {
			t.Fatalf("rand.Read failed: %v", err)
		}
		deks[i] = dek

		ct, err := EncryptDEK(dek)
		if err != nil {
			t.Fatalf("EncryptDEK[%d] failed: %v", i, err)
		}
		ciphertexts[i] = ct
	}

	// Verify ciphertexts are all distinct.
	seen := map[string]bool{}
	for i, ct := range ciphertexts {
		if seen[ct] {
			t.Errorf("ciphertext[%d] is a duplicate — Transit nonce reuse?", i)
		}
		seen[ct] = true
	}

	// Decrypt and verify each one.
	for i, ct := range ciphertexts {
		recovered, err := DecryptDEK(ct)
		if err != nil {
			t.Fatalf("DecryptDEK[%d] failed: %v", i, err)
		}
		for j, b := range deks[i] {
			if recovered[j] != b {
				t.Errorf("DEK[%d] byte mismatch at index %d", i, j)
			}
		}
		// Zero recovered immediately.
		for j := range recovered {
			recovered[j] = 0
		}
	}

	// Zero all original DEKs.
	for _, dek := range deks {
		for i := range dek {
			dek[i] = 0
		}
	}

	t.Logf("all %d round-trips OK, all ciphertexts distinct", n)
}
