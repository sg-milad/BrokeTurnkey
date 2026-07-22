import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';
import { DRIZZLE_CLIENT } from './constants';
import {
  organizationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
  organizationRepository,
  UserRepository,
} from './repositories';


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
  ],
  exports: [
    DRIZZLE_CLIENT,
    organizationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    organizationRepository,
    UserRepository,
  ],
})
export class DatabaseModule { }
