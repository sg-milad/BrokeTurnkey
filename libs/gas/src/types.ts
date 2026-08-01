export interface FeeEstimate {
    gasLimit: number;
    maxFeePerGas: string;      // decimal string, wei
    maxPriorityFeePerGas: string; // decimal string, wei
}

export interface TransactionReceipt {
    transactionHash: string;
    blockNumber: number;
    status: number; // 1 = success, 0 = reverted
    gasUsed?: string;
    effectiveGasPrice?: string;
}

export type ErrorType = 'retryable' | 'permanent' | 'unknown';
