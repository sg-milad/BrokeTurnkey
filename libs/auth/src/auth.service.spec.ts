import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { ApiKeyRepository, organizationRepository } from '@app/db/repositories';
import { AuditLogRepository } from '@app/db/repositories/audit-log.repository';

const sha256Hex = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('AuthService', () => {
  let service: AuthService;
  let apiKeyRepo: jest.Mocked<Pick<
    ApiKeyRepository,
    'create' | 'update' | 'findByKeyId' | 'findByOrgId' | 'hasScope'
  >>;
  let orgRepo: jest.Mocked<
    Pick<organizationRepository, 'findById' | 'findByBootstrapTokenHash' | 'update'>
  >;
  let auditLogRepo: jest.Mocked<Pick<AuditLogRepository, 'create'>>;

  const org = {
    id: 'org-1',
    org_id: 'org-1',
    slug: 'org-1',
    bootstrap_token_hash: sha256Hex('bootstrap-token'),
  };

  const apiKeyRow = {
    id: 1,
    org_id: 'org-1',
    key_id: 'key-1',
    name: 'Test Key',
    public_key: 'PUBLIC_KEY',
    scopes: ['key:write'],
    status: 'active',
    created_at: new Date('2024-01-01T00:00:00Z'),
    last_used_at: null as Date | null,
    expires_at: null as Date | null,
  };

  const registerDto = {
    name: 'Test Key',
    publicKey: 'PUBLIC_KEY',
    scopes: ['key:write'],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: ApiKeyRepository,
          useValue: {
            findById: jest.fn(),
            findByKeyId: jest.fn(),
            findByOrgId: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            hasScope: jest.fn(),
          },
        },
        {
          provide: organizationRepository,
          useValue: {
            findById: jest.fn(),
            findBySlug: jest.fn(),
            findByBootstrapTokenHash: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: AuditLogRepository,
          useValue: {
            create: jest.fn(),
            query: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
    apiKeyRepo = module.get(ApiKeyRepository);
    orgRepo = module.get(organizationRepository);
    auditLogRepo = module.get(AuditLogRepository);
  });

  describe('registerApiKey', () => {
    it('throws NotFoundException when the organization does not exist', async () => {
      orgRepo.findById.mockResolvedValue(undefined);

      await expect(
        service.registerApiKey('missing-org', registerDto),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.registerApiKey('missing-org', registerDto),
      ).rejects.toThrow('Organization missing-org not found');
    });

    it('throws BadRequestException when neither bootstrap token nor API key is provided', async () => {
      orgRepo.findById.mockResolvedValue(org);

      await expect(
        service.registerApiKey('org-1', registerDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerApiKey('org-1', registerDto),
      ).rejects.toThrow('Either bootstrap token or valid API key required');

      expect(apiKeyRepo.create).not.toHaveBeenCalled();
    });

    it('rejects an API key without the key:write scope', async () => {
      orgRepo.findById.mockResolvedValue(org);
      apiKeyRepo.hasScope.mockResolvedValue(false);

      await expect(
        service.registerApiKey('org-1', registerDto, undefined, 'key-1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.registerApiKey('org-1', registerDto, undefined, 'key-1'),
      ).rejects.toThrow('API key does not have key:write scope');

      expect(apiKeyRepo.create).not.toHaveBeenCalled();
    });

    it('creates the API key when the requesting key has key:write scope', async () => {
      orgRepo.findById.mockResolvedValue(org);
      apiKeyRepo.hasScope.mockResolvedValue(true);
      apiKeyRepo.create.mockResolvedValue(apiKeyRow);

      const result = await service.registerApiKey(
        'org-1',
        registerDto,
        undefined,
        'key-1',
      );

      expect(apiKeyRepo.hasScope).toHaveBeenCalledWith('key-1', 'key:write');
      expect(apiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          name: 'Test Key',
          public_key: 'PUBLIC_KEY',
          scopes: ['key:write'],
          status: 'active',
        }),
      );
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          event: 'api_key_created',
          status: 'success',
        }),
      );
      expect(result).toEqual({
        id: 1,
        keyId: 'key-1',
        name: 'Test Key',
        publicKey: 'PUBLIC_KEY',
        scopes: ['key:write'],
        createdAt: apiKeyRow.created_at,
      });
    });

    it('defaults scopes to ["*"] when none are provided', async () => {
      orgRepo.findById.mockResolvedValue(org);
      apiKeyRepo.hasScope.mockResolvedValue(true);
      apiKeyRepo.create.mockImplementation(async (data) => ({
        ...apiKeyRow,
        scopes: data.scopes,
      }));

      await service.registerApiKey(
        'org-1',
        { name: 'Key', publicKey: 'PK' },
        undefined,
        'key-1',
      );

      expect(apiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ['*'] }),
      );
    });

    it('uses a bootstrap token: validates, clears the token hash, and creates the key', async () => {
      orgRepo.findById.mockResolvedValue(org);
      apiKeyRepo.create.mockResolvedValue(apiKeyRow);

      const result = await service.registerApiKey(
        'org-1',
        registerDto,
        'bootstrap-token',
      );

      expect(orgRepo.update).toHaveBeenCalledWith('org-1', {
        bootstrap_token_hash: null,
      });
      expect(apiKeyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: 'org-1' }),
      );
      expect(result.keyId).toBe('key-1');
    });

    it('propagates the rejection when the bootstrap token is invalid', async () => {
      orgRepo.findById.mockResolvedValue(org);

      await expect(
        service.registerApiKey('org-1', registerDto, 'wrong-token'),
      ).rejects.toThrow(BadRequestException);

      expect(apiKeyRepo.create).not.toHaveBeenCalled();
      expect(orgRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('listApiKeys', () => {
    it('returns only active keys and maps fields', async () => {
      const expiredKey = {
        ...apiKeyRow,
        key_id: 'key-2',
      };
      apiKeyRepo.findByOrgId.mockResolvedValue([apiKeyRow, expiredKey]);

      const result = await service.listApiKeys('org-1');

      expect(apiKeyRepo.findByOrgId).toHaveBeenCalledWith('org-1', 'active');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        keyId: 'key-1',
        name: 'Test Key',
        scopes: ['key:write'],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: apiKeyRow.created_at,
      });
    });
  });

  describe('revokeApiKey', () => {
    it('throws NotFoundException when the key does not exist', async () => {
      apiKeyRepo.findByKeyId.mockResolvedValue(undefined);

      await expect(service.revokeApiKey('org-1', 'key-1')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.revokeApiKey('org-1', 'key-1')).rejects.toThrow(
        'API key key-1 not found',
      );
    });

    it('rejects revoking a key that belongs to another organization', async () => {
      apiKeyRepo.findByKeyId.mockResolvedValue({
        ...apiKeyRow,
        org_id: 'org-other',
      });

      await expect(service.revokeApiKey('org-1', 'key-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.revokeApiKey('org-1', 'key-1')).rejects.toThrow(
        'API key does not belong to this organization',
      );
    });

    it('revokes the key and writes the audit log', async () => {
      apiKeyRepo.findByKeyId.mockResolvedValue(apiKeyRow);

      const result = await service.revokeApiKey('org-1', 'key-1');

      expect(result).toEqual({ success: true });
      expect(apiKeyRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'revoked',
          revoked_at: expect.any(Date),
        }),
      );
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          event: 'api_key_revoked',
          status: 'success',
          metadata: { apiKeyId: 1, keyId: 'key-1', name: 'Test Key' },
        }),
      );
    });
  });

  describe('resolveOrgIdFromBootstrapToken', () => {
    it('hashes the token and resolves the org id', async () => {
      orgRepo.findByBootstrapTokenHash.mockResolvedValue(org);

      const result = await service.resolveOrgIdFromBootstrapToken(
        'bootstrap-token',
      );

      expect(orgRepo.findByBootstrapTokenHash).toHaveBeenCalledWith(
        sha256Hex('bootstrap-token'),
      );
      expect(result).toBe('org-1');
    });

    it('returns undefined when no org matches the hash', async () => {
      orgRepo.findByBootstrapTokenHash.mockResolvedValue(undefined);

      await expect(
        service.resolveOrgIdFromBootstrapToken('invalid-token'),
      ).resolves.toBeUndefined();
    });
  });

  describe('validateBootstrapToken', () => {
    it('rejects when the org does not exist or has no stored hash', async () => {
      orgRepo.findById.mockResolvedValue(undefined);

      await expect(
        service.validateBootstrapToken('missing', 'token'),
      ).rejects.toThrow('No bootstrap token available for this organization');

      orgRepo.findById.mockResolvedValue({ ...org, bootstrap_token_hash: null });
      await expect(
        service.validateBootstrapToken('org-1', 'token'),
      ).rejects.toThrow('No bootstrap token available for this organization');
    });

    it('rejects a token of a different length', async () => {
      orgRepo.findById.mockResolvedValue(org);

      await expect(
        service.validateBootstrapToken('org-1', 'x'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.validateBootstrapToken('org-1', 'x'),
      ).rejects.toThrow('Invalid bootstrap token');
    });

    it('rejects a token with the same length but different content', async () => {
      // Same length (37 chars) as 'bootstrap-token', different content.
      orgRepo.findById.mockResolvedValue(org);

      await expect(
        service.validateBootstrapToken('org-1', 'bootstrap-token-other!!'),
      ).rejects.toThrow('Invalid bootstrap token');
    });

    it('accepts the correct token', async () => {
      orgRepo.findById.mockResolvedValue(org);

      await expect(
        service.validateBootstrapToken('org-1', 'bootstrap-token'),
      ).resolves.toBe(true);
    });
  });

  describe('generateBootstrapToken', () => {
    it('returns a token and stores its sha256 hash on the org', async () => {
      orgRepo.update.mockResolvedValue({ ...org, bootstrap_token_hash: 'hash' });

      const token = await service.generateBootstrapToken('org-1');

      expect(orgRepo.update).toHaveBeenCalledWith('org-1', {
        bootstrap_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(orgRepo.update.mock.calls[0][1].bootstrap_token_hash).toBe(
        sha256Hex(token),
      );
      expect(token).toBeDefined();
    });
  });
});