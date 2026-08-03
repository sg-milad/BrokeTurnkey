import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiKeyRepository, organizationRepository } from '@app/db/repositories';
import { AuditLogRepository } from '@app/db/repositories/audit-log.repository';
import { NewApiKey } from '@app/db/schema/api-keys';
import { createHash, randomUUID } from 'crypto';

export interface RegisterApiKeyDto {
  name: string;
  publicKey: string;
  scopes?: string[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepository,
    private readonly orgRepo: organizationRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async registerApiKey(
    orgId: string,
    data: RegisterApiKeyDto,
    bootstrapToken?: string,
    requestingKeyId?: string,
  ) {
    const org = await this.orgRepo.findById(orgId);
    if (!org) throw new NotFoundException(`Organization ${orgId} not found`);

    // Validate authorization
    if (bootstrapToken) {
      await this.validateBootstrapToken(orgId, bootstrapToken);
    } else if (requestingKeyId) {
      const hasWriteScope = await this.apiKeyRepo.hasScope(
        requestingKeyId,
        'key:write',
      );
      if (!hasWriteScope) {
        throw new BadRequestException('API key does not have key:write scope');
      }
    } else {
      throw new BadRequestException(
        'Either bootstrap token or valid API key required',
      );
    }

    // Generate key_id
    const keyId = randomUUID();

    // Create API key
    const apiKeyData: NewApiKey = {
      org_id: orgId,
      name: data.name,
      public_key: data.publicKey,
      key_id: keyId,
      scopes: data.scopes || ['tx:sign'],
      status: 'active',
    };

    const apiKey = await this.apiKeyRepo.create(apiKeyData);

    // Clear bootstrap token if used
    if (bootstrapToken) {
      await this.orgRepo.update(orgId, { bootstrap_token_hash: null });
    }

    // Audit log
    await this.auditLogRepo.create({
      org_id: orgId,
      event: 'api_key_created',
      status: 'success',
      metadata: {
        apiKeyId: apiKey.id,
        keyId: apiKey.key_id,
        name: apiKey.name,
        scopes: apiKey.scopes,
      },
    });

    // Return sensitive data only on creation
    return {
      id: apiKey.id,
      keyId: apiKey.key_id,
      name: apiKey.name,
      publicKey: apiKey.public_key,
      scopes: apiKey.scopes,
      createdAt: apiKey.created_at,
    };
  }

  async listApiKeys(orgId: string) {
    const apiKeys = await this.apiKeyRepo.findByOrgId(orgId, 'active');
    return apiKeys.map((key) => ({
      id: key.id,
      keyId: key.key_id,
      name: key.name,
      scopes: key.scopes,
      lastUsedAt: key.last_used_at,
      expiresAt: key.expires_at,
      createdAt: key.created_at,
    }));
  }

  async revokeApiKey(orgId: string, keyId: string) {
    const apiKey = await this.apiKeyRepo.findByKeyId(keyId);
    if (!apiKey) throw new NotFoundException(`API key ${keyId} not found`);
    if (apiKey.org_id !== orgId) {
      throw new BadRequestException(
        'API key does not belong to this organization',
      );
    }

    await this.apiKeyRepo.update(apiKey.id, {
      status: 'revoked',
      revoked_at: new Date(),
    });

    await this.auditLogRepo.create({
      org_id: orgId,
      event: 'api_key_revoked',
      status: 'success',
      metadata: {
        apiKeyId: apiKey.id,
        keyId: apiKey.key_id,
        name: apiKey.name,
      },
    });

    return { success: true };
  }

  async validateBootstrapToken(orgId: string, token: string): Promise<boolean> {
    const org = await this.orgRepo.findById(orgId);
    if (!org || !org.bootstrap_token_hash) {
      throw new BadRequestException(
        'No bootstrap token available for this organization',
      );
    }

    const providedHash = createHash('sha256').update(token).digest('hex');
    if (providedHash !== org.bootstrap_token_hash) {
      throw new BadRequestException('Invalid bootstrap token');
    }

    return true;
  }

  async generateBootstrapToken(orgId: string): Promise<string> {
    const token = randomUUID();
    const hash = createHash('sha256').update(token).digest('hex');

    await this.orgRepo.update(orgId, { bootstrap_token_hash: hash });

    return token;
  }
}
