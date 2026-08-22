import { Injectable, ConflictException } from '@nestjs/common';
import { organizationRepository } from '@app/db/repositories/organization.repository';
import { organization } from '@app/db/schema/organizations';
import { WalletService } from '@app/wallet';
import { AuthService } from '@app/auth';
import { CreateOrganizationDto } from './dto/create-organization.dto';

/** Public org shape — internal columns (bootstrap_token_hash) never leave the API. */
export type PublicOrganization = Omit<organization, 'bootstrap_token_hash'>;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationRepository: organizationRepository,
    private readonly walletService: WalletService,
    private readonly authService: AuthService,
  ) {}

  async create(
    createOrganizationDto: CreateOrganizationDto,
  ): Promise<
    PublicOrganization & { bootstrapToken: string; walletAddress: string }
  > {
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
    const wallet = await this.walletService.onBoardOrganization(org.id);
    const bootstrapToken = await this.authService.generateBootstrapToken(
      org.id,
    );

    return {
      ...this.toPublicOrg(org),
      bootstrapToken,
      walletAddress: wallet.firstAddress,
    };
  }

  async findOne(id: string): Promise<PublicOrganization | undefined> {
    const org = await this.organizationRepository.findById(id);
    return org ? this.toPublicOrg(org) : undefined;
  }

  async findBySlug(slug: string): Promise<PublicOrganization | undefined> {
    const org = await this.organizationRepository.findBySlug(slug);
    return org ? this.toPublicOrg(org) : undefined;
  }

  async listWalletsByOrgId(id: string) {
    return this.walletService.listWalletsByOrgId(id);
  }

  async listSigningRequestsByOrgId(id: string) {
    return this.walletService.listSigningRequestsByOrgId(id);
  }

  /**
   * Drops internal columns before an org row crosses the API boundary.
   * bootstrap_token_hash is internal state — leaking it reveals whether the
   * bootstrap window is still open and gives an offline hash to attack.
   * Keep this list in sync with the schema: new public columns must be
   * added here, new internal columns must be omitted.
   */
  private toPublicOrg(org: organization): PublicOrganization {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      plan: org.plan,
      created_at: org.created_at,
      updated_at: org.updated_at,
    };
  }
}
