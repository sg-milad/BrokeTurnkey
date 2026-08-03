package main

import (
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

type cryptoConfig struct {
	VaultAddr   string
	RoleID      string
	SecretID    string
	CryptoPort  string
	AuthToken   string
}

func loadConfig() *cryptoConfig {
	cfg := &cryptoConfig{
		VaultAddr:  os.Getenv("VAULT_ADDR"),
		RoleID:     os.Getenv("VAULT_ROLE_ID"),
		SecretID:   os.Getenv("VAULT_SECRET_ID"),
		CryptoPort: os.Getenv("CRYPTO_PORT"),
		AuthToken:  os.Getenv("CRYPTO_AUTH_TOKEN"),
	}

	if cfg.CryptoPort == "" {
		cfg.CryptoPort = "4000"
	}

	if cfg.VaultAddr == "" || cfg.RoleID == "" || cfg.SecretID == "" {
		log.Fatalf("Missing required environment variables (VAULT_ADDR, VAULT_ROLE_ID, VAULT_SECRET_ID)")
	}
	if cfg.AuthToken == "" {
		log.Fatalf("Missing required environment variable CRYPTO_AUTH_TOKEN — the API authenticates to this service with it")
	}

	return cfg
}

func main() {
	cfg := loadConfig()

	log.Printf("Starting Crypto Service...")
	log.Printf("VAULT_ADDR: %s", cfg.VaultAddr)
	// Never log the SecretID or auth token themselves — only their presence.
	log.Printf("VAULT_ROLE_ID: %s", cfg.RoleID)
	log.Printf("VAULT_SECRET_ID: <set>")
	log.Printf("CRYPTO_AUTH_TOKEN: <set>")
	log.Printf("CRYPTO_PORT: %s", cfg.CryptoPort)

	// Set the package-level vaultAddr used by vault.go functions
	vaultAddr = cfg.VaultAddr
	authToken = cfg.AuthToken

	if err := AppRoleLogin(cfg.RoleID, cfg.SecretID); err != nil {
		log.Fatalf("[vault] startup failed: %v", err)
	}

	StartTokenRenewalLoop()

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "OK")
	})

	// Cryptographic boundary endpoints. Every endpoint except /health
	// requires the shared CRYPTO_AUTH_TOKEN — the API service is the only
	// caller, and the internal Docker network is not the security boundary.
	mux.Handle("/wallet/create", requireAuth(http.HandlerFunc(HandleCreateWallet)))
	mux.Handle("/wallet/derive", requireAuth(http.HandlerFunc(HandleDeriveWallet)))
	mux.Handle("/wallet/sign-transaction", requireAuth(http.HandlerFunc(HandleSignTx)))
	mux.Handle("/wallet/sign", requireAuth(http.HandlerFunc(HandleSignTx))) // backward-compatible alias
	mux.Handle("/wallet/sign-hash", requireAuth(http.HandlerFunc(HandleSignHash)))

	// Fallback for undefined routes
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, `{"error":"route not found"}`)
	})

	addr := fmt.Sprintf("0.0.0.0:%s", cfg.CryptoPort)
	log.Printf("Listening on %s", addr)

	// Explicit server timeouts — without them a slow client can hold a
	// connection (and its goroutine) open indefinitely.
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1 MiB
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server failed: %s", err)
	}
}

// authToken is the shared secret the API service must present on every
// request (header X-Crypto-Token). Set once in main().
var authToken string

func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := r.Header.Get("X-Crypto-Token")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(authToken)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}
