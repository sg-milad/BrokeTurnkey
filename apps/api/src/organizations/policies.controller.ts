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
import { PolicyService } from '@app/policy';
import { Scopes } from '@app/auth';

@ApiTags('policies')
@Controller('organizations/:id/policies')
export class PoliciesController {
  constructor(private readonly policyService: PolicyService) {}

  @Post()
  @Scopes('policy:write')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a policy' })
  @ApiResponse({ status: 201, description: 'Policy created.' })
  async createPolicy(
    @Param('id') orgId: string,
    @Body()
    body: {
      name: string;
      description?: string;
      ruleType: string;
      ruleConfig: Record<string, unknown>;
      appliesTo?: string;
      targetId?: string;
      priority?: number;
    },
  ) {
    return this.policyService.createPolicy(orgId, {
      name: body.name,
      description: body.description ?? null,
      rule_type: body.ruleType,
      rule_config: body.ruleConfig,
      applies_to: body.appliesTo ?? 'all',
      target_id: body.targetId ?? null,
      priority: body.priority ?? 0,
      status: 'active',
    });
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List policies for organization' })
  @ApiResponse({ status: 200, description: 'Policies returned.' })
  async listPolicies(@Param('id') orgId: string) {
    return this.policyService.listPolicies(orgId);
  }

  @Delete(':policyId')
  @Scopes('policy:write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a policy' })
  @ApiResponse({ status: 200, description: 'Policy deleted.' })
  async deletePolicy(
    @Param('id') orgId: string,
    @Param('policyId') policyId: string,
  ) {
    return this.policyService.deletePolicy(orgId, policyId);
  }
}
