import { Test, TestingModule } from '@nestjs/testing';
import { PolicyService } from './policy.service';
import { PolicyRepository, AuditLogRepository } from '@app/db/repositories';

describe('PolicyService', () => {
  let service: PolicyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: PolicyRepository, useValue: {} },
        { provide: AuditLogRepository, useValue: {} },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
