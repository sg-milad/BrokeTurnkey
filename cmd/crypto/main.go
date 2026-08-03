package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

type cryptoConfig struct {
	VaultAddr  string
	RoleID     string
	SecretID   string
	CryptoPort string
}

func loadConfig() *cryptoConfig {
	cfg := &cryptoConfig{
		VaultAddr:  os.Getenv("VAULT_ADDR"),
		RoleID:     os.Getenv("VAULT_ROLE_ID"),
		SecretID:   os.Getenv("VAULT_SECRET_ID"),
		CryptoPort: os.Getenv("CRYPTO_PORT"),
	}

	if cfg.CryptoPort == "" {
		cfg.CryptoPort = "4000"
	}

	if cfg.VaultAddr == "" || cfg.RoleID == "" || cfg.SecretID == "" {
		log.Fatalf("Missing required environment variables (VAULT_ADDR, VAULT_ROLE_ID, VAULT_SECRET_ID)")
	}

	return cfg
}

func main() {
	cfg := loadConfig()

	log.Printf("Starting Crypto Service...")
	log.Printf("VAULT_ADDR: %s", cfg.VaultAddr)
	log.Printf("VAULT_ROLE_ID: %s", cfg.RoleID)
	log.Printf("VAULT_SECRET_ID: %s", cfg.SecretID)
	log.Printf("CRYPTO_PORT: %s", cfg.CryptoPort)

	// Set the package-level vaultAddr used by vault.go functions
	vaultAddr = cfg.VaultAddr

	if err := AppRoleLogin(cfg.RoleID, cfg.SecretID); err != nil {
		log.Fatalf("[vault] startup failed: %v", err)
	}

	StartTokenRenewalLoop()

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "OK")
	})

	// Cryptographic boundary endpoints
	mux.HandleFunc("/wallet/create", HandleCreateWallet)
	mux.HandleFunc("/wallet/derive", HandleDeriveWallet)
	mux.HandleFunc("/wallet/sign-transaction", HandleSignTx)
	mux.HandleFunc("/wallet/sign", HandleSignTx) // backward-compatible alias
	mux.HandleFunc("/wallet/sign-hash", HandleSignHash)

	// Fallback for undefined routes
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, `{"error":"route not found"}`)
	})

	addr := fmt.Sprintf("0.0.0.0:%s", cfg.CryptoPort)
	log.Printf("Listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %s", err)
	}
}
