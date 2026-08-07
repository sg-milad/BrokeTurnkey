import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { AuthService } from './auth.service';
import {
  StampVerifierGuard,
  OptionalStampVerifierGuard,
} from './stamp-verifier.guard';
import { ScopesGuard } from './scopes.guard';

@Module({
  imports: [DatabaseModule],
  providers: [
    AuthService,
    StampVerifierGuard,
    OptionalStampVerifierGuard,
    ScopesGuard,
  ],
  exports: [
    AuthService,
    StampVerifierGuard,
    OptionalStampVerifierGuard,
    ScopesGuard,
  ],
})
export class AuthModule {}
