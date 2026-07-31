package main

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// TxFields holds the raw EIP-1559 transaction parameters.
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

// BuildTxHash constructs the EIP-1559 signing hash using the London signer.
// For typed transactions (EIP-1559, EIP-2930, etc.), MarshalBinary includes
// signature placeholder bytes which change the hash. We must use the signer's
// Hash method to get the correct pre-signature hash.
func BuildTxHash(fields TxFields) ([]byte, error) {
	var toAddr *common.Address
	if fields.To != "" {
		addr := common.HexToAddress(fields.To)
		toAddr = &addr
	}

	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   fields.ChainId,
		Nonce:     fields.Nonce,
		GasTipCap: fields.MaxPriorityFeePerGas,
		GasFeeCap: fields.MaxFeePerGas,
		Gas:       fields.GasLimit,
		To:        toAddr,
		Value:     fields.Value,
		Data:      fields.Data,
	})

	signer := types.NewLondonSigner(fields.ChainId)
	hash := signer.Hash(tx)

	return hash.Bytes(), nil
}

// SignTxHash signs a 32-byte transaction hash using secp256k1 (unchanged).
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

	signature, err := crypto.Sign(txHash, ecPrivKey)
	if err != nil {
		return "", fmt.Errorf("secp256k1 sign: %w", err)
	}

	return "0x" + hex.EncodeToString(signature), nil
}

// BuildSignedTx constructs the fully-signed EIP-1559 transaction and returns
// the canonical serialised bytes (0x02 type prefix + RLP body) ready for
// eth_sendRawTransaction. The signature is the 0x-prefixed 65-byte hex string
// returned by SignTxHash (r[32] + s[32] + v[1] where v is 0 or 1).
func BuildSignedTx(fields TxFields, signatureHex string) ([]byte, error) {
	sigBytes, err := hex.DecodeString(strings.TrimPrefix(signatureHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("decode signature hex: %w", err)
	}
	if len(sigBytes) != 65 {
		return nil, fmt.Errorf("signature must be 65 bytes, got %d", len(sigBytes))
	}

	var toAddr *common.Address
	if fields.To != "" {
		addr := common.HexToAddress(fields.To)
		toAddr = &addr
	}

	unsignedTx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   fields.ChainId,
		Nonce:     fields.Nonce,
		GasTipCap: fields.MaxPriorityFeePerGas,
		GasFeeCap: fields.MaxFeePerGas,
		Gas:       fields.GasLimit,
		To:        toAddr,
		Value:     fields.Value,
		Data:      fields.Data,
	})

	// Pass sigBytes directly to WithSignature. crypto.Sign returns exactly
	// R[32] || S[32] || V[1] with all bytes present including leading zeros.
	// Splitting into big.Int and calling .Bytes() would strip leading zeros
	// from R or S, corrupting the signature and causing sender recovery to
	// return the wrong address.
	signer := types.NewLondonSigner(fields.ChainId)
	signedTx, err := unsignedTx.WithSignature(signer, sigBytes)
	if err != nil {
		return nil, fmt.Errorf("attach signature to tx: %w", err)
	}

	rawBytes, err := signedTx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("marshal signed tx to binary: %w", err)
	}

	return rawBytes, nil
}
