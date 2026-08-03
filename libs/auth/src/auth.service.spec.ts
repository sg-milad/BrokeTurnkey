import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { ApiKeyRepository, organizationRepository } from '@app/db/repositories';
import { AuditLogRepository } from '@app/db/repositories/audit-log.repository';

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: ApiKeyRepository,
          useValue: {
            findById: () => undefined,
            findByKeyId: () => undefined,
            findByOrgId: () => [],
            create: () => undefined,
            update: () => undefined,
            delete: () => false,
            hasScope: () => false,
          },
        },
        {
          provide: organizationRepository,
          useValue: {
            findById: () => undefined,
            findBySlug: () => undefined,
            create: () => undefined,
            update: () => undefined,
          },
        },
        {
          provide: AuditLogRepository,
          useValue: {
            create: () => undefined,
            query: () => [],
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
