import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserService } from '@app/users';
import { Scopes, CurrentUser } from '@app/auth';

@ApiTags('users')
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
    @Body() body: { externalId: string; email?: string; role?: string },
  ) {
    return this.userService.createUser(orgId, body);
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List users for organization' })
  @ApiResponse({ status: 200, description: 'Users returned.' })
  async listUsers(@CurrentUser('orgId') orgId: string) {
    return this.userService.listUsers(orgId);
  }

  @Get(':userId')
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
