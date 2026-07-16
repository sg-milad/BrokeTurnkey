package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/joho/godotenv"
)

type cryptoConfig struct {
	VaultAddr  string
	RoleID     string
	SecretID   string
	CryptoPort string
}

func loadConfig() *cryptoConfig {
	if err := godotenv.Load(".env.crypto"); err != nil {
		log.Fatalf("Error loading .env.crypto file: %v", err)
	}

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
		log.Fatalf("Missing required environment variables in .env.crypto")
	}

	return cfg
}

func main() {
	cfg := loadConfig()

	log.Printf("Starting Crypto Service...")
	log.Printf("VAULT_ADDR: %s", cfg.VaultAddr)
	log.Printf("VAULT_ROLE_ID: %s", cfg.RoleID)
	log.Printf("VAULT_SECRET_ID: [REDACTED]")
	log.Printf("CRYPTO_PORT: %s", cfg.CryptoPort)

	if err := AppRoleLogin(cfg.RoleID, cfg.SecretID); err != nil {
		log.Fatalf("[vault] startup failed: %v", err)
	}

	StartTokenRenewalLoop()

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "OK")
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintln(w, `{"error":"handler not yet implemented"}`)
	})

	addr := fmt.Sprintf("0.0.0.0:%s", cfg.CryptoPort)
	log.Printf("Listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %s", err)
	}
}
