import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { GasModule } from '@app/gas';
import { CryptoClientModule } from '@app/crypto-client';
import { TransactionMonitorService } from './transaction-monitor.service';
import { PendingMonitor } from './pending-monitor.service';
import { SpeedUpService } from './speed-up.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [DatabaseModule, GasModule, CryptoClientModule, ConfigModule],
  providers: [TransactionMonitorService, PendingMonitor, SpeedUpService],
  exports: [TransactionMonitorService],
})
export class MonitorModule {}
