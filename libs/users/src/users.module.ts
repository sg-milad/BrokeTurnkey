import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { UserService } from './user.service';

@Module({
  imports: [DatabaseModule],
  providers: [UserService],
  exports: [UserService],
})
export class UsersModule {}
