import { Module } from '@nestjs/common';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { DatabaseModule } from '@app/db';
import { WalletModule } from '@app/wallet';

@Module({
    imports: [DatabaseModule, WalletModule],
    controllers: [OrganisationsController],
    providers: [OrganisationsService],
    exports: [OrganisationsService],
})
export class OrganisationsModule { }
