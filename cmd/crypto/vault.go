package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// vaultState holds the in-memory Vault token and its TTL.
// All fields are protected by mu — never read or write them without holding the lock.
var vaultState = struct {
	mu          sync.Mutex
	token       string
	leaseDurSec int // original lease_duration from the last login or renewal
}{
	leaseDurSec: 3600, // safe default; overwritten on first login
}

// vaultAddr is set once from env in main() before any Vault call is made.
var vaultAddr string

// httpClient is used for every Vault call. A hung Vault must not hang a
// signing request forever — the server-level WriteTimeout is a backstop,
// but each outbound call gets its own bound so errors surface fast.
var httpClient = &http.Client{Timeout: 10 * time.Second}

// --------------------------------------------------------------------------
// AppRoleLogin authenticates to Vault using the wallet-signer AppRole.
// It retries up to maxAttempts times before returning a fatal error.
// On success the token is stored in vaultState.
// --------------------------------------------------------------------------

const loginMaxAttempts = 3
const loginRetryDelay = 5 * time.Second

func AppRoleLogin(roleID, secretID string) error {
	payload := map[string]string{
		"role_id":   roleID,
		"secret_id": secretID,
	}

	var lastErr error
	for attempt := 1; attempt <= loginMaxAttempts; attempt++ {
		token, leaseDur, err := doLogin(payload)
		if err == nil {
			vaultState.mu.Lock()
			vaultState.token = token
			vaultState.leaseDurSec = leaseDur
			vaultState.mu.Unlock()
			log.Printf("[vault] AppRole login successful (lease_duration=%ds)", leaseDur)
			return nil
		}

		lastErr = err
		log.Printf("[vault] AppRole login attempt %d/%d failed: %v", attempt, loginMaxAttempts, err)
		if attempt < loginMaxAttempts {
			time.Sleep(loginRetryDelay)
		}
	}

	return fmt.Errorf("AppRoleLogin failed after %d attempts: %w", loginMaxAttempts, lastErr)
}

func doLogin(payload map[string]string) (token string, leaseDurSec int, err error) {
	body, _ := json.Marshal(payload)
	resp, err := httpClient.Post(
		vaultAddr+"/v1/auth/approle/login",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", 0, fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("vault returned %d: %s", resp.StatusCode, raw)
	}

	var result struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int    `json:"lease_duration"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", 0, fmt.Errorf("decode response: %w", err)
	}
	if result.Auth.ClientToken == "" {
		return "", 0, fmt.Errorf("empty client_token in response")
	}

	return result.Auth.ClientToken, result.Auth.LeaseDuration, nil
}

// --------------------------------------------------------------------------
// RenewToken calls /v1/auth/token/renew-self with the current in-memory token.
// On success it updates vaultState.leaseDurSec so the renewal loop can
// recalculate the next fire time correctly.
// --------------------------------------------------------------------------

func RenewToken() error {
	vaultState.mu.Lock()
	token := vaultState.token
	vaultState.mu.Unlock()

	req, err := http.NewRequest(http.MethodPost, vaultAddr+"/v1/auth/token/renew-self", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Vault-Token", token)

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("vault returned %d: %s", resp.StatusCode, raw)
	}

	var result struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int    `json:"lease_duration"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	vaultState.mu.Lock()
	if result.Auth.ClientToken != "" {
		vaultState.token = result.Auth.ClientToken
	}
	if result.Auth.LeaseDuration > 0 {
		vaultState.leaseDurSec = result.Auth.LeaseDuration
	}
	vaultState.mu.Unlock()

	return nil
}

// --------------------------------------------------------------------------
// StartTokenRenewalLoop starts a background goroutine that renews the Vault
// token at 75% of its TTL. If renewal fails it logs the error and retries
// on the same schedule — it never crashes the process.
// --------------------------------------------------------------------------

func StartTokenRenewalLoop() {
	go func() {
		for {
			vaultState.mu.Lock()
			leaseDur := vaultState.leaseDurSec
			vaultState.mu.Unlock()

			// Fire at 75% of the current lease duration.
			fireIn := time.Duration(float64(leaseDur)*0.75) * time.Second
			log.Printf("[vault] token renewal scheduled in %s", fireIn.Round(time.Second))
			time.Sleep(fireIn)

			if err := RenewToken(); err != nil {
				log.Printf("[vault] token renewal failed (will retry at next interval): %v", err)
			} else {
				log.Printf("[vault] token renewed successfully")
			}
		}
	}()
}

// --------------------------------------------------------------------------
// EncryptDEK sends a raw 32-byte DEK to Vault's Transit engine and returns
// the "vault:v1:..." ciphertext string. The caller must zero dek after use.
// --------------------------------------------------------------------------

func EncryptDEK(dek []byte) (string, error) {
	vaultState.mu.Lock()
	token := vaultState.token
	vaultState.mu.Unlock()

	payload := map[string]string{
		// Transit requires the plaintext to be base64-encoded.
		"plaintext": base64.StdEncoding.EncodeToString(dek),
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(
		http.MethodPost,
		vaultAddr+"/v1/transit/encrypt/wallet-dek",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("vault returned %d: %s", resp.StatusCode, raw)
	}

	var result struct {
		Data struct {
			Ciphertext string `json:"ciphertext"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if result.Data.Ciphertext == "" {
		return "", fmt.Errorf("empty ciphertext in response")
	}

	return result.Data.Ciphertext, nil
}

// --------------------------------------------------------------------------
// DecryptDEK sends a "vault:v1:..." ciphertext to Vault's Transit engine and
// returns the raw 32-byte DEK. The caller must zero the returned slice after use.
// --------------------------------------------------------------------------

func DecryptDEK(ciphertext string) ([]byte, error) {
	vaultState.mu.Lock()
	token := vaultState.token
	vaultState.mu.Unlock()

	payload := map[string]string{
		"ciphertext": ciphertext,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(
		http.MethodPost,
		vaultAddr+"/v1/transit/decrypt/wallet-dek",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vault returned %d: %s", resp.StatusCode, raw)
	}

	var result struct {
		Data struct {
			Plaintext string `json:"plaintext"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if result.Data.Plaintext == "" {
		return nil, fmt.Errorf("empty plaintext in response")
	}

	// Vault returns the DEK as base64 — decode to raw bytes.
	dek, err := base64.StdEncoding.DecodeString(result.Data.Plaintext)
	if err != nil {
		return nil, fmt.Errorf("base64 decode plaintext: %w", err)
	}

	return dek, nil
}
