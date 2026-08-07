import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SigningRequest } from '@app/db/schema/signing-requests';
import { SigningRequestRepository } from '@app/db/repositories/signing-request.repository';
import { GasService } from '@app/gas';
import { CryptoClientService } from '@app/crypto-client';

@Injectable()
export class SpeedUpService {
  private readonly logger = new Logger(SpeedUpService.name);
  private readonly maxSpeedUpAttempts: number;
  private readonly gasBumpMultiplier: number;

  constructor(
    private readonly signingRequestRepo: SigningRequestRepository,
    private readonly gasService: GasService,
    private readonly cryptoClient: CryptoClientService,
    private readonly config: ConfigService,
  ) {
    this.maxSpeedUpAttempts = Number(config.get('MAX_SPEED_UP_ATTEMPTS', '3'));
    this.gasBumpMultiplier = Number(config.get('GAS_BUMP_MULTIPLIER', '1.2'));
  }

  /**
   * Attempts to speed up a stuck transaction by broadcasting a replacement
   * tx with the same nonce but higher gas fees.
   *
   * Pre-conditions (caller must verify):
   *   - The tx has no receipt and has exceeded the stuck threshold.
   *   - `eth_getTransactionByHash` confirms it is still in the mempool.
   */
  async speedUp(row: SigningRequest): Promise<void> {
    const attempts = row.speed_up_attempts ?? 0;

    // ---------------------------------------------------------------
    // 1.  Check attempt budget
    // ---------------------------------------------------------------
    if (attempts >= this.maxSpeedUpAttempts) {
      this.logger.warn(
        `Speed-up: max attempts (${this.maxSpeedUpAttempts}) reached for signing_request ${row.id} — marking failed`,
      );
      await this.signingRequestRepo.update(row.id, {
        status: 'failed',
        error_type: 'permanent',
        failure_reason: 'max speed-up attempts reached',
      });
      return;
    }

    // ---------------------------------------------------------------
    // 2.  Rebuild the tx with bumped fees and the SAME nonce
    // ---------------------------------------------------------------
    const txPayload = row.tx_payload as Record<string, string> | null;
    if (!txPayload) {
      this.logger.error(
        `Speed-up: signing_request ${row.id} has no tx_payload — cannot rebuild`,
      );
      await this.signingRequestRepo.update(row.id, {
        status: 'failed',
        error_type: 'unknown',
        failure_reason: 'missing tx_payload for speed-up',
      });
      return;
    }

    const nonce = Number(txPayload.nonce);
    const chainId = row.chain_id;

    // Fetch fresh fee data so we are not using stale values
    const feeEstimate = await this.gasService.estimateFees(
      txPayload.to,
      txPayload.value,
      txPayload.data,
      chainId,
    );

    // Apply the bump multiplier on top of the fresh estimate
    const bumpedMaxFee = BigInt(feeEstimate.maxFeePerGas);
    const bumpedMaxPriority = BigInt(feeEstimate.maxPriorityFeePerGas);
    const bumpedGasLimit = feeEstimate.gasLimit;

    this.logger.log(
      `Speed-up: rebuilding signing_request ${row.id} ` +
        `(attempt ${attempts + 1}/${this.maxSpeedUpAttempts}) ` +
        `nonce=${nonce} chainId=${chainId}`,
    );

    // ---------------------------------------------------------------
    // 3.  Sign the replacement tx (in-process, no HTTP, no stamp)
    // ---------------------------------------------------------------
    let rawTx: string;
    let txHash: string;
    try {
      const result = await this.cryptoClient.signTransaction(
        txPayload.encryptedSeed,
        txPayload.seedNonce,
        txPayload.encryptedDek,
        txPayload.derivationPath,
        {
          chainId,
          nonce,
          to: txPayload.to,
          value: txPayload.value,
          data: txPayload.data,
          gasLimit: bumpedGasLimit,
          maxFeePerGas: bumpedMaxFee.toString(),
          maxPriorityFeePerGas: bumpedMaxPriority.toString(),
        },
      );
      rawTx = result.rawTx;
      txHash = result.txHash;
    } catch (err) {
      this.logger.error(
        `Speed-up: signing failed for signing_request ${row.id}: ${(err as Error).message}`,
      );
      await this.signingRequestRepo.update(row.id, {
        status: 'failed',
        error_type: 'retryable',
        failure_reason: `speed-up signing failed: ${(err as Error).message}`,
      });
      return;
    }

    // ---------------------------------------------------------------
    // 4.  Broadcast the replacement tx
    // ---------------------------------------------------------------
    try {
      const broadcastHash = await this.gasService.broadcastTransaction(
        rawTx,
        chainId,
      );
      if (broadcastHash.toLowerCase() !== txHash.toLowerCase()) {
        this.logger.warn(
          `Speed-up: broadcast returned different hash (${broadcastHash}) than signing (${txHash}) for signing_request ${row.id}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Speed-up: broadcast failed for signing_request ${row.id}: ${(err as Error).message}`,
      );
      await this.signingRequestRepo.update(row.id, {
        status: 'failed',
        error_type: 'retryable',
        failure_reason: `speed-up broadcast failed: ${(err as Error).message}`,
      });
      return;
    }

    // ---------------------------------------------------------------
    // 5.  Update the signing request row
    // ---------------------------------------------------------------
    const originalTxHash = row.original_tx_hash ?? row.tx_hash;

    await this.signingRequestRepo.update(row.id, {
      tx_hash: txHash,
      original_tx_hash: originalTxHash,
      speed_up_attempts: attempts + 1,
      last_speed_up_at: new Date(),
      status: 'broadcasted',
      // Clear stale confirmation fields that may have been set by a
      // previous speed-up cycle
      block_number: undefined,
      gas_used: undefined,
      effective_gas_price: undefined,
    });

    this.logger.log(
      `Speed-up: replacement tx ${txHash} broadcast for signing_request ${row.id} ` +
        `(attempt ${attempts + 1}, original_tx_hash=${originalTxHash})`,
    );
  }
}
