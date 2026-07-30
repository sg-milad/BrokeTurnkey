export interface TxFields {
    chainId: number;
    nonce: number;
    to: string;
    value: string;
    gasLimit: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    data: string;
}

export interface CreateWalletResponse {
    encryptedSeed: string;
    seedNonce: string;
    encryptedDek: string;
    firstAddress: string;
}

export interface DeriveWalletResponse {
    address: string;
    derivationPath: string;
}


export interface SignTransactionResult {
    signature: string; // 0x-prefixed 65-byte hex
    txHash: string;    // 0x-prefixed 32-byte keccak256
    rawTx: string;     // 0x-prefixed RLP-encoded signed tx, ready for broadcast
}
