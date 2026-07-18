import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { DatabaseModule } from '@app/db';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { WalletModule } from '@app/wallet';
import { OrganisationsModule } from './organisations/organisations.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }), DatabaseModule, WalletModule, OrganisationsModule, WalletsModule],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule { }
