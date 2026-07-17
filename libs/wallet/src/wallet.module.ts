import { Module } from '@nestjs/common';
import { CryptoClientModule } from '@app/crypto-client';
import { DatabaseModule } from '@app/db';
import { WalletService } from './wallet.service';

@Module({
  imports: [CryptoClientModule, DatabaseModule],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule { }
