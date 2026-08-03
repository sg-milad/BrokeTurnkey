import { Test, TestingModule } from '@nestjs/testing';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { WalletService } from '@app/wallet';

describe('ApiController', () => {
  let apiController: ApiController;
  let apiService: ApiService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [ApiService, { provide: WalletService, useValue: {} }],
    }).compile();

    apiController = app.get<ApiController>(ApiController);
    apiService = app.get<ApiService>(ApiService);
  });

  it('should be defined', () => {
    expect(apiController).toBeDefined();
  });

  it('should expose the hello endpoint', () => {
    expect(apiService.getHello()).toBe('Hello World!');
  });
});
