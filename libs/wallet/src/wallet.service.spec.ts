import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException, HttpException } from '@nestjs/common';
import { WalletService, SignRequest } from './wallet.service';
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

const seedRow = {
  id: 'seed-1',
  org_id: 'org-1',
  encrypted_seed: 'enc-seed',
  seed_nonce: 'nonce-1',
  encrypted_dek: 'enc-dek',
  created_at: new Date('2024-01-01T00:00:00Z'),
};

const wallet = {
  id: 'wallet-1',
  org_id: 'org-1',
  user_id: null,
  label: 'Main',
  address: '0x1234567890123456789012345678901234567890',
  derivation_path: "m/44'/60'/0'/0/0",
  chain_id: 1,
  status: 'active',
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
};

const signReq: SignRequest = {
  chainId: 1,
  to: '0x2222222222222222222222222222222222222222',
  value: '1000000000000000000',
  data: '0x',
};

const signedRequest = {
  id: 'req-1',
  org_id: 'org-1',
  wallet_id: 'wallet-1',
  chain_id: 1,
  tx_hash: '0xhash',
  tx_payload: { nonce: 7, chainId: 1, to: '0xto', value: '1', gasLimit: 21000, maxFeePerGas: '2', maxPriorityFeePerGas: '1', data: '0x' },
  signature: '0xsig',
  status: 'signed',
  failure_reason: null,
  error_type: null,
  policy_result: null,
  block_number: null,
  gas_used: null,
  effective_gas_price: null,
  idempotency_key: 'key-1',
  created_at: new Date('2024-01-01T00:00:00Z'),
  signed_at: new Date('2024-01-01T00:00:00Z'),
  broadcasted_at: null,
  confirmed_at: null,
};

