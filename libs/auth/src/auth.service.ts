import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiKeyRepository, organizationRepository } from '@app/db/repositories';
import { AuditLogRepository } from '@app/db/repositories/audit-log.repository';
import { NewApiKey, ApiKey } from '@app/db/schema/api-keys';
import {
  createHash,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
} from 'crypto';

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

    // Validate the public key is a real P-256 SPKI PEM before storing it —
    // a garbage row can never authenticate and only pollutes the table.
    this.assertP256PublicKey(data.publicKey);

    // Generate key_id
    const keyId = randomUUID();

    // Scope policy: the first (bootstrap) key may default to '*' — the
    // bootstrap token is single-use and equivalent to full org ownership.
    // Any subsequent stamp-authenticated registration must declare explicit
    // scopes; minting additional unrestricted keys would defeat per-key
    // permissions (docs/STAMP_AUTH.md).
    const scopes = data.scopes || ['*'];
    if (requestingKeyId && scopes.includes('*')) {
      throw new BadRequestException(
        'Wildcard scope "*" is only allowed for the first (bootstrap) API key; specify explicit scopes',
      );
    }

    const apiKeyData: NewApiKey = {
      org_id: orgId,
      name: data.name,
      public_key: data.publicKey,
      key_id: keyId,
      scopes,
      status: 'active',
    };

    let apiKey: ApiKey;
    try {
      apiKey = await this.apiKeyRepo.create(apiKeyData);
    } catch (err) {
      // The public_key column is unique — surface a duplicate cleanly
      // instead of leaking a 500 (the DB constraint, not a pre-check,
      // is the race-safe arbiter).
      const pgErr = err as { code?: string } | undefined;
      if (pgErr?.code === '23505') {
        throw new BadRequestException(
          'An API key with the same public key already exists',
        );
      }
      throw err;
    }

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

  /**
   * Resolves an organization ID from a raw bootstrap token by hashing it
   * and looking up the org that stores that hash. Returns undefined if no
   * org matches (invalid or already-consumed token).
   */
  async resolveOrgIdFromBootstrapToken(
    token: string,
  ): Promise<string | undefined> {
    const hash = createHash('sha256').update(token).digest('hex');
    const org = await this.orgRepo.findByBootstrapTokenHash(hash);
    return org?.id;
  }

  async validateBootstrapToken(orgId: string, token: string): Promise<boolean> {
    const org = await this.orgRepo.findById(orgId);
    if (!org || !org.bootstrap_token_hash) {
      throw new BadRequestException(
        'No bootstrap token available for this organization',
      );
    }

    // Constant-time comparison — the token is high-entropy so the practical
    // risk is low, but timing-safe equality is the correct pattern for
    // comparing secrets.
    const providedHash = createHash('sha256').update(token).digest();
    const storedHash = Buffer.from(org.bootstrap_token_hash, 'hex');
    if (
      providedHash.length !== storedHash.length ||
      !timingSafeEqual(providedHash, storedHash)
    ) {
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

  /**
   * Rejects anything that is not an SPKI PEM-encoded P-256 (secp256r1)
   * public key. Mirrors what StampVerifierGuard needs for crypto.verify —
   * a key that fails this check can never produce a valid stamp, so
   * registering it is always a mistake.
   */
  private assertP256PublicKey(pem: string): void {
    try {
      const key = createPublicKey(pem);
      const jwk = key.export({ format: 'jwk' }) as { crv?: string };
      if (key.asymmetricKeyType !== 'ec' || jwk.crv !== 'P-256') {
        throw new BadRequestException(
          'publicKey must be an EC P-256 (secp256r1) SPKI PEM public key',
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        'publicKey must be a valid P-256 (secp256r1) SPKI PEM public key',
      );
    }
  }
}
