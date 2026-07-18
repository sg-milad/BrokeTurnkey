import { Module } from '@nestjs/common';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { DatabaseModule } from '@app/db';

@Module({
    imports: [DatabaseModule],
    controllers: [OrganisationsController],
    providers: [OrganisationsService],
    exports: [OrganisationsService],
})
export class OrganisationsModule { }