import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { AuthService } from './auth.service';
import { StampVerifierGuard } from './stamp-verifier.guard';

@Module({
  imports: [DatabaseModule],
  providers: [AuthService, StampVerifierGuard],
  exports: [AuthService, StampVerifierGuard],
})
export class AuthModule {}
