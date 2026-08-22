import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import {
  OrganizationsService,
  PublicOrganization,
} from './organizations.service';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationDto } from './dto/organization.dto';
import { Public, CurrentUser, Scopes } from '@app/auth';
import { AuditLogRepository } from '@app/db/repositories';

@ApiTags('organizations')
@ApiHeader({
  name: 'X-Stamp',
  required: true,
  description:
    'Stamp authentication header: <base64url(DER-encoded ES256 signature)>.<timestamp_ms>.<key_id> ' +
    'signing SHA-256 of `<timestamp_ms>.<base64url(SHA-256(raw body))>`. See docs/STAMP_AUTH.md.',
})
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  @Post()
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create and onboard an organization',
    description:
      'Creates a new organization, generates its HD wallet seed, derives ' +
      'the first signing wallet, and returns a bootstrap token for API key ' +
      'creation.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Organization created and onboarded successfully. Returns the ' +
      'organization object plus a bootstrapToken.',
  })
  async create(@Body() createOrganizationDto: CreateOrganizationDto) {
    return this.organizationsService.create(createOrganizationDto);
  }

  @Get()
  @Scopes('wallet:read')
  @ApiOperation({ summary: 'Get current organization' })
  @ApiResponse({
    status: 200,
    description: 'The organization has been found.',
    type: OrganizationDto,
  })
  async findOne(
    @CurrentUser('orgId') orgId: string,
  ): Promise<PublicOrganization | undefined> {
    return this.organizationsService.findOne(orgId);
  }

  @Get('slug/:slug')
  @Scopes('wallet:read')
  @ApiOperation({ summary: 'Get an organization by slug' })
  @ApiResponse({
    status: 200,
    description: 'The organization has been found.',
    type: OrganizationDto,
  })
  async findBySlug(
    @CurrentUser('orgId') orgId: string,
    @Param('slug') slug: string,
  ): Promise<PublicOrganization | undefined> {
    // Scope lookup to the caller's own organization to prevent cross-tenant
    // data leakage. The slug must belong to the authenticated org.
    const org = await this.organizationsService.findBySlug(slug);
    if (!org || org.id !== orgId) {
      return undefined;
    }
    return org;
  }

  @Get('wallets')
  @Scopes('wallet:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'List wallets for current organization' })
  @ApiResponse({ status: 200, description: 'Wallets returned.' })
  async listWallets(@CurrentUser('orgId') orgId: string) {
    return this.organizationsService.listWalletsByOrgId(orgId);
  }

  @Get('signing-requests')
  @Scopes('wallet:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'List signing requests for current organization' })
  @ApiResponse({ status: 200, description: 'Signing requests returned.' })
  async listSigningRequests(@CurrentUser('orgId') orgId: string) {
    return this.organizationsService.listSigningRequestsByOrgId(orgId);
  }

  @Get('audit-log')
  @Scopes('wallet:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Query audit log for current organization' })
  @ApiResponse({ status: 200, description: 'Audit log entries returned.' })
  async queryAuditLog(
    @CurrentUser('orgId') orgId: string,
    @Query('event') event?: string,
    @Query('userId') userId?: string,
    @Query('walletId') walletId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const entries = await this.auditLogRepo.query({
      orgId,
      event,
      userId,
      walletId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    return entries.map(({ id, ...entry }) => ({ ...entry, id: id.toString() }));
  }
}
