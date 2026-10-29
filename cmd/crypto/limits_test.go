package main

import (
	"bytes"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func withSignerLimits(t *testing.T, limits *SignerLimits) {
	t.Helper()
	prev := signerLimits
	signerLimits = limits
	t.Cleanup(func() { signerLimits = prev })
}

func validTx() TxFields {
	return TxFields{
		ChainId:              big.NewInt(84532),
		Nonce:                0,
		MaxFeePerGas:         big.NewInt(1),
		MaxPriorityFeePerGas: big.NewInt(0),
		GasLimit:             21000,
		To:                   "0x1111111111111111111111111111111111111111",
		Value:                big.NewInt(0),
		Data:                 nil,
	}
}

func TestValidateSignTxLimits_DefaultsDenyValueAndCalldata(t *testing.T) {
	withSignerLimits(t, defaultSignerLimits())

	tx := validTx()
	if err := validateSignTxLimits(tx); err != nil {
		t.Fatalf("zero-value transfer should be allowed: %v", err)
	}

	tx.Value = big.NewInt(1)
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected non-zero value to be denied by default")
	}

	tx = validTx()
	tx.Data = []byte{0xa9, 0x05, 0x9c, 0xbb}
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected calldata to be denied by default")
	}
}

func TestValidateSignTxLimits_ZeroGasLimitDeniesAll(t *testing.T) {
	limits := defaultSignerLimits()
	limits.MaxGasLimit = 0
	withSignerLimits(t, limits)

	if err := validateSignTxLimits(validTx()); err == nil {
		t.Fatal("expected gasLimit 0 to deny every transaction")
	}
}

func TestValidateSignTxLimits_EnforcesConfiguredLists(t *testing.T) {
	limits := defaultSignerLimits()
	limits.MaxValueWei = big.NewInt(100)
	limits.AllowedChainIDs[1] = struct{}{}
	limits.AllowedTo["0x1111111111111111111111111111111111111111"] = struct{}{}
	limits.AllowedSelectors[selectorKey(
		common.HexToAddress("0x1111111111111111111111111111111111111111"),
		"0xa9059cbb",
	)] = struct{}{}
	withSignerLimits(t, limits)

	tx := validTx()
	tx.Value = big.NewInt(100)
	tx.Data = []byte{0xa9, 0x05, 0x9c, 0xbb}
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected chain 84532 to be denied")
	}

	tx.ChainId = big.NewInt(1)
	if err := validateSignTxLimits(tx); err != nil {
		t.Fatalf("allowed chain/to/selector failed: %v", err)
	}

	tx.Value = big.NewInt(101)
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected value over limit to be denied")
	}

	tx = validTx()
	tx.ChainId = big.NewInt(1)
	tx.To = "0x2222222222222222222222222222222222222222"
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected destination outside allowlist to be denied")
	}

	tx = validTx()
	tx.ChainId = big.NewInt(1)
	tx.Data = []byte{0xde, 0xad, 0xbe, 0xef}
	if err := validateSignTxLimits(tx); err == nil {
		t.Fatal("expected selector outside allowlist to be denied")
	}
}

func TestLoadSignerLimits_FromEnv(t *testing.T) {
	t.Setenv("SIGNER_MAX_VALUE_WEI", "42")
	t.Setenv("SIGNER_ALLOWED_CHAIN_IDS", "1,84532")
	t.Setenv("SIGNER_ALLOWED_TO", "0x1111111111111111111111111111111111111111")
	t.Setenv("SIGNER_ALLOWED_SELECTORS", "0x1111111111111111111111111111111111111111:0xa9059cbb")
	t.Setenv("SIGNER_ALLOW_HASH_SIGNING", "true")
	t.Setenv("SIGNER_MAX_GAS_LIMIT", "50000")

	limits, err := loadSignerLimits()
	if err != nil {
		t.Fatalf("loadSignerLimits: %v", err)
	}
	if limits.MaxValueWei.String() != "42" {
		t.Errorf("MaxValueWei = %s", limits.MaxValueWei)
	}
	if len(limits.AllowedChainIDs) != 2 || len(limits.AllowedTo) != 1 || len(limits.AllowedSelectors) != 1 {
		t.Errorf("allowlists not loaded: %d/%d/%d", len(limits.AllowedChainIDs), len(limits.AllowedTo), len(limits.AllowedSelectors))
	}
	if !limits.AllowHashSigning || limits.MaxGasLimit != 50000 {
		t.Errorf("flags not loaded: hash=%t gas=%d", limits.AllowHashSigning, limits.MaxGasLimit)
	}
}

func TestLoadSignerLimits_RejectsInvalidConfig(t *testing.T) {
	t.Setenv("SIGNER_ALLOWED_SELECTORS", "not-an-entry")
	if _, err := loadSignerLimits(); err == nil {
		t.Fatal("expected invalid selector entry to fail")
	}

	t.Setenv("SIGNER_ALLOWED_SELECTORS", "")
	t.Setenv("SIGNER_MAX_GAS_LIMIT", "abc")
	if _, err := loadSignerLimits(); err == nil {
		t.Fatal("expected invalid gas limit to fail")
	}
}

func TestValidateHashSigning_DefaultDeny(t *testing.T) {
	withSignerLimits(t, defaultSignerLimits())
	if err := validateHashSigning(); err == nil {
		t.Fatal("expected hash signing to be disabled by default")
	}

	limits := defaultSignerLimits()
	limits.AllowHashSigning = true
	withSignerLimits(t, limits)
	if err := validateHashSigning(); err != nil {
		t.Fatalf("expected hash signing to be allowed: %v", err)
	}
}

func TestHandleSignHash_DisabledReturnsForbidden(t *testing.T) {
	withSignerLimits(t, defaultSignerLimits())

	body, _ := json.Marshal(SignHashRequest{
		EncryptedSeed:  "fake",
		SeedNonce:      "fake",
		EncryptedDek:   "fake",
		DerivationPath: "m/44'/60'/0'/0/0",
		HashHex:        "0x" + strings.Repeat("11", 32),
	})
	req := httptest.NewRequest(http.MethodPost, "/wallet/sign-hash", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleSignHash(w, req)

	if w.Result().StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Result().StatusCode)
	}
	if !strings.Contains(w.Body.String(), "raw hash signing disabled") {
		t.Errorf("unexpected body: %s", w.Body.String())
	}
}

func TestHandleSignTx_ValueOverLimitReturnsForbidden(t *testing.T) {
	withSignerLimits(t, defaultSignerLimits())

	body, _ := json.Marshal(SignTxRequest{
		EncryptedSeed:  "fake",
		SeedNonce:      "fake",
		EncryptedDek:   "fake",
		DerivationPath: "m/44'/60'/0'/0/0",
		TxFields: TxFieldsJSON{
			ChainId: 1, Nonce: 0, To: "0x1111111111111111111111111111111111111111", Value: "1",
			GasLimit: 21000, MaxFeePerGas: "1", MaxPriorityFeePerGas: "0", Data: "0x",
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/wallet/sign", bytes.NewReader(body))
	w := httptest.NewRecorder()
	HandleSignTx(w, req)

	if w.Result().StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Result().StatusCode)
	}
	if !strings.Contains(w.Body.String(), "value exceeds signer limit") {
		t.Errorf("unexpected body: %s", w.Body.String())
	}
}
