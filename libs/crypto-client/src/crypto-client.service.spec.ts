import { Test, TestingModule } from '@nestjs/testing';
import { CryptoClientService } from './crypto-client.service';

describe('CryptoClientService', () => {
  let service: CryptoClientService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CryptoClientService],
    }).compile();

    service = module.get<CryptoClientService>(CryptoClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
