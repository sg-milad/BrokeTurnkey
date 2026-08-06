import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SigningRequestRepository } from '@app/db/repositories/signing-request.repository';
import { GasService, TransactionReceipt } from '@app/gas';
import { SpeedUpService } from './speed-up.service';

@Injectable()
export class PendingMonitor {
    private readonly logger = new Logger(PendingMonitor.name);
    private readonly stuckThresholdMinutes: number;

    constructor(
        private readonly signingRequestRepo: SigningRequestRepository,
        private readonly gasService: GasService,
        private readonly speedUpService: SpeedUpService,
        config: ConfigService,
    ) {
        this.stuckThresholdMinutes = Number(
            config.get('STUCK_THRESHOLD_MINUTES', '5'),
        );
    }

    /**
     * Called by the scheduled cron. Queries all signing_requests with
     * status = 'broadcasted' and drives each one forward.
     */
    async poll(): Promise<void> {
        let rows;
        try {
            rows = await this.signingRequestRepo.findBroadcasted();
        } catch (err) {
            this.logger.error(
                `PendingMonitor: failed to query broadcasted rows: ${(err as Error).message}`,
            );
            return;
        }

        if (rows.length === 0) return;

        this.logger.log(`PendingMonitor: processing ${rows.length} broadcasted signing_request(s)`);

        for (const row of rows) {
            try {
                await this.processRow(row);
            } catch (err) {
                this.logger.error(
                    `PendingMonitor: unexpected error processing signing_request ${row.id}: ${(err as Error).message}`,
                );
            }
        }
    }

    private async processRow(
        row: Awaited<ReturnType<SigningRequestRepository['findBroadcasted']>>[number],
    ): Promise<void> {
        const txHash = row.tx_hash;
        if (!txHash) {
            // Should never happen for broadcasted rows — defensive mark
            this.logger.error(
                `PendingMonitor: signing_request ${row.id} is broadcasted but has no tx_hash`,
            );
            await this.signingRequestRepo.update(row.id, {
                status: 'failed',
                error_type: 'unknown',
                failure_reason: 'broadcasted row missing tx_hash',
            });
            return;
        }

        // ---------------------------------------------------------------
        // 1.  Try to get the receipt
        // ---------------------------------------------------------------
        let receipt: TransactionReceipt | null = null;
        try {
            receipt = await this.gasService.getTransactionReceipt(txHash, row.chain_id);
        } catch (err) {
            // RPC error when fetching receipt — log and skip, will retry
            // next cycle
            this.logger.warn(
                `PendingMonitor: receipt fetch failed for ${txHash} (signing_request ${row.id}): ${(err as Error).message}`,
            );
            return;
        }

        // ---------------------------------------------------------------
        // 2.  Receipt found → confirmed
        // ---------------------------------------------------------------
        if (receipt) {
            const status = receipt.status;
            if (status === 1) {
                await this.signingRequestRepo.update(row.id, {
                    status: 'confirmed',
                    block_number: receipt.blockNumber as number,
                    gas_used: String(receipt.gasUsed),
                    effective_gas_price: String(receipt.effectiveGasPrice),
                    confirmed_at: new Date(),
                });
                this.logger.log(
                    `PendingMonitor: signing_request ${row.id} CONFIRMED in block ${receipt.blockNumber}`,
                );
            } else {
                // Receipt with status 0 (reverted)
                await this.signingRequestRepo.update(row.id, {
                    status: 'failed',
                    error_type: 'permanent',
                    failure_reason: 'transaction reverted on-chain',
                });
                this.logger.warn(
                    `PendingMonitor: signing_request ${row.id} REVERTED on-chain`,
                );
            }
            return;
        }

        // ---------------------------------------------------------------
        // 3.  No receipt — determine if stuck or still fresh
        // ---------------------------------------------------------------
        const broadcastedAt = row.broadcasted_at ?? row.created_at;
        if (!broadcastedAt) {
            this.logger.error(
                `PendingMonitor: signing_request ${row.id} has no broadcasted_at timestamp`,
            );
            return;
        }

        const ageMinutes =
            (Date.now() - new Date(broadcastedAt).getTime()) / (1000 * 60);

        if (ageMinutes < this.stuckThresholdMinutes) {
            // Still within normal window — skip, check again next cycle
            return;
        }

        // ---------------------------------------------------------------
        // 4.  Age exceeded threshold → check mempool status
        // ---------------------------------------------------------------
        this.logger.warn(
            `PendingMonitor: signing_request ${row.id} age ${ageMinutes.toFixed(1)}min exceeds threshold ${this.stuckThresholdMinutes}min — checking mempool`,
        );

        const txData = await this.gasService.getTransactionByHash(
            txHash,
            row.chain_id,
        );

        if (!txData) {
            // Not found anywhere — dropped
            await this.signingRequestRepo.update(row.id, {
                status: 'dropped',
                failure_reason: 'transaction not found on-chain or in mempool',
            });
            this.logger.warn(
                `PendingMonitor: signing_request ${row.id} DROPPED (tx ${txHash} not found)`,
            );
            return;
        }

        // Still pending in mempool → speed up
        await this.speedUpService.speedUp(row);
    }
}