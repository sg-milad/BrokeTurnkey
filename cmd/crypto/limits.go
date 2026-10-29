package main

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

// SignerLimits is the crypto sidecar's last line of defense. NestJS policy is
// still the primary authorization layer, but these checks are enforced here so
// that a fully compromised API (holding CRYPTO_AUTH_TOKEN and DB ciphertext)
// cannot ask the signer for an arbitrary transaction.
type SignerLimits struct {
	MaxValueWei           *big.Int
	AllowedChainIDs       map[uint64]struct{}
	AllowedTo             map[string]struct{}
	AllowedSelectors      map[string]struct{}
	AllowContractCreation bool
	AllowHashSigning      bool
	MaxGasLimit           uint64
}

func defaultSignerLimits() *SignerLimits {
	return &SignerLimits{
		MaxValueWei:      big.NewInt(0),
		AllowedChainIDs:  make(map[uint64]struct{}),
		AllowedTo:        make(map[string]struct{}),
		AllowedSelectors: make(map[string]struct{}),
		MaxGasLimit:      1_000_000,
	}
}

// signerLimits is package-level so handlers can use it without threading config
// through every call. main() replaces it at startup; tests may replace it too.
var signerLimits = defaultSignerLimits()

func loadSignerLimits() (*SignerLimits, error) {
	limits := defaultSignerLimits()

	rawMax := strings.TrimSpace(os.Getenv("SIGNER_MAX_VALUE_WEI"))
	if rawMax == "" {
		rawMax = "0"
	}
	if len(rawMax) > maxDecimalDigits {
		return nil, fmt.Errorf("SIGNER_MAX_VALUE_WEI too large")
	}
	maxValue, ok := new(big.Int).SetString(rawMax, 10)
	if !ok || maxValue.Sign() < 0 {
		return nil, fmt.Errorf("invalid SIGNER_MAX_VALUE_WEI")
	}
	limits.MaxValueWei = maxValue

	if err := parseUintSet(os.Getenv("SIGNER_ALLOWED_CHAIN_IDS"), limits.AllowedChainIDs); err != nil {
		return nil, fmt.Errorf("invalid SIGNER_ALLOWED_CHAIN_IDS: %w", err)
	}

	for _, entry := range splitList(os.Getenv("SIGNER_ALLOWED_TO")) {
		if !common.IsHexAddress(entry) {
			return nil, fmt.Errorf("invalid address in SIGNER_ALLOWED_TO: %s", entry)
		}
		limits.AllowedTo[strings.ToLower(common.HexToAddress(entry).Hex())] = struct{}{}
	}

	for _, entry := range splitList(os.Getenv("SIGNER_ALLOWED_SELECTORS")) {
		to, selector, err := parseSelectorEntry(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid SIGNER_ALLOWED_SELECTORS entry %q: %w", entry, err)
		}
		limits.AllowedSelectors[selectorKey(to, selector)] = struct{}{}
	}

	allowCreation, err := envBool("SIGNER_ALLOW_CONTRACT_CREATION", false)
	if err != nil {
		return nil, fmt.Errorf("invalid SIGNER_ALLOW_CONTRACT_CREATION: %w", err)
	}
	limits.AllowContractCreation = allowCreation

	allowHash, err := envBool("SIGNER_ALLOW_HASH_SIGNING", false)
	if err != nil {
		return nil, fmt.Errorf("invalid SIGNER_ALLOW_HASH_SIGNING: %w", err)
	}
	limits.AllowHashSigning = allowHash

	rawGas := strings.TrimSpace(os.Getenv("SIGNER_MAX_GAS_LIMIT"))
	if rawGas != "" {
		gas, err := strconv.ParseUint(rawGas, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid SIGNER_MAX_GAS_LIMIT")
		}
		limits.MaxGasLimit = gas
	}

	return limits, nil
}

func splitList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func parseUintSet(raw string, dst map[uint64]struct{}) error {
	for _, entry := range splitList(raw) {
		value, err := strconv.ParseUint(entry, 10, 64)
		if err != nil {
			return err
		}
		dst[value] = struct{}{}
	}
	return nil
}

func envBool(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	return strconv.ParseBool(raw)
}

func parseSelectorEntry(entry string) (common.Address, string, error) {
	parts := strings.Split(entry, ":")
	if len(parts) != 2 {
		return common.Address{}, "", fmt.Errorf("expected to:selector")
	}
	if !common.IsHexAddress(parts[0]) {
		return common.Address{}, "", fmt.Errorf("invalid to address")
	}
	selector := strings.ToLower(strings.TrimSpace(parts[1]))
	if len(selector) != 10 || !strings.HasPrefix(selector, "0x") {
		return common.Address{}, "", fmt.Errorf("selector must be 0x-prefixed 4-byte hex")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(selector, "0x")); err != nil {
		return common.Address{}, "", fmt.Errorf("invalid selector hex")
	}
	return common.HexToAddress(parts[0]), selector, nil
}

func selectorKey(to common.Address, selector string) string {
	return strings.ToLower(to.Hex()) + ":" + strings.ToLower(selector)
}

func validateSignTxLimits(tx TxFields) error {
	if tx.Value != nil && tx.Value.Cmp(signerLimits.MaxValueWei) > 0 {
		return fmt.Errorf("transaction value exceeds signer limit")
	}

	if len(signerLimits.AllowedChainIDs) > 0 {
		if tx.ChainId == nil || !tx.ChainId.IsInt64() {
			return fmt.Errorf("chainId not allowed by signer")
		}
		if _, ok := signerLimits.AllowedChainIDs[uint64(tx.ChainId.Int64())]; !ok {
			return fmt.Errorf("chainId not allowed by signer")
		}
	}

	if tx.GasLimit > signerLimits.MaxGasLimit {
		return fmt.Errorf("gasLimit exceeds signer limit")
	}

	to := strings.ToLower(common.HexToAddress(tx.To).Hex())
	if tx.To == "" {
		if !signerLimits.AllowContractCreation {
			return fmt.Errorf("contract creation not allowed by signer")
		}
	} else if len(signerLimits.AllowedTo) > 0 {
		if _, ok := signerLimits.AllowedTo[to]; !ok {
			return fmt.Errorf("destination not allowed by signer")
		}
	}

	if len(tx.Data) > 0 {
		if tx.To == "" {
			return fmt.Errorf("calldata contract creation not allowed by signer")
		}
		if len(signerLimits.AllowedSelectors) == 0 || len(tx.Data) < 4 {
			return fmt.Errorf("calldata selector not allowed by signer")
		}
		selector := "0x" + hex.EncodeToString(tx.Data[:4])
		if _, ok := signerLimits.AllowedSelectors[selectorKey(common.HexToAddress(tx.To), selector)]; !ok {
			return fmt.Errorf("calldata selector not allowed by signer")
		}
	}

	return nil
}

func validateHashSigning() error {
	if !signerLimits.AllowHashSigning {
		return fmt.Errorf("raw hash signing disabled by signer")
	}
	return nil
}
