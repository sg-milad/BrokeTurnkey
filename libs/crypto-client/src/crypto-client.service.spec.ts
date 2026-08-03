import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CryptoClientService } from './crypto-client.service';

describe('CryptoClientService', () => {
  let service: CryptoClientService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CryptoClientService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => 'http://crypto:4000',
          },
        },
      ],
    }).compile();

    service = module.get<CryptoClientService>(CryptoClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
