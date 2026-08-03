import { Module } from '@nestjs/common';
import { CryptoClientModule } from '@app/crypto-client';
import { DatabaseModule } from '@app/db';
import { WalletService } from './wallet.service';
import { SigningService } from './signing.service';
import { GasModule } from '@app/gas';

@Module({
  imports: [CryptoClientModule, DatabaseModule, GasModule],
  providers: [WalletService, SigningService],
  exports: [WalletService, SigningService],
})
export class WalletModule {}
