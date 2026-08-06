import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiHeader,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import {
  AuthService,
  Public,
  Scopes,
  CurrentUser,
  OptionalStampVerifierGuard,
  type AuthUser,
} from '@app/auth';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiTags('api-keys')
@ApiHeader({
  name: 'X-Stamp',
  required: true,
  description:
    'Stamp authentication header: <base64url(DER-encoded ES256 signature)>.<timestamp_ms>.<key_id> ' +
    'signing SHA-256 of `<timestamp_ms>.<base64url(SHA-256(raw body))>`. See docs/STAMP_AUTH.md.',
})
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly authService: AuthService) { }

  @Post()
  @Public()
  @UseGuards(OptionalStampVerifierGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register a new API key',
    description:
      'Registers a new API key for the organization. Authenticate with either ' +
      'a valid stamp (key must have key:write scope) or the one-time ' +
      'X-Bootstrap-Token header returned by POST /organizations. ' +
      'Scopes default to ["*"] when omitted.',
  })
  @ApiResponse({
    status: 201,
    description: 'API key created. Returns the keyId and raw publicKey.',
  })
  @ApiBadRequestResponse({
    description:
      'Invalid payload, missing bootstrap token/API key authorization, or API key lacks key:write scope.',
  })
  @ApiNotFoundResponse({ description: 'Organization not found.' })
  async registerApiKey(
    @Body() body: CreateApiKeyDto,
    @Req() request: Record<string, any>,
    @CurrentUser() user: AuthUser,
  ) {
    const headers = request.headers as Record<string, string>;
    const bootstrapToken = headers['x-bootstrap-token'] || undefined;
    const requestingKeyId = user?.apiKeyId || undefined;

    return this.authService.registerApiKey(
      user.orgId,
      body,
      bootstrapToken,
      requestingKeyId,
    );
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List API keys for organization' })
  @ApiResponse({
    status: 200,
    description: 'Active API keys returned.',
  })
  @ApiNotFoundResponse({ description: 'Organization not found.' })
  async listApiKeys(@CurrentUser('orgId') orgId: string) {
    return this.authService.listApiKeys(orgId);
  }

  @Delete(':keyId')
  @Scopes('key:write')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke an API key',
    description:
      'Revokes an API key so it can no longer be used for authentication.',
  })
  @ApiParam({
    name: 'keyId',
    description: 'Key ID of the API key to revoke',
    example: 'a3f5c9a8-7d4b-4f6e-9b2c-1e8d6a4f0c33',
  })
  @ApiResponse({ status: 200, description: 'API key revoked.' })
  @ApiBadRequestResponse({
    description: 'API key does not belong to this organization.',
  })
  @ApiNotFoundResponse({ description: 'API key not found.' })
  async revokeApiKey(
    @CurrentUser('orgId') orgId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.authService.revokeApiKey(orgId, keyId);
  }
}
