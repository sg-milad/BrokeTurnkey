import { Test, TestingModule } from '@nestjs/testing';
import { GasService } from './gas.service';
import { ChainService } from './chain.service';
import { WALLET_NONCE_REPOSITORY } from '@app/db/constants';

describe('GasService', () => {
  let service: GasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GasService,
        { provide: ChainService, useValue: {} },
        { provide: WALLET_NONCE_REPOSITORY, useValue: { reserve: () => 0 } },
      ],
    }).compile();

    service = module.get<GasService>(GasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
