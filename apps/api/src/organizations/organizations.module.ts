import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/db';
import { WalletModule } from '@app/wallet';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';

@Module({
    imports: [DatabaseModule, WalletModule],
    controllers: [OrganizationsController],
    providers: [OrganizationsService],
    exports: [OrganizationsService],
})
export class OrganizationsModule { }
