import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';
import { DRIZZLE_CLIENT } from './constants';
import {
  OrganisationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
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
    OrganisationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
  ],
  exports: [
    DRIZZLE_CLIENT,
    OrganisationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
  ],
})
export class DatabaseModule { }
