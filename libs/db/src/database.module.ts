import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';
import { DRIZZLE_CLIENT, WALLET_NONCE_REPOSITORY } from './constants';
import {
  organizationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
  organizationRepository,
  UserRepository,
  WalletNonceRepository,
} from './repositories';

const walletNonceRepositoryProvider = {
  provide: WALLET_NONCE_REPOSITORY,
  useClass: WalletNonceRepository,
};


@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DrizzleClient => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        return createDrizzleClient(url);
      },
    },
    organizationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    organizationRepository,
    UserRepository,
    WalletNonceRepository,
    walletNonceRepositoryProvider,
  ],
  exports: [
    DRIZZLE_CLIENT,
    organizationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    organizationRepository,
    UserRepository,
    WalletNonceRepository,
    WALLET_NONCE_REPOSITORY,
  ],
})
export class DatabaseModule { }
