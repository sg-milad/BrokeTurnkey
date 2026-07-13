// Package main is the isolated signing binary for WalletMVP.
//
// This binary receives sensitive key material via stdin (OS pipe),
// performs BIP32 derivation and transaction signing, writes the
// signature to stdout, zeroes all sensitive memory, and exits.
//
// It is intentionally a separate process from the NestJS API so that
// a memory dump of the API process cannot expose private keys or DEKs.
//
// TODO: implement in Phase 3.
// Expected stdin payload (JSON):
//
//	{
//	  "encryptedSeed": "<base64>",
//	  "seedNonce":     "<base64>",
//	  "plaintextDek":  "<base64>",
//	  "derivPath":     "m/44'/60'/0'/0/0",
//	  "txHash":        "<hex>"
//	}
//
// Expected stdout payload (JSON):
//
//	{
//	  "signature": "<hex r+s+v>"
//	}
package main

import "fmt"

func main() {
	fmt.Println(`{"error":"signer not yet implemented"}`)
}
