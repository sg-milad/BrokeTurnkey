import { Controller, Post, Body, Get, Param, HttpCode } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { type organization } from '@app/db/schema/organizations';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationDto } from './dto/organization.dto';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

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
    return this.organizationsService.onboard(id);
  }
}
