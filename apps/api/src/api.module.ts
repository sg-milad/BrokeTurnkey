import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { DatabaseModule } from '@app/db';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { WalletModule } from '@app/wallet';
import { WalletsModule } from './wallets/wallets.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ApiKeyThrottlerGuard, ScopesGuard } from '@app/auth';

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
  ],
  controllers: [ApiController],
  providers: [
    ApiService,
    // Global guards run in registration order. Rate limiting first (so floods
    // are rejected cheaply), then scope enforcement on top of the per-route
    // StampVerifierGuard which runs after these.
    { provide: APP_GUARD, useClass: ApiKeyThrottlerGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class ApiModule {}
