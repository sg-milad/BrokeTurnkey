import { Controller, Post, Body, Get, Param, HttpCode } from '@nestjs/common';
import { OrganisationsService } from './organisations.service';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { type Organisation } from '@app/db/schema/organisations';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { OrganisationDto } from './dto/organisation.dto';

@ApiTags('organisations')
@Controller('organisations')
export class OrganisationsController {
    constructor(private readonly organisationsService: OrganisationsService) { }

    @Post()
    @ApiOperation({ summary: 'Create an organisation' })
    @ApiResponse({ status: 201, description: 'The organisation has been successfully created.', type: OrganisationDto })
    async create(@Body() createOrganisationDto: CreateOrganisationDto): Promise<Organisation> {
        return this.organisationsService.create(createOrganisationDto);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get an organisation by id' })
    @ApiResponse({ status: 200, description: 'The organisation has been found.', type: OrganisationDto })
    async findOne(@Param('id') id: string): Promise<Organisation | undefined> {
        return this.organisationsService.findOne(id);
    }

    @Get('slug/:slug')
    @ApiOperation({ summary: 'Get an organisation by slug' })
    @ApiResponse({ status: 200, description: 'The organisation has been found.', type: OrganisationDto })
    async findBySlug(@Param('slug') slug: string): Promise<Organisation | undefined> {
        return this.organisationsService.findBySlug(slug);
    }

    @Post(':id/onboard')
    @HttpCode(200)
    @ApiOperation({ summary: 'Onboard an organisation (create seed + first wallet)' })
    @ApiResponse({ status: 200, description: 'Organisation onboarded successfully.' })
    async onboard(@Param('id') id: string) {
        return this.organisationsService.onboard(id);
    }
}
