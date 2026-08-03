import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { type organization } from '@app/db/schema/organizations';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationDto } from './dto/organization.dto';
import { StampVerifierGuard } from '@app/auth';
import { AuditLogRepository } from '@app/db/repositories';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create an organization' })
  @ApiResponse({
    status: 201,
    description: 'The organization has been successfully created.',
    type: OrganizationDto,
  })
  async create(
    @Body() createOrganizationDto: CreateOrganizationDto,
  ): Promise<organization> {
    return this.organizationsService.create(createOrganizationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an organization by id' })
  @ApiResponse({
    status: 200,
    description: 'The organization has been found.',
    type: OrganizationDto,
  })
  async findOne(@Param('id') id: string): Promise<organization | undefined> {
    return this.organizationsService.findOne(id);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get an organization by slug' })
  @ApiResponse({
    status: 200,
    description: 'The organization has been found.',
    type: OrganizationDto,
  })
  async findBySlug(
    @Param('slug') slug: string,
  ): Promise<organization | undefined> {
    return this.organizationsService.findBySlug(slug);
  }

  @Get(':id/wallets')
  @HttpCode(200)
  @ApiOperation({ summary: 'List wallets by organization id' })
  @ApiResponse({ status: 200, description: 'Wallets returned.' })
  async listWallets(@Param('id') id: string) {
    return this.organizationsService.listWalletsByOrgId(id);
  }

  @Get(':id/signing-requests')
  @HttpCode(200)
  @ApiOperation({ summary: 'List signing requests by organization id' })
  @ApiResponse({ status: 200, description: 'Signing requests returned.' })
  async listSigningRequests(@Param('id') id: string) {
    return this.organizationsService.listSigningRequestsByOrgId(id);
  }

  @Post(':id/onboard')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Onboard an organization (create seed + first wallet)',
  })
  @ApiResponse({
    status: 200,
    description: 'organization onboarded successfully.',
  })
  async onboard(@Param('id') id: string) {
    const result = await this.organizationsService.onboard(id);
    const bootstrapToken =
      await this.organizationsService.generateBootstrapToken(id);
    return { ...result, bootstrapToken };
  }

  @Get(':id/audit-log')
  @UseGuards(StampVerifierGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Query audit log for organization' })
  @ApiResponse({ status: 200, description: 'Audit log entries returned.' })
  async queryAuditLog(
    @Param('id') orgId: string,
    @Query('event') event?: string,
    @Query('userId') userId?: string,
    @Query('walletId') walletId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.auditLogRepo.query({
      orgId,
      event,
      userId,
      walletId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }
}
