import { Inject, Injectable, Logger } from '@nestjs/common';
import { WALLET_NONCE_REPOSITORY } from '@app/db/constants';
import type { IWalletNonceRepository } from '@app/db/repositories';
import { FeeEstimate, TransactionReceipt, ErrorType } from './types';
import { classifyError } from './error-classifier';
import { ChainService } from './chain.service';

@Injectable()
export class GasService {
  private readonly logger = new Logger(GasService.name);

  constructor(
    private readonly chainService: ChainService,
    @Inject(WALLET_NONCE_REPOSITORY)
    private readonly walletNonceRepo: IWalletNonceRepository,
  ) {}

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
      this.estimateGas(to, value, data, chainId, from),
      this.fetchFeeData(chainId),
    ]);

    return { gasLimit, ...feeData };
  }

  private async estimateGas(
    to: string,
    value: string,
    data: string,
    chainId: number,
    from?: string,
  ): Promise<number> {
    const params: Record<string, string> = {
      to,
      value: this.toHex(BigInt(value)),
      data,
    };
    if (from) params.from = from;

    const result = await this.rpcCallWithRetry<string>(
      'eth_estimateGas',
      [params],
      chainId,
    );

    // Add a 20% buffer so the tx doesn't run out of gas on-chain
    const estimated = BigInt(result);
    return Number((estimated * 120n) / 100n);
  }

  private async fetchFeeData(chainId: number): Promise<{
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }> {
    // eth_feeHistory returns the last 5 blocks so we can compute a
    // reasonable base fee. We use the 75th percentile reward as the tip.
    const history = await this.rpcCallWithRetry<{
      baseFeePerGas: string[];
      reward: string[][];
    }>('eth_feeHistory', [5, 'latest', [75]], chainId);

    // The last element of baseFeePerGas is the NEXT block's projected base fee
    const baseFee = BigInt(
      history.baseFeePerGas[history.baseFeePerGas.length - 1],
    );

    // Median tip across the sampled blocks
    const tips = history.reward.map((r) => BigInt(r[0]));
    const medianTip = tips.sort((a, b) => (a < b ? -1 : 1))[
      Math.floor(tips.length / 2)
    ];

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

  /**
   * Atomically reserves and consumes the next nonce for the wallet+chain pair.
   * The reservation is permanent (see WalletNonceRepository.reserve) so
   * concurrent sign requests can never share a nonce.
   */
  async reserveNonce(walletId: string, chainId: number): Promise<number> {
    return this.walletNonceRepo.reserve(walletId, chainId);
  }

  /** Releases a nonce only if it is still the newest reservation. */
  async releaseNonce(
    walletId: string,
    chainId: number,
    nonce: number,
  ): Promise<boolean> {
    return this.walletNonceRepo.release(walletId, chainId, nonce);
  }

  // -------------------------------------------------------------------------
  // Broadcast with retry and failover
  // -------------------------------------------------------------------------

  async broadcastTransaction(
    rawTxHex: string,
    chainId: number,
  ): Promise<string> {
    this.logger.log(
      `Broadcasting to chainId ${chainId}, rawTx length: ${rawTxHex?.length}`,
    );
    const result = await this.rpcCallWithRetry<string>(
      'eth_sendRawTransaction',
      [rawTxHex],
      chainId,
    );
    this.logger.log(`Broadcast result: ${result}`);
    return result;
  }

  async waitForReceipt(
    txHash: string,
    chainId: number,
    timeoutMs: number = 60_000,
  ): Promise<{ receipt: TransactionReceipt | null; timedOut: boolean }> {
    const pollIntervalMs = 3_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const receipt = await this.rpcCallWithRetry<TransactionReceipt | null>(
        'eth_getTransactionReceipt',
        [txHash],
        chainId,
      );

      if (receipt !== null) {
        return { receipt, timedOut: false };
      }

      await this.sleep(pollIntervalMs);
    }

    this.logger.warn(
      `waitForReceipt: timeout after ${timeoutMs}ms for ${txHash}`,
    );

    // Check if tx exists in mempool after timeout
    try {
      const tx = await this.rpcCallWithRetry<any>(
        'eth_getTransactionByHash',
        [txHash],
        chainId,
      );
      if (tx === null) {
        this.logger.warn(`Transaction ${txHash} not found - likely dropped`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to check tx status after timeout: ${(err as Error).message}`,
      );
    }

    return { receipt: null, timedOut: true };
  }

  // -------------------------------------------------------------------------
  // Single-shot RPC queries (used by TransactionMonitorService)
  // -------------------------------------------------------------------------

  /**
   * Fetches a transaction receipt by hash. Returns null if the tx has not
   * been mined yet (no receipt = not confirmed).
   */
  async getTransactionReceipt(
    txHash: string,
    chainId: number,
  ): Promise<TransactionReceipt | null> {
    const raw = await this.rpcCallWithRetry<Record<string, unknown> | null>(
      'eth_getTransactionReceipt',
      [txHash],
      chainId,
    );
    if (!raw) return null;

    // JSON-RPC returns status as hex string '0x1' or '0x0' — normalise to
    // number so downstream comparisons (status === 1) work reliably.
    return {
      transactionHash: raw.transactionHash as string,
      blockNumber: Number(raw.blockNumber),
      status:
        typeof raw.status === 'string'
          ? parseInt(raw.status, 16)
          : Number(raw.status),
      gasUsed: raw.gasUsed != null ? String(raw.gasUsed) : undefined,
      effectiveGasPrice:
        raw.effectiveGasPrice != null
          ? String(raw.effectiveGasPrice)
          : undefined,
    };
  }

  /**
   * Fetches the full transaction object by hash. Returns null if the tx
   * is not found (dropped or never existed).
   */
  async getTransactionByHash(txHash: string, chainId: number): Promise<any> {
    return this.rpcCallWithRetry<any>(
      'eth_getTransactionByHash',
      [txHash],
      chainId,
    );
  }

  async syncNonce(
    walletId: string,
    chainId: number,
    walletAddress: string,
  ): Promise<number> {
    const result = await this.rpcCallWithRetry<string>(
      'eth_getTransactionCount',
      [walletAddress, 'pending'],
      chainId,
    );
    const chainNonce = parseInt(result, 16);
    await this.walletNonceRepo.syncFromChain(walletId, chainId, chainNonce);
    this.logger.log(
      `Synced nonce for wallet ${walletId} on chain ${chainId}: ${chainNonce}`,
    );
    return chainNonce;
  }

  // -------------------------------------------------------------------------
  // RPC helpers with retry and failover
  // -------------------------------------------------------------------------

  private async rpcCallWithRetry<T>(
    method: string,
    params: unknown[],
    chainId: number,
    maxRetries = 3,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.rpcCall<T>(method, params, chainId);
      } catch (err) {
        lastError = err as Error;
        const errorType = classifyError(lastError);

        // Don't retry permanent errors
        if (errorType === 'permanent') {
          throw lastError;
        }

        // Exponential backoff for retryable errors
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          this.logger.warn(
            `RPC call ${method} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${delay}ms...`,
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private async rpcCall<T>(
    method: string,
    params: unknown[],
    chainId: number,
  ): Promise<T> {
    const rpcUrls = this.chainService.getRpcUrls(chainId);

    // Try each RPC URL in order
    for (let i = 0; i < rpcUrls.length; i++) {
      const rpcUrl = rpcUrls[i];
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        if (!response.ok) {
          throw new Error(
            `RPC HTTP error: ${response.status} ${response.statusText}`,
          );
        }

        const json = (await response.json()) as {
          result?: T;
          error?: { message: string };
        };

        if (json.error) {
          throw new Error(`RPC error [${method}]: ${json.error.message}`);
        }

        return json.result as T;
      } catch (err) {
        this.logger.warn(
          `RPC provider ${i + 1} (${rpcUrl}) failed for ${method}: ${(err as Error).message}`,
        );

        // If this is the last provider, throw the error
        if (i === rpcUrls.length - 1) {
          throw err;
        }

        // Otherwise, try the next provider
        continue;
      }
    }

    throw new Error('All RPC providers failed');
  }

  private toHex(value: bigint): string {
    return '0x' + value.toString(16);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
