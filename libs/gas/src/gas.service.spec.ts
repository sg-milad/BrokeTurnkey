import { Test, TestingModule } from '@nestjs/testing';
import { GasService } from './gas.service';

describe('GasService', () => {
  let service: GasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GasService],
    }).compile();

    service = module.get<GasService>(GasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
