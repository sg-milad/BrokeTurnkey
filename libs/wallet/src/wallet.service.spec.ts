import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { CryptoClientService } from '@app/crypto-client';
import { GasService } from '@app/gas';
import { PolicyService } from '@app/policy';
import {
  organizationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
  UserRepository,
} from '@app/db/repositories';

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: CryptoClientService, useValue: {} },
        { provide: GasService, useValue: {} },
        { provide: PolicyService, useValue: {} },
        { provide: organizationSeedRepository, useValue: {} },
        { provide: WalletRepository, useValue: {} },
        { provide: SigningRequestRepository, useValue: {} },
        { provide: AuditLogRepository, useValue: {} },
        { provide: UserRepository, useValue: {} },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
