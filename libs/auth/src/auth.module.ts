import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { AuthService } from './auth.service';
import { StampVerifierGuard } from './stamp-verifier.guard';
import { ScopesGuard } from './scopes.guard';

@Module({
  imports: [DatabaseModule],
  providers: [AuthService, StampVerifierGuard, ScopesGuard],
  exports: [AuthService, StampVerifierGuard, ScopesGuard],
})
export class AuthModule {}
