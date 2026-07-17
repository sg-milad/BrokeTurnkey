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

export interface SignTransactionResponse {
    signature: string;
    txHash: string;
}