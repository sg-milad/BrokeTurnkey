import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';
import { DRIZZLE_CLIENT } from './constants';
import {
  OrganisationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
  OrganisationRepository,
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
    OrganisationRepository
  ],
  exports: [
    DRIZZLE_CLIENT,
    OrganisationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    OrganisationRepository
  ],
})
export class DatabaseModule { }
