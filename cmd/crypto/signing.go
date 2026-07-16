package main

import (
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// TxFields holds the raw EIP-1559 transaction parameters needed to construct
// the signing payload. Values are big integers to handle large Wei amounts
// safely without float precision loss. Data is raw bytes (omit the "0x" prefix).
type TxFields struct {
	ChainId              *big.Int
	Nonce                uint64
	MaxFeePerGas         *big.Int
	MaxPriorityFeePerGas *big.Int
	GasLimit             uint64
	To                   string
	Value                *big.Int
	Data                 []byte
}

// BuildTxHash constructs the EIP-1559 transaction payload, marshals it to
// its canonical binary representation (0x02 type byte + RLP encoded fields),
// and returns the Keccak256 hash of those bytes.
func BuildTxHash(fields TxFields) ([]byte, error) {
	var toAddr *common.Address
	if fields.To != "" {
		addr := common.HexToAddress(fields.To)
		toAddr = &addr
	}

	// Construct the internal go-ethereum EIP-1559 transaction struct.
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   fields.ChainId,
		Nonce:     fields.Nonce,
		GasTipCap: fields.MaxPriorityFeePerGas,
		GasFeeCap: fields.MaxFeePerGas,
		Gas:       fields.GasLimit,
		To:        toAddr, // nil pointer correctly encodes as contract creation
		Value:     fields.Value,
		Data:      fields.Data,
	})

	// MarshalBinary returns the exact bytes that get hashed internally by tx.Hash().
	// It prepends the 0x02 type byte and RLP-encodes the fields identically to the Ethereum spec.
	encodedTx, err := tx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("marshal tx to binary: %w", err)
	}

	return crypto.Keccak256(encodedTx), nil
}

// SignTxHash signs a 32-byte transaction hash using secp256k1.
// It returns a 0x-prefixed 130-character hex string representing the
// 65-byte signature (r [32] + s [32] + v [1]).
// For EIP-1559, v is the recovery ID (0 or 1), NOT the legacy 27/28.
// The caller MUST zero privKey after this call returns.
func SignTxHash(txHash, privKey []byte) (string, error) {
	if len(privKey) != 32 {
		return "", fmt.Errorf("private key must be 32 bytes, got %d", len(privKey))
	}
	if len(txHash) != 32 {
		return "", fmt.Errorf("tx hash must be 32 bytes, got %d", len(txHash))
	}

	ecPrivKey, err := crypto.ToECDSA(privKey)
	if err != nil {
		return "", fmt.Errorf("parse ECDSA private key: %w", err)
	}

	// crypto.Sign returns r || s || v where v is 0 or 1.
	signature, err := crypto.Sign(txHash, ecPrivKey)
	if err != nil {
		return "", fmt.Errorf("secp256k1 sign: %w", err)
	}

	return "0x" + hex.EncodeToString(signature), nil
}
