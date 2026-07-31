import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WALLET_NONCE_REPOSITORY } from '@app/db/constants';
import type { IWalletNonceRepository } from '@app/db/repositories';

export interface FeeEstimate {
    gasLimit: number;
    maxFeePerGas: string;      // decimal string, wei
    maxPriorityFeePerGas: string; // decimal string, wei
}

export interface TransactionReceipt {
    transactionHash: string;
    blockNumber: number;
    status: number; // 1 = success, 0 = reverted
}

@Injectable()
export class GasService {
    private readonly logger = new Logger(GasService.name);
    private readonly rpcUrl: string;

    constructor(
        private readonly config: ConfigService,
        @Inject(WALLET_NONCE_REPOSITORY)
        private readonly walletNonceRepo: IWalletNonceRepository,
    ) {
        this.rpcUrl = this.config.getOrThrow<string>('RPC_URL');
    }

    // -------------------------------------------------------------------------
    // Fee estimation — EIP-1559 only
    // -------------------------------------------------------------------------

    async estimateFees(
        to: string,
        value: string,
        data: string,
        chainId: number,
        from?: string,
    ): Promise<FeeEstimate> {
        const [gasLimit, feeData] = await Promise.all([
            this.estimateGas(to, value, data, from),
            this.fetchFeeData(),
        ]);

        return { gasLimit, ...feeData };
    }

    private async estimateGas(
        to: string,
        value: string,
        data: string,
        from?: string,
    ): Promise<number> {
        const params: Record<string, string> = { to, value: this.toHex(BigInt(value)), data };
        if (from) params.from = from;

        const result = await this.rpcCall<string>('eth_estimateGas', [params]);

        // Add a 20% buffer so the tx doesn't run out of gas on-chain
        const estimated = BigInt(result);
        return Number((estimated * 120n) / 100n);
    }

    private async fetchFeeData(): Promise<{
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
    }> {
        // eth_feeHistory returns the last 5 blocks so we can compute a
        // reasonable base fee. We use the 75th percentile reward as the tip.
        const history = await this.rpcCall<{
            baseFeePerGas: string[];
            reward: string[][];
        }>('eth_feeHistory', [5, 'latest', [75]]);

        // The last element of baseFeePerGas is the NEXT block's projected base fee
        const baseFee = BigInt(history.baseFeePerGas[history.baseFeePerGas.length - 1]);

        // Median tip across the sampled blocks
        const tips = history.reward.map((r) => BigInt(r[0]));
        const medianTip = tips.sort((a, b) => (a < b ? -1 : 1))[Math.floor(tips.length / 2)];

        // maxFeePerGas = 2× baseFee + tip (standard heuristic, same as ethers.js)
        const maxFeePerGas = baseFee * 2n + medianTip;

        return {
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: medianTip.toString(),
        };
    }

    // -------------------------------------------------------------------------
    // Nonce management
    // -------------------------------------------------------------------------

    async getNextNonce(walletId: string, chainId: number): Promise<number> {
        return this.walletNonceRepo.getAndLock(walletId, chainId);
    }

    async incrementNonce(walletId: string, chainId: number): Promise<void> {
        return this.walletNonceRepo.increment(walletId, chainId);
    }

    // -------------------------------------------------------------------------
    // Broadcast
    // -------------------------------------------------------------------------

    async broadcastTransaction(rawTxHex: string): Promise<string> {
        const txHash = await this.rpcCall<string>('eth_sendRawTransaction', [rawTxHex]);
        return txHash;
    }

    async waitForReceipt(
        txHash: string,
        timeoutMs: number = 60_000,
    ): Promise<{ receipt: TransactionReceipt | null; timedOut: boolean }> {
        const pollIntervalMs = 3_000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const receipt = await this.rpcCall<TransactionReceipt | null>(
                'eth_getTransactionReceipt',
                [txHash],
            );

            if (receipt !== null) {
                return { receipt, timedOut: false };
            }

            await this.sleep(pollIntervalMs);
        }

        this.logger.warn(`waitForReceipt: timeout after ${timeoutMs}ms for ${txHash}`);
        return { receipt: null, timedOut: true };
    }

    private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        if (!response.ok) {
            throw new Error(`RPC HTTP error: ${response.status} ${response.statusText}`);
        }

        const json = (await response.json()) as { result?: T; error?: { message: string } };

        if (json.error) {
            throw new Error(`RPC error [${method}]: ${json.error.message}`);
        }

        return json.result as T;
    }

    private toHex(value: bigint): string {
        return '0x' + value.toString(16);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}