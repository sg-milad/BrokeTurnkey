import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '@app/db';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { WalletModule } from '@app/wallet';
import { WalletsModule } from './wallets/wallets.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MonitorModule } from '@app/monitor';
import {
  ApiKeyThrottlerGuard,
  ScopesGuard,
  StampVerifierGuard,
} from '@app/auth';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }),
    // Per-key / per-IP rate limiting (docs/TASKS.md Phase 8). Default:
    // 120 requests per minute per tracker. Storage is in-memory — use a
    // shared store (Redis) when running more than one API instance.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    WalletModule,
    OrganizationsModule,
    WalletsModule,
    MonitorModule,
  ],
  providers: [
    // Global guards run in registration order. Stamp verification MUST run
    // before the rate limiter: the throttler keys on the *verified* API key
    // (request.user.apiKeyId), so the identity has to be established first.
    // Tracking unverified key_ids from the X-Stamp header would let an
    // attacker rotate fake key_ids to get a fresh bucket per request.
    { provide: APP_GUARD, useClass: StampVerifierGuard },
    { provide: APP_GUARD, useClass: ApiKeyThrottlerGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class ApiModule {}
