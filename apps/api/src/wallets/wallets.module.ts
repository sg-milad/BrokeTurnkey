import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller';
import { WalletModule } from '@app/wallet';

@Module({
  imports: [WalletModule],
  controllers: [WalletsController],
})
export class WalletsModule {}