describe('WalletService', () => {
  let service: WalletService;
  let cryptoClient: jest.Mocked<Pick<CryptoClientService, 'createWallet' | 'deriveWallet' | 'signTransaction'>>;
  let gasService: jest.Mocked<{
    estimateFees: jest.Mock;
    reserveNonce: jest.Mock;
    broadcastTransaction: jest.Mock;
    syncNonce: jest.Mock;
  }>;
  let policyService: jest.Mocked<Pick<PolicyService, 'evaluate'>>;
  let orgSeedRepo: jest.Mocked<Pick<organizationSeedRepository, 'findByOrgId' | 'create'>>;
  let walletRepo: jest.Mocked<Pick<WalletRepository, 'create' | 'findByOrgId' | 'findById' | 'countByOrgId'>>;
  let signingRequestRepo: jest.Mocked<{
    findByOrgId: jest.Mock;
    findByWalletId: jest.Mock;
    findByIdempotencyKey: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  }>;
  let auditLogRepo: jest.Mocked<Pick<AuditLogRepository, 'create'>>;
  let userRepo: jest.Mocked<Pick<UserRepository, 'findById'>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: CryptoClientService,
          useValue: {
            createWallet: jest.fn(),
            deriveWallet: jest.fn(),
            signTransaction: jest.fn(),
          },
        },
        {
          provide: GasService,
          useValue: {
            estimateFees: jest.fn(),
            reserveNonce: jest.fn(),
            broadcastTransaction: jest.fn(),
            syncNonce: jest.fn(),
          },
        },
        { provide: PolicyService, useValue: { evaluate: jest.fn() } },
        { provide: organizationSeedRepository, useValue: { findByOrgId: jest.fn(), create: jest.fn() } },
        {
          provide: WalletRepository,
          useValue: { create: jest.fn(), findByOrgId: jest.fn(), findById: jest.fn(), countByOrgId: jest.fn() },
        },
        {
          provide: SigningRequestRepository,
          useValue: {
            findByOrgId: jest.fn(),
            findByWalletId: jest.fn(),
            findByIdempotencyKey: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        { provide: AuditLogRepository, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: UserRepository, useValue: { findById: jest.fn() } },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    cryptoClient = module.get(CryptoClientService);
    gasService = module.get(GasService);
    policyService = module.get(PolicyService);
    orgSeedRepo = module.get(organizationSeedRepository);
    walletRepo = module.get(WalletRepository);
    signingRequestRepo = module.get(SigningRequestRepository);
    auditLogRepo = module.get(AuditLogRepository);
    userRepo = module.get(UserRepository);

    orgSeedRepo.findByOrgId.mockResolvedValue(seedRow as any);
    walletRepo.findById.mockResolvedValue(wallet as any);
    policyService.evaluate.mockResolvedValue({ decision: 'allow', reason: undefined } as any);
    gasService.estimateFees.mockResolvedValue({ gasLimit: 21000, maxFeePerGas: '2', maxPriorityFeePerGas: '1' });
    gasService.reserveNonce.mockResolvedValue(7);
    cryptoClient.signTransaction.mockResolvedValue({
      rawTx: '0xrawtx',
      txHash: '0xhash',
      signature: '0xsig',
    });
    signingRequestRepo.findByIdempotencyKey.mockResolvedValue(undefined);
    signingRequestRepo.create.mockResolvedValue({ id: 'req-1' });
    signingRequestRepo.update.mockResolvedValue({});
    gasService.broadcastTransaction.mockResolvedValue(undefined);
    gasService.syncNonce.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onBoardOrganization', () => {
    it('creates seed + first wallet + audit log', async () => {
      orgSeedRepo.findByOrgId.mockResolvedValue(undefined);
      cryptoClient.createWallet.mockResolvedValue({
        encryptedSeed: 'enc-seed',
        seedNonce: 'non-1',
        encryptedDek: 'dek-1',
        firstAddress: '0xabc',
      });
      walletRepo.create.mockResolvedValue({ id: 'wallet-1', address: '0xabc' });

      const result = await service.onBoardOrganization('org-1');

      expect(result).toEqual({ orgId: 'org-1', firstAddress: '0xabc' });
      expect(orgSeedRepo.create).toHaveBeenCalledWith({
        org_id: 'org-1',
        encrypted_seed: 'enc-seed',
        seed_nonce: 'non-1',
        encrypted_dek: 'dek-1',
      });
      expect(walletRepo.create).toHaveBeenCalledWith({
        org_id: 'org-1',
        user_id: null,
        address: '0xabc',
        derivation_path: "m/44'/60'/0'/0/0",
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: 'org-1', event: 'org_onboarded', status: 'success' }),
      );
    });

    it('throws when org already onboarded', async () => {
      await expect(service.onBoardOrganization('org-1')).rejects.toThrow('organization already onboarded');
      expect(cryptoClient.createWallet).not.toHaveBeenCalled();
    });
  });

  describe('deriveWallet', () => {
    it('derives and creates a wallet', async () => {
      walletRepo.countByOrgId.mockResolvedValue(1);
      cryptoClient.deriveWallet.mockResolvedValue({
        address: '0xdef',
        derivationPath: "m/44'/60'/0'/0/1",
      });
      walletRepo.create.mockResolvedValue({ id: 'wallet-2', address: '0xdef' });

      const result = await service.deriveWallet('org-1', undefined, 'Second');

      expect(result).toEqual({ walletId: 'wallet-2', address: '0xdef' });
      expect(cryptoClient.deriveWallet).toHaveBeenCalledWith('enc-seed', 'nonce-1', 'enc-dek', 1);
      expect(walletRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: 'org-1', user_id: undefined, label: 'Second', chain_id: 1 }),
      );
    });

    it('rejects when org not onboarded', async () => {
      orgSeedRepo.findByOrgId.mockResolvedValue(undefined);
      await expect(service.deriveWallet('org-1', undefined, 'X')).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown user', async () => {
      userRepo.findById.mockResolvedValue(undefined);
      await expect(service.deriveWallet('org-1', 'user-99', 'X')).rejects.toThrow(NotFoundException);
    });

    it('rejects user from another org', async () => {
      userRepo.findById.mockResolvedValue({ id: 'user-1', org_id: 'org-2' } as any);
      await expect(service.deriveWallet('org-1', 'user-1', 'X')).rejects.toThrow(BadRequestException);
    });
  });

  describe('listWalletsByOrgId / getWalletById', () => {
    it('maps wallet fields', async () => {
      walletRepo.findByOrgId.mockResolvedValue([wallet as any]);
      const result = await service.listWalletsByOrgId('org-1');
      expect(result[0]).toEqual({
        id: 'wallet-1',
        orgId: 'org-1',
        userId: null,
        label: 'Main',
        address: wallet.address,
        chainId: 1,
        status: 'active',
        createdAt: wallet.created_at,
      });
    });

    it('getWalletById returns wallet', async () => {
      const result = await service.getWalletById('wallet-1', 'org-1');
      expect(result.id).toBe('wallet-1');
    });

    it('getWalletById throws when wallet missing', async () => {
      walletRepo.findById.mockResolvedValue(undefined);
      await expect(service.getWalletById('wallet-1', 'org-1')).rejects.toThrow(NotFoundException);
    });

    it('getWalletById throws when wallet belongs to another org', async () => {
      walletRepo.findById.mockResolvedValue({ ...wallet, org_id: 'org-2' } as any);
      await expect(service.getWalletById('wallet-1', 'org-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('listSigningRequestsByWalletId', () => {
    it('returns requests for owner org', async () => {
      signingRequestRepo.findByWalletId.mockResolvedValue([signedRequest]);
      const result = await service.listSigningRequestsByWalletId('wallet-1', 'org-1');
      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe('0xhash');
    });

    it('rejects wallet from another org', async () => {
      walletRepo.findById.mockResolvedValue({ ...wallet, org_id: 'org-2' } as any);
      await expect(service.listSigningRequestsByWalletId('wallet-1', 'org-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getSigningRequestById', () => {
    it('returns mapped request', async () => {
      signingRequestRepo.findById.mockResolvedValue(signedRequest);
      const result = await service.getSigningRequestById('org-1', 'wallet-1', 'req-1');
      expect(result.id).toBe('req-1');
    });

    it('throws when request missing', async () => {
      signingRequestRepo.findById.mockResolvedValue(undefined);
      await expect(service.getSigningRequestById('org-1', 'wallet-1', 'req-1')).rejects.toThrow(NotFoundException);
    });

    it('throws when request belongs to another wallet', async () => {
      signingRequestRepo.findById.mockResolvedValue({ ...signedRequest, wallet_id: 'wallet-2' });
      await expect(service.getSigningRequestById('org-1', 'wallet-1', 'req-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('requestSign', () => {
    it('returns broadcasted result and writes audit log', async () => {
      signingRequestRepo.findByIdempotencyKey.mockResolvedValue(undefined);
      signingRequestRepo.create.mockResolvedValue({ id: 'req-1' });
      signingRequestRepo.update.mockResolvedValue({});

      const result = await service.requestSign('org-1', 'wallet-1', signReq);

      expect(result).toEqual({
        signingRequestId: 'req-1',
        txHash: '0xhash',
        status: 'broadcasted',
        nonce: 7,
        idempotencyKey: expect.any(String),
      });
      expect(gasService.broadcastTransaction).toHaveBeenCalledWith('0xrawtx', 1);
      expect(signingRequestRepo.update).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ status: 'broadcasted' }),
      );
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: 'org-1', wallet_id: 'wallet-1', event: 'tx_signed', status: 'broadcasted' }),
      );
    });

    it('returns existing pending request for duplicate idempotency key', async () => {
      const pending = { ...signedRequest, status: 'pending' };
      signingRequestRepo.findByIdempotencyKey.mockResolvedValue(pending);

      const result = await service.requestSign('org-1', 'wallet-1', signReq);

      expect(result.signingRequestId).toBe('req-1');
      expect(signingRequestRepo.create).not.toHaveBeenCalled();
      expect(policyService.evaluate).not.toHaveBeenCalled();
    });

    it('rejects policy deny', async () => {
      policyService.evaluate.mockResolvedValue({ decision: 'deny', reason: 'limit' } as any);
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(ForbiddenException);
      expect(gasService.reserveNonce).not.toHaveBeenCalled();
    });

    it('rejects unknown org', async () => {
      orgSeedRepo.findByOrgId.mockResolvedValue(undefined);
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(BadRequestException);
    });

    it('rejects missing wallet', async () => {
      walletRepo.findById.mockResolvedValue(undefined);
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(NotFoundException);
    });

    it('rejects wallet from another org', async () => {
      walletRepo.findById.mockResolvedValue({ ...wallet, org_id: 'org-2' } as any);
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(BadRequestException);
    });

    it('reuses failed row on unique-violation race', async () => {
      const failed = { ...signedRequest, status: 'failed', id: 'req-failed' };
      signingRequestRepo.findByIdempotencyKey
        .mockResolvedValueOnce(undefined) // fast path
        .mockResolvedValueOnce(failed); // post create race
      signingRequestRepo.create.mockRejectedValue({ code: '23505' });
      signingRequestRepo.update.mockResolvedValue({});

      const result = await service.requestSign('org-1', 'wallet-1', signReq);

      expect(result.signingRequestId).toBe('req-failed');
      expect(signingRequestRepo.update).toHaveBeenCalledWith(
        'req-failed',
        expect.objectContaining({ status: 'pending' }),
      );
    });

    it('marks failed and surfaces HttpException when signing throws', async () => {
      cryptoClient.signTransaction.mockRejectedValue(new Error('key unreachable'));
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(HttpException);
      expect(signingRequestRepo.update).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ status: 'failed', error_type: expect.any(String) }),
      );
    });

    it('marks failed and surfaces HttpException when broadcast throws', async () => {
      gasService.broadcastTransaction.mockRejectedValue(new Error('RPC down'));
      await expect(service.requestSign('org-1', 'wallet-1', signReq)).rejects.toThrow(HttpException);
      expect(signingRequestRepo.update).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ status: 'failed', failure_reason: expect.stringContaining('broadcast failed') }),
      );
      expect(gasService.syncNonce).toHaveBeenCalledWith('wallet-1', 1, wallet.address);
    });
  });
});