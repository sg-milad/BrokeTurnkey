import { Injectable, ConflictException } from '@nestjs/common';
import { organizationRepository } from '@app/db/repositories/organization.repository';
import { organization } from '@app/db/schema/organizations';
import { WalletService } from '@app/wallet';
import { AuthService } from '@app/auth';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationRepository: organizationRepository,
    private readonly walletService: WalletService,
    private readonly authService: AuthService,
  ) { }

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
    const org = await this.organizationRepository.create(createOrganizationDto);

    // Auto-onboard: create seed + first wallet, then generate bootstrap token
    await this.walletService.onBoardOrganization(org.id);
    const bootstrapToken =
      await this.authService.generateBootstrapToken(org.id);

    return { ...org, bootstrapToken } as organization & { bootstrapToken: string };
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
}
