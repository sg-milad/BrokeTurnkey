import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SigningRequestRepository } from '@app/db/repositories/signing-request.repository';
import { GasService } from '@app/gas';
import { PendingMonitor } from './pending-monitor.service';
import { SpeedUpService } from './speed-up.service';

/**
 * The entry point for the async transaction lifecycle monitor.
 *
 * Uses `@nestjs/schedule` cron to periodically poll the `signing_requests`
 * table for `broadcasted` rows and drive them through the confirmation
 * pipeline.  The schedule is configured via environment variables — see
 * `PENDING_POLL_INTERVAL_SECONDS`.
 *
 * All business logic lives in `PendingMonitor` and `SpeedUpService`;
 * this class only owns the cron trigger and logging.
 */
@Injectable()
export class TransactionMonitorService implements OnModuleInit {
  private readonly logger = new Logger(TransactionMonitorService.name);
  private readonly pollIntervalSeconds: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pendingMonitor: PendingMonitor,
    config: ConfigService,
  ) {
    this.pollIntervalSeconds = Number(
      config.get('PENDING_POLL_INTERVAL_SECONDS', '15'),
    );
  }

  onModuleInit() {
    this.logger.log(
      `TransactionMonitorService: starting poller every ${this.pollIntervalSeconds}s`,
    );
    // Run the first poll shortly after boot so recently-broadcasted
    // rows are picked up quickly, then on the regular interval.
    this.timer = setInterval(
      () => this.runPoll(),
      this.pollIntervalSeconds * 1000,
    );
  }

  /**
   * Manually trigger a single poll cycle.  Useful for tests and admin
   * endpoints.
   */
  async triggerPoll(): Promise<void> {
    await this.runPoll();
  }

  private async runPoll(): Promise<void> {
    try {
      await this.pendingMonitor.poll();
    } catch (err) {
      this.logger.error(
        `TransactionMonitorService: unhandled error in poll cycle: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
