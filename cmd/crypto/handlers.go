package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

// --------------------------------------------------------------------------
// Request / Response Structs
// --------------------------------------------------------------------------

type CreateWalletResponse struct {
	EncryptedSeed string `json:"encryptedSeed"`
	SeedNonce     string `json:"seedNonce"`
	EncryptedDek  string `json:"encryptedDek"`
	FirstAddress  string `json:"firstAddress"`
}

type DeriveWalletRequest struct {
	EncryptedSeed string `json:"encryptedSeed"`
	SeedNonce     string `json:"seedNonce"`
	EncryptedDek  string `json:"encryptedDek"`
	DerivIndex    uint32 `json:"derivIndex"`
}

type DeriveWalletResponse struct {
	Address        string `json:"address"`
	DerivationPath string `json:"derivationPath"`
}

type TxFieldsJSON struct {
	ChainId              uint32 `json:"chainId"`
	Nonce                uint64 `json:"nonce"`
	To                   string `json:"to"`
	Value                string `json:"value"` // String to prevent JS precision loss
	GasLimit             uint64 `json:"gasLimit"`
	MaxFeePerGas         string `json:"maxFeePerGas"`         // String to prevent JS precision loss
	MaxPriorityFeePerGas string `json:"maxPriorityFeePerGas"` // String to prevent JS precision loss
	Data                 string `json:"data"`                 // "0x" prefixed hex string
}

type SignTxRequest struct {
	EncryptedSeed  string       `json:"encryptedSeed"`
	SeedNonce      string       `json:"seedNonce"`
	EncryptedDek   string       `json:"encryptedDek"`
	DerivationPath string       `json:"derivationPath"`
	TxFields       TxFieldsJSON `json:"txFields"`
}

