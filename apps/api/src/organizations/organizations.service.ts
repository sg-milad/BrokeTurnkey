import { Injectable, ConflictException } from '@nestjs/common';
import { organizationRepository } from '@app/db/repositories/organization.repository';
import { organization } from '@app/db/schema/organizations';
import { WalletService } from '@app/wallet';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationRepository: organizationRepository,
    private readonly walletService: WalletService,
  ) {}

  async create(
    createOrganizationDto: CreateOrganizationDto,
  ): Promise<organization> {
    const existing = await this.organizationRepository.findBySlug(
      createOrganizationDto.slug,
    );
    if (existing) {
      throw new ConflictException(
        `organization with slug "${createOrganizationDto.slug}" already exists`,
      );
    }
    return this.organizationRepository.create(createOrganizationDto);
  }

  async findOne(id: string): Promise<organization | undefined> {
    return this.organizationRepository.findById(id);
  }

  async findBySlug(slug: string): Promise<organization | undefined> {
    return this.organizationRepository.findBySlug(slug);
  }

  async listWalletsByOrgId(id: string) {
    return this.walletService.listWalletsByOrgId(id);
  }

  async listSigningRequestsByOrgId(id: string) {
    return this.walletService.listSigningRequestsByOrgId(id);
  }

  async onboard(id: string) {
    return this.walletService.onBoardOrganization(id);
  }
}
