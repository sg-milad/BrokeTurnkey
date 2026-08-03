import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Headers,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from '@app/auth';
import { StampVerifierGuard } from '@app/auth';
import { Scopes } from '@app/auth';

@ApiTags('api-keys')
@Controller('organizations/:id/api-keys')
export class ApiKeysController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @UseGuards(StampVerifierGuard)
  @Scopes('key:write')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register a new API key' })
  @ApiResponse({ status: 201, description: 'API key created.' })
  async registerApiKey(
    @Param('id') orgId: string,
    @Body() body: { name: string; publicKey: string; scopes?: string[] },
  ) {
    const requestingKeyId = undefined; // Guard attaches context; for now use bootstrap flow
    return this.authService.registerApiKey(
      orgId,
      body,
      undefined,
      requestingKeyId,
    );
  }

  @Get()
  @UseGuards(StampVerifierGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'List API keys for organization' })
  @ApiResponse({ status: 200, description: 'API keys returned.' })
  async listApiKeys(@Param('id') orgId: string) {
    return this.authService.listApiKeys(orgId);
  }

  @Delete(':keyId')
  @UseGuards(StampVerifierGuard)
  @Scopes('key:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 200, description: 'API key revoked.' })
  async revokeApiKey(
    @Param('id') orgId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.authService.revokeApiKey(orgId, keyId);
  }
}
