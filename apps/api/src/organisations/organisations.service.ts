import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { OrganisationRepository } from '@app/db/repositories/organisation.repository';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { Organisation } from '@app/db/schema/organisations';
import { WalletService } from '@app/wallet';

@Injectable()
export class OrganisationsService {
    constructor(
        private readonly organisationRepository: OrganisationRepository,
        private readonly walletService: WalletService,
    ) { }

    async create(createOrganisationDto: CreateOrganisationDto): Promise<Organisation> {
        return this.organisationRepository.create(createOrganisationDto);
    }

    async findOne(id: string): Promise<Organisation | undefined> {
        return this.organisationRepository.findById(id);
    }

    async findBySlug(slug: string): Promise<Organisation | undefined> {
        return this.organisationRepository.findBySlug(slug);
    }

    async onboard(id: string) {
        return this.walletService.onboardOrganisation(id);
    }
}
