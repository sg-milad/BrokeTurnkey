package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	// Read environment variables
	vaultAddr := os.Getenv("VAULT_ADDR")
	vaultRoleID := os.Getenv("VAULT_ROLE_ID")
	vaultSecretID := os.Getenv("VAULT_SECRET_ID")
	_ = vaultSecretID
	
	cryptoPort := os.Getenv("CRYPTO_PORT")

	if cryptoPort == "" {
		cryptoPort = "4000"
	}

	log.Printf("Starting Crypto Service...")
	log.Printf("VAULT_ADDR: %s", vaultAddr)
	log.Printf("VAULT_ROLE_ID: %s", vaultRoleID)
	log.Printf("VAULT_SECRET_ID: [REDACTED]")
	log.Printf("CRYPTO_PORT: %s", cryptoPort)

	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "OK")
	})

	// Catch-all handler that returns 500 for now
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintln(w, `{"error":"handler not yet implemented"}`)
	})

	addr := fmt.Sprintf("0.0.0.0:%s", cryptoPort)
	log.Printf("Listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %s", err)
	}
}