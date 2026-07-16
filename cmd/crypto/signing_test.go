package main

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// --------------------------------------------------------------------------
// BuildTxHash
// --------------------------------------------------------------------------

func TestBuildTxHash_MatchesGoEthereum(t *testing.T) {
	fields := TxFields{
		ChainId:              big.NewInt(1),
		Nonce:                42,
		MaxFeePerGas:         big.NewInt(30000000000),
		MaxPriorityFeePerGas: big.NewInt(1000000000),
		GasLimit:             21000,
		To:                   "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
		Value:                big.NewInt(1000000000000000000),              // 1 ETH
		Data:                 []byte{},
	}

	hash, err := BuildTxHash(fields)
	if err != nil {
		t.Fatalf("BuildTxHash failed: %v", err)
	}

	// Verify against go-ethereum's own native EIP-1559 hashing implementation
	toAddr := common.HexToAddress(fields.To)
	ethTx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   fields.ChainId,
		Nonce:     fields.Nonce,
		GasFeeCap: fields.MaxFeePerGas,
		GasTipCap: fields.MaxPriorityFeePerGas,
		Gas:       fields.GasLimit,
		To:        &toAddr,
		Value:     fields.Value,
		Data:      fields.Data,
	})

	expectedHash := ethTx.Hash().Bytes()

	if !bytes.Equal(hash, expectedHash) {
		t.Errorf("tx hash mismatch\ngot:  0x%x\nwant: 0x%x", hash, expectedHash)
	}
}

func TestBuildTxHash_ContractCreation(t *testing.T) {
	// Contract creation has an empty "To" field. It must encode correctly as nil.
	fields := TxFields{
		ChainId:              big.NewInt(1),
		Nonce:                0,
		MaxFeePerGas:         big.NewInt(100000000000),
		MaxPriorityFeePerGas: big.NewInt(1000000000),
		GasLimit:             100000,
		To:                   "", // Contract creation
		Value:                big.NewInt(0),
		Data:                 []byte{0x60, 0x00}, // PUSH0 STOP
	}

	hash, err := BuildTxHash(fields)
	if err != nil {
		t.Fatalf("BuildTxHash failed: %v", err)
	}

	// Verify against go-ethereum (passing nil for To)
	ethTx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   fields.ChainId,
		Nonce:     fields.Nonce,
		GasFeeCap: fields.MaxFeePerGas,
		GasTipCap: fields.MaxPriorityFeePerGas,
		Gas:       fields.GasLimit,
		To:        nil, // Contract creation
		Value:     fields.Value,
		Data:      fields.Data,
	})

	expectedHash := ethTx.Hash().Bytes()

	if !bytes.Equal(hash, expectedHash) {
		t.Errorf("contract creation tx hash mismatch\ngot:  0x%x\nwant: 0x%x", hash, expectedHash)
	}
}

func TestBuildTxHash_Deterministic(t *testing.T) {
	fields := TxFields{
		ChainId:              big.NewInt(137), // Polygon
		Nonce:                10,
		MaxFeePerGas:         big.NewInt(50000000000),
		MaxPriorityFeePerGas: big.NewInt(2000000000),
		GasLimit:             21000,
		To:                   "0x0000000000000000000000000000000000000001",
		Value:                big.NewInt(0),
		Data:                 nil,
	}

	hash1, _ := BuildTxHash(fields)
	hash2, _ := BuildTxHash(fields)

	if !bytes.Equal(hash1, hash2) {
		t.Error("same fields produced different hashes")
	}
}

// --------------------------------------------------------------------------
// SignTxHash
// --------------------------------------------------------------------------

func TestSignTxHash_KnownVector(t *testing.T) {
	// Foundry Anvil default account #0
	privKeyHex := "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	privKeyBytes, err := hex.DecodeString(privKeyHex[2:])
	if err != nil {
		t.Fatalf("failed to decode private key: %v", err)
	}
	defer ZeroBytes(privKeyBytes)

	txHash := common.HexToHash("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef").Bytes()

	sig, err := SignTxHash(txHash, privKeyBytes)
	if err != nil {
		t.Fatalf("SignTxHash failed: %v", err)
	}

	if !strings.HasPrefix(sig, "0x") {
		t.Error("signature missing 0x prefix")
	}

	sigBytes, err := hex.DecodeString(sig[2:])
	if err != nil {
		t.Fatalf("failed to decode signature hex: %v", err)
	}

	if len(sigBytes) != 65 {
		t.Errorf("expected 65-byte signature (r+s+v), got %d bytes", len(sigBytes))
	}

	// Verify the signature recovers to the correct public key
	recoveredPubkey, err := crypto.SigToPub(txHash, sigBytes)
	if err != nil {
		t.Fatalf("failed to recover public key: %v", err)
	}

	recoveredAddr := crypto.PubkeyToAddress(*recoveredPubkey)
	expectedAddr := common.HexToAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") // Anvil #0

	if recoveredAddr != expectedAddr {
		t.Errorf("recovered address mismatch\ngot:  %s\nwant: %s", recoveredAddr.Hex(), expectedAddr.Hex())
	}
}

func TestSignTxHash_BadKeyLength(t *testing.T) {
	txHash := make([]byte, 32)
	shortKey := make([]byte, 16)
	defer ZeroBytes(shortKey)

	_, err := SignTxHash(txHash, shortKey)
	if err == nil {
		t.Fatal("expected error for 16-byte key, got nil")
	}
}

func TestSignTxHash_BadHashLength(t *testing.T) {
	privKey := make([]byte, 32)
	defer ZeroBytes(privKey)
	shortHash := make([]byte, 20)

	_, err := SignTxHash(shortHash, privKey)
	if err == nil {
		t.Fatal("expected error for 20-byte hash, got nil")
	}
}

func TestSignTxHash_InvalidKey(t *testing.T) {
	txHash := make([]byte, 32)
	// All zeros is not a valid secp256k1 private key scalar
	zeroKey := make([]byte, 32)
	defer ZeroBytes(zeroKey)

	_, err := SignTxHash(txHash, zeroKey)
	if err == nil {
		t.Fatal("expected error for zero private key, got nil")
	}
}