type SignTxResponse struct {
	Signature string `json:"signature"`
	TxHash    string `json:"txHash"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

// --------------------------------------------------------------------------
// HTTP Handlers
// --------------------------------------------------------------------------

// HandleCreateWallet generates a new mnemonic, encrypts the seed, encrypts
// the DEK via Vault, and derives the first address.
func HandleCreateWallet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Drain body so future callers don't need to send anything.
	var ignored json.RawMessage
	_ = json.NewDecoder(r.Body).Decode(&ignored)

	// 1. Generate mnemonic and seed
	mnemonic, err := GenerateMnemonic()
	if err != nil {
		log.Printf("[handler] GenerateMnemonic failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal crypto error")
		return
	}

	seed, err := MnemonicToSeed(mnemonic)
	if err != nil {
		log.Printf("[handler] MnemonicToSeed failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal crypto error")
		return
	}
	defer ZeroBytes(seed) // mnemonic string is not zeroable, but goes out of scope here

	// 2. Generate DEK and encrypt seed
	dek, err := GenerateDEK()
	if err != nil {
		log.Printf("[handler] GenerateDEK failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal crypto error")
		return
	}
	defer ZeroBytes(dek)

	encSeedBytes, nonceBytes, err := EncryptSeed(seed, dek)
	if err != nil {
		log.Printf("[handler] EncryptSeed failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal crypto error")
		return
	}

	// 3. Encrypt DEK via Vault
	encDekStr, err := EncryptDEK(dek)
	if err != nil {
		log.Printf("[handler] EncryptDEK (Vault) failed: %v", err)
		writeError(w, http.StatusInternalServerError, "vault encryption error")
		return
	}

	// 4. Derive first address (index 0)
	firstAddress, privKey, err := DeriveAddress(seed, 0)
	if err != nil {
		log.Printf("[handler] DeriveAddress failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal derivation error")
		return
	}
	defer ZeroBytes(privKey)

	// 5. Respond
	resp := CreateWalletResponse{
		EncryptedSeed: base64.StdEncoding.EncodeToString(encSeedBytes),
		SeedNonce:     base64.StdEncoding.EncodeToString(nonceBytes),
		EncryptedDek:  encDekStr,
		FirstAddress:  firstAddress,
	}
	writeJSON(w, http.StatusCreated, resp)
}

// HandleDeriveWallet decrypts the org seed and derives a child address.
func HandleDeriveWallet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req DeriveWalletRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	seed, dek, err := decryptOrgSeed(req.EncryptedSeed, req.SeedNonce, req.EncryptedDek)
	if err != nil {
		log.Printf("[handler] decryptOrgSeed failed: %v", err)
		writeError(w, http.StatusInternalServerError, "decryption error")
		return
	}
	defer ZeroBytes(seed)
	defer ZeroBytes(dek)

	path := fmt.Sprintf("m/44'/60'/0'/0/%d", req.DerivIndex)
	address, privKey, err := DeriveAddress(seed, req.DerivIndex)
	if err != nil {
		log.Printf("[handler] DeriveAddress failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal derivation error")
		return
	}
	defer ZeroBytes(privKey)

	resp := DeriveWalletResponse{
		Address:        address,
		DerivationPath: path,
	}
	writeJSON(w, http.StatusOK, resp)
}

// HandleSignTx decrypts the org seed, derives the key, hashes the tx, and signs it.
func HandleSignTx(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req SignTxRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	index, err := parseDerivIndex(req.DerivationPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	txFields, err := parseTxFields(req.TxFields)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// 1. Decrypt seed
	seed, dek, err := decryptOrgSeed(req.EncryptedSeed, req.SeedNonce, req.EncryptedDek)
	if err != nil {
		log.Printf("[handler] decryptOrgSeed failed: %v", err)
		writeError(w, http.StatusInternalServerError, "decryption error")
		return
	}
	defer ZeroBytes(seed)
	defer ZeroBytes(dek)

	// 2. Derive private key
	_, privKey, err := DeriveAddress(seed, index)
	if err != nil {
		log.Printf("[handler] DeriveAddress failed: %v", err)
		writeError(w, http.StatusInternalServerError, "internal derivation error")
		return
	}
	defer ZeroBytes(privKey)

	// 3. Build hash and sign
	txHash, err := BuildTxHash(txFields)
	if err != nil {
		log.Printf("[handler] BuildTxHash failed: %v", err)
		writeError(w, http.StatusInternalServerError, "tx hashing error")
		return
	}

	signature, err := SignTxHash(txHash, privKey)
	if err != nil {
		log.Printf("[handler] SignTxHash failed: %v", err)
		writeError(w, http.StatusInternalServerError, "signing error")
		return
	}

	resp := SignTxResponse{
		Signature: signature,
		TxHash:    "0x" + hex.EncodeToString(txHash),
	}
	writeJSON(w, http.StatusOK, resp)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// decryptOrgSeed handles the repetitive logic of fetching the DEK from Vault
// and decrypting the seed. Caller MUST defer ZeroBytes on returned slices.
func decryptOrgSeed(encSeedB64, nonceB64, encDek string) (seed, dek []byte, err error) {
	dek, err = DecryptDEK(encDek)
	if err != nil {
		return nil, nil, fmt.Errorf("vault DEK decrypt: %w", err)
	}

	encSeedBytes, err := base64.StdEncoding.DecodeString(encSeedB64)
	if err != nil {
		ZeroBytes(dek)
		return nil, nil, fmt.Errorf("base64 decode encrypted seed: %w", err)
	}

	nonceBytes, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		ZeroBytes(dek)
		return nil, nil, fmt.Errorf("base64 decode nonce: %w", err)
	}

	seed, err = DecryptSeed(encSeedBytes, nonceBytes, dek)
	if err != nil {
		ZeroBytes(dek)
		return nil, nil, fmt.Errorf("AES-GCM decrypt seed: %w", err)
	}

	return seed, dek, nil
}

// parseDerivIndex extracts the last integer from "m/44'/60'/0'/0/5".
func parseDerivIndex(path string) (uint32, error) {
	parts := strings.Split(path, "/")
	if len(parts) != 6 {
		return 0, fmt.Errorf("invalid derivation path format: %s", path)
	}
	indexStr := parts[5]
	index, err := strconv.ParseUint(indexStr, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid derivation index: %s", indexStr)
	}
	return uint32(index), nil
}

// parseTxFields safely maps the JSON request fields (strings for large ints)
// into the exact types required by our crypto primitives.
func parseTxFields(jsonTx TxFieldsJSON) (TxFields, error) {
	value, ok := new(big.Int).SetString(jsonTx.Value, 10)
	if !ok {
		return TxFields{}, fmt.Errorf("invalid tx value: %s", jsonTx.Value)
	}

	maxFee, ok := new(big.Int).SetString(jsonTx.MaxFeePerGas, 10)
	if !ok {
		return TxFields{}, fmt.Errorf("invalid maxFeePerGas: %s", jsonTx.MaxFeePerGas)
	}

	maxPriority, ok := new(big.Int).SetString(jsonTx.MaxPriorityFeePerGas, 10)
	if !ok {
		return TxFields{}, fmt.Errorf("invalid maxPriorityFeePerGas: %s", jsonTx.MaxPriorityFeePerGas)
	}

	var data []byte
	var err error
	if jsonTx.Data != "" && jsonTx.Data != "0x" {
		data, err = hex.DecodeString(strings.TrimPrefix(jsonTx.Data, "0x"))
		if err != nil {
			return TxFields{}, fmt.Errorf("invalid tx data hex: %w", err)
		}
	}

	return TxFields{
		ChainId:              big.NewInt(int64(jsonTx.ChainId)),
		Nonce:                jsonTx.Nonce,
		MaxFeePerGas:         maxFee,
		MaxPriorityFeePerGas: maxPriority,
		GasLimit:             jsonTx.GasLimit,
		To:                   jsonTx.To,
		Value:                value,
		Data:                 data,
	}, nil
}

// writeJSON is a helper to write JSON responses.
func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// writeError is a helper to write standardized JSON errors.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: msg})
}
