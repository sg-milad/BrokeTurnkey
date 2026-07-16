package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --------------------------------------------------------------------------
// Helper function tests (parseDerivIndex, parseTxFields)
// --------------------------------------------------------------------------

func TestParseDerivIndex_Valid(t *testing.T) {
	tests := []struct {
		path string
		want uint32
	}{
		{"m/44'/60'/0'/0/0", 0},
		{"m/44'/60'/0'/0/5", 5},
		{"m/44'/60'/0'/0/999", 999},
	}
	for _, tt := range tests {
		got, err := parseDerivIndex(tt.path)
		if err != nil {
			t.Errorf("parseDerivIndex(%q) unexpected error: %v", tt.path, err)
			continue
		}
		if got != tt.want {
			t.Errorf("parseDerivIndex(%q) = %d, want %d", tt.path, got, tt.want)
		}
	}
}

func TestParseDerivIndex_Invalid(t *testing.T) {
	tests := []struct {
		name string
		path string
	}{
		{"too short", "m/44'/60'/0'"},
		{"too long", "m/44'/60'/0'/0/5/extra"},
		{"bad index", "m/44'/60'/0'/0/abc"},
		{"empty", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseDerivIndex(tt.path)
			if err == nil {
				t.Errorf("parseDerivIndex(%q) expected error, got nil", tt.path)
			}
		})
	}
}

func TestParseTxFields_Valid(t *testing.T) {
	jsonTx := TxFieldsJSON{
		ChainId:              1,
		Nonce:                42,
		To:                   "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
		Value:                "1000000000000000000", // 1 ETH in wei
		GasLimit:             21000,
		MaxFeePerGas:         "30000000000",
		MaxPriorityFeePerGas: "1000000000",
		Data:                 "0x",
	}

	txFields, err := parseTxFields(jsonTx)
	if err != nil {
		t.Fatalf("parseTxFields unexpected error: %v", err)
	}

	if txFields.ChainId.Uint64() != 1 {
		t.Error("chainId mismatch")
	}
	if txFields.Nonce != 42 {
		t.Error("nonce mismatch")
	}
	if txFields.To != "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" {
		t.Error("to mismatch")
	}
	// Critical check: ensure big ints are parsed exactly without JS float truncation
	if txFields.Value.String() != "1000000000000000000" {
		t.Errorf("value mismatch, got %s", txFields.Value.String())
	}
	if txFields.GasLimit != 21000 {
		t.Error("gasLimit mismatch")
	}
	if txFields.MaxFeePerGas.String() != "30000000000" {
		t.Error("maxFeePerGas mismatch")
	}
	if txFields.MaxPriorityFeePerGas.String() != "1000000000" {
		t.Error("maxPriorityFeePerGas mismatch")
	}
	if len(txFields.Data) != 0 {
		t.Error("data should be empty for '0x'")
	}
}

func TestParseTxFields_WithData(t *testing.T) {
	jsonTx := TxFieldsJSON{
		ChainId: 1, Nonce: 0, To: "", Value: "0",
		GasLimit: 100000, MaxFeePerGas: "100", MaxPriorityFeePerGas: "10",
		Data: "0xdeadbeef",
	}
	txFields, err := parseTxFields(jsonTx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// hex "deadbeef" is exactly 4 bytes
	if len(txFields.Data) != 4 {
		t.Errorf("expected 4 bytes of data, got %d", len(txFields.Data))
	}
}

func TestParseTxFields_InvalidInputs(t *testing.T) {
	tests := []struct {
		name   string
		jsonTx TxFieldsJSON
	}{
		{"bad value", TxFieldsJSON{Value: "not-a-number"}},
		{"bad maxFee", TxFieldsJSON{MaxFeePerGas: "abc"}},
		{"bad maxPriority", TxFieldsJSON{MaxPriorityFeePerGas: "1.5"}},
		{"bad data hex", TxFieldsJSON{Data: "0xZZZ"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseTxFields(tt.jsonTx)
			if err == nil {
				t.Error("expected error for invalid input, got nil")
			}
		})
	}
}

// --------------------------------------------------------------------------
// HTTP Handler Tests (Validation, Methods, JSON parsing)
// --------------------------------------------------------------------------

func TestHandleCreateWallet_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/wallet/create", nil)
	w := httptest.NewRecorder()
	HandleCreateWallet(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", resp.StatusCode)
	}
	var errResp ErrorResponse
	json.NewDecoder(resp.Body).Decode(&errResp)
	if errResp.Error != "method not allowed" {
		t.Errorf("unexpected error message: %s", errResp.Error)
	}
}

func TestHandleCreateWallet_MissingOrgId(t *testing.T) {
	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest(http.MethodPost, "/wallet/create", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleCreateWallet(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
	var errResp ErrorResponse
	json.NewDecoder(resp.Body).Decode(&errResp)
	if !strings.Contains(errResp.Error, "orgId") {
		t.Errorf("expected error about missing orgId, got: %s", errResp.Error)
	}
}

func TestHandleCreateWallet_InvalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/wallet/create", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	HandleCreateWallet(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestHandleDeriveWallet_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "/wallet/derive", nil)
	w := httptest.NewRecorder()
	HandleDeriveWallet(w, req)

	if w.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Result().StatusCode)
	}
}

func TestHandleDeriveWallet_InvalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/wallet/derive", strings.NewReader("{invalid}"))
	w := httptest.NewRecorder()
	HandleDeriveWallet(w, req)

	if w.Result().StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Result().StatusCode)
	}
}

func TestHandleSignTx_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/wallet/sign", nil)
	w := httptest.NewRecorder()
	HandleSignTx(w, req)

	if w.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Result().StatusCode)
	}
}

func TestHandleSignTx_InvalidDerivationPath(t *testing.T) {
	// This should fail validation BEFORE it ever tries to talk to Vault
	body, _ := json.Marshal(SignTxRequest{
		EncryptedSeed:  "fake",
		SeedNonce:      "fake",
		EncryptedDek:   "fake",
		DerivationPath: "m/44'/60'/0'", // Missing index
		TxFields: TxFieldsJSON{
			ChainId: 1, Nonce: 0, To: "0x0000000000000000000000000000000000000001", Value: "0",
			GasLimit: 21000, MaxFeePerGas: "0", MaxPriorityFeePerGas: "0", Data: "0x",
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/wallet/sign", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleSignTx(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for bad path, got %d", resp.StatusCode)
	}
	var errResp ErrorResponse
	json.NewDecoder(resp.Body).Decode(&errResp)
	if !strings.Contains(errResp.Error, "invalid derivation path") {
		t.Errorf("unexpected error message: %s", errResp.Error)
	}
}

func TestHandleSignTx_InvalidTxFields(t *testing.T) {
	body, _ := json.Marshal(SignTxRequest{
		EncryptedSeed:  "fake",
		SeedNonce:      "fake",
		EncryptedDek:   "fake",
		DerivationPath: "m/44'/60'/0'/0/0",
		TxFields: TxFieldsJSON{
			ChainId: 1, Nonce: 0, To: "0x0000000000000000000000000000000000000001", Value: "one_eth", // Invalid value string
			GasLimit: 21000, MaxFeePerGas: "0", MaxPriorityFeePerGas: "0", Data: "0x",
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/wallet/sign", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleSignTx(w, req)

	resp := w.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for bad tx fields, got %d", resp.StatusCode)
	}
}
