import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { WalletModule } from '@app/wallet';
import { AuthModule } from '@app/auth';
import { PolicyModule } from '@app/policy';
import { UsersModule } from '@app/users';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { ApiKeysController } from './api-keys.controller';
import { PoliciesController } from './policies.controller';
import { UsersController } from './users.controller';

@Module({
  imports: [
    DatabaseModule,
    WalletModule,
    AuthModule,
    PolicyModule,
    UsersModule,
  ],
  controllers: [
    OrganizationsController,
    ApiKeysController,
    PoliciesController,
    UsersController,
  ],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
