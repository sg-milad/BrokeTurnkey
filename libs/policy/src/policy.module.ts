import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { PolicyService } from './policy.service';

@Module({
  imports: [DatabaseModule],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
