import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CryptoClientService } from './crypto-client.service';
import { TxFields } from './interfaces/crypto-client.interfaces';

const txFields: TxFields = {
  chainId: 1,
  nonce: 7,
  to: '0x1111111111111111111111111111111111111111',
  value: '1000000000000000000',
  gasLimit: 21000,
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  data: '0x',
};

describe('CryptoClientService', () => {
  let service: CryptoClientService;
  const mockFetch = jest.fn();

  const config = { getOrThrow: jest.fn() };

  beforeEach(async () => {
    jest.restoreAllMocks();
    mockFetch.mockReset();

    global.fetch = mockFetch as unknown as typeof fetch;

    config.getOrThrow.mockImplementation((key: string) => {
      if (key === 'CRYPTO_SERVICE_URL') return 'http://crypto:8080';
      if (key === 'CRYPTO_AUTH_TOKEN') return 'secret-token';
      throw new Error(`missing config ${key}`);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CryptoClientService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<CryptoClientService>(CryptoClientService);
    service.onModuleInit();
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('reads base URL and auth token on init', () => {
    expect(config.getOrThrow).toHaveBeenCalledWith('CRYPTO_SERVICE_URL');
    expect(config.getOrThrow).toHaveBeenCalledWith('CRYPTO_AUTH_TOKEN');
  });

  describe('createWallet', () => {
    it('POSTs /wallet/create with empty body and returns JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          encryptedSeed: 'seed',
          seedNonce: 'nonce',
          encryptedDek: 'dek',
          firstAddress: '0xabc',
        }),
      });

      const result = await service.createWallet();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://crypto:8080/wallet/create',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Crypto-Token': 'secret-token',
          },
          body: JSON.stringify({}),
        }),
      );
      expect(result.firstAddress).toBe('0xabc');
      expect(result.encryptedSeed).toBe('seed');
    });
  });

  describe('deriveWallet', () => {
    it('POSTs /wallet/derive with seed material and index', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ address: '0xdef', derivationPath: "m/44'/60'/0'/0/1" }),
      });

      const result = await service.deriveWallet('enc-seed', 'nonce-1', 'enc-dek', 1);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://crypto:8080/wallet/derive',
        expect.objectContaining({
          body: JSON.stringify({
            encryptedSeed: 'enc-seed',
            seedNonce: 'nonce-1',
            encryptedDek: 'enc-dek',
            derivIndex: 1,
          }),
        }),
      );
      expect(result.address).toBe('0xdef');
      expect(result.derivationPath).toBe("m/44'/60'/0'/0/1");
    });
  });

  describe('signTransaction', () => {
    it('POSTs /wallet/sign-transaction with tx fields', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ rawTx: '0xraw', txHash: '0xhash', signature: '0xsig' }),
      });

      const result = await service.signTransaction(
        'enc-seed',
        'nonce-1',
        'enc-dek',
        "m/44'/60'/0'/0/0",
        txFields,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'http://crypto:8080/wallet/sign-transaction',
        expect.objectContaining({
          body: JSON.stringify({
            encryptedSeed: 'enc-seed',
            seedNonce: 'nonce-1',
            encryptedDek: 'enc-dek',
            derivationPath: "m/44'/60'/0'/0/0",
            txFields,
          }),
        }),
      );
      expect(result.txHash).toBe('0xhash');
      expect(result.signature).toBe('0xsig');
      expect(result.rawTx).toBe('0xraw');
    });
  });

  describe('signHash', () => {
    it('POSTs /wallet/sign-hash with hash hex', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ signature: '0xsig' }),
      });

      const result = await service.signHash(
        'enc-seed',
        'nonce-1',
        'enc-dek',
        "m/44'/60'/0'/0/0",
        '0xdeadbeef',
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'http://crypto:8080/wallet/sign-hash',
        expect.objectContaining({
          body: JSON.stringify({
            encryptedSeed: 'enc-seed',
            seedNonce: 'nonce-1',
            encryptedDek: 'enc-dek',
            derivationPath: "m/44'/60'/0'/0/0",
            hashHex: '0xdeadbeef',
          }),
        }),
      );
      expect(result.signature).toBe('0xsig');
    });
  });

  describe('error handling', () => {
    it('throws a descriptive error when the crypto service returns non-2xx', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'internal error',
      });

      await expect(service.createWallet()).rejects.toThrow(
        'Crypto service /wallet/create failed [500]: internal error',
      );
    });

    it('throws a descriptive error when response body cannot be read', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error('stream broken');
        },
      });

      await expect(service.createWallet()).rejects.toThrow(
        'Crypto service /wallet/create failed [503]: (no body)',
      );
    });

    it('propagates network failures', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.deriveWallet('s', 'n', 'd', 0)).rejects.toThrow('ECONNREFUSED');
    });
  });
});