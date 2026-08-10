import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { UserService } from '@app/users';
import { Scopes, CurrentUser } from '@app/auth';
import { CreateUserDto } from './dto/create-user.dto';

@ApiTags('users')
@ApiHeader({
  name: 'X-Stamp',
  required: true,
  description:
    'Stamp authentication header: <base64url(DER-encoded ES256 signature)>.<timestamp_ms>.<key_id> ' +
    'signing SHA-256 of `<timestamp_ms>.<base64url(SHA-256(raw body))>`. See docs/STAMP_AUTH.md.',
})
@Controller('users')
export class UsersController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @Scopes('key:write')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a user' })
  @ApiResponse({ status: 201, description: 'User created.' })
  async createUser(
    @CurrentUser('orgId') orgId: string,
    @Body() body: CreateUserDto,
  ) {
    return this.userService.createUser(orgId, body);
  }

  @Get()
  @Scopes('wallet:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'List users for organization' })
  @ApiResponse({ status: 200, description: 'Users returned.' })
  async listUsers(@CurrentUser('orgId') orgId: string) {
    return this.userService.listUsers(orgId);
  }

  @Get(':userId')
  @Scopes('wallet:read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a user by ID' })
  @ApiResponse({ status: 200, description: 'User returned.' })
  async getUser(
    @CurrentUser('orgId') orgId: string,
    @Param('userId') userId: string,
  ) {
    return this.userService.getUser(orgId, userId);
  }

  @Delete(':userId')
  @Scopes('key:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a user' })
  @ApiResponse({ status: 200, description: 'User deleted.' })
  async deleteUser(
    @CurrentUser('orgId') orgId: string,
    @Param('userId') userId: string,
  ) {
    return this.userService.deleteUser(orgId, userId);
  }
}
