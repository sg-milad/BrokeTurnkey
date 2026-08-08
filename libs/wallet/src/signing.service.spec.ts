import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { hashMessage, hashTypedData } from 'viem';
import { CryptoClientService } from '@app/crypto-client';
import { organizationSeedRepository, WalletRepository, AuditLogRepository } from '@app/db/repositories';
import { SigningService } from './signing.service';
import type { Eip712SignRequest } from './signing.interfaces';

const seedRow = {
    id: 'seed-1', org_id: 'org-1', encrypted_seed: 'enc-seed',
    seed_nonce: 'nonce-1', encrypted_dek: 'enc-dek',
    created_at: new Date('2024-01-01T00:00:00Z'),
};
const wallet = {
    id: 'wallet-1', org_id: 'org-1', user_id: null, label: 'Main',
    address: '0x1234567890123456789012345678901234567890',
    derivation_path: "m/44'/60'/0'/0/0", chain_id: 1, status: 'active',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
};
const eip712Req: Eip712SignRequest = {
    domain: { name: 'Example', version: '1', chainId: 1, verifyingContract: '0x1111111111111111111111111111111111111111' },
    types: {
        Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
        Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
    },
    primaryType: 'Mail',
    message: {
        from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
        to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
        contents: 'Hello, Bob!',
    },
};

describe('SigningService', () => {
    let service: SigningService;
    let cryptoClient: jest.Mocked<Pick<CryptoClientService, 'signHash'>>;
    let orgSeedRepo: jest.Mocked<Pick<organizationSeedRepository, 'findByOrgId'>>;
    let walletRepo: jest.Mocked<Pick<WalletRepository, 'findById'>>;
    let auditLogRepo: jest.Mocked<Pick<AuditLogRepository, 'create'>>;
    let config: jest.Mocked<Pick<ConfigService, 'get'>>;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SigningService,
                { provide: CryptoClientService, useValue: { signHash: jest.fn() } },
                { provide: organizationSeedRepository, useValue: { findByOrgId: jest.fn() } },
                { provide: WalletRepository, useValue: { findById: jest.fn() } },
                { provide: AuditLogRepository, useValue: { create: jest.fn().mockResolvedValue({}) } },
                { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
            ],
        }).compile();

        service = module.get(SigningService);
        cryptoClient = module.get(CryptoClientService);
        orgSeedRepo = module.get(organizationSeedRepository);
        walletRepo = module.get(WalletRepository);
        auditLogRepo = module.get(AuditLogRepository);
        config = module.get(ConfigService);

        orgSeedRepo.findByOrgId.mockResolvedValue(seedRow as any);
        walletRepo.findById.mockResolvedValue(wallet as any);
        cryptoClient.signHash.mockResolvedValue({ signature: '0xsignature' });
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('signEip712', () => {
        const expectedTypedHash = hashTypedData({
            domain: eip712Req.domain as any, types: eip712Req.types as any,
            primaryType: eip712Req.primaryType, message: eip712Req.message as any,
        });

        it('returns signature + hash and delegates to crypto client', async () => {
            const result = await service.signEip712('org-1', 'wallet-1', eip712Req);
            expect(result).toEqual({ signature: '0xsignature', hash: expectedTypedHash });
            expect(cryptoClient.signHash).toHaveBeenCalledWith(
                seedRow.encrypted_seed, seedRow.seed_nonce, seedRow.encrypted_dek,
                wallet.derivation_path, expectedTypedHash,
            );
        });

        it('writes typed_data_signed audit log', async () => {
            await service.signEip712('org-1', 'wallet-1', eip712Req);
            expect(auditLogRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ org_id: 'org-1', wallet_id: 'wallet-1', event: 'typed_data_signed', status: 'success' }),
            );
        });

        it('rejects domain not on allowlist', async () => {
            config.get.mockReturnValue('app.example.com');
            await expect(service.signEip712('org-1', 'wallet-1', eip712Req)).rejects.toThrow(ForbiddenException);
            expect(cryptoClient.signHash).not.toHaveBeenCalled();
        });

        it('allows domain on allowlist', async () => {
            config.get.mockReturnValue('app.example.com');
            await expect(
                service.signEip712('org-1', 'wallet-1', { ...eip712Req, domain: { ...eip712Req.domain, name: 'app.example.com' } }),
            ).resolves.toEqual({ signature: '0xsignature', hash: expect.any(String) });
        });

        it('rejects missing domain name when allowlist configured', async () => {
            config.get.mockReturnValue('app.example.com');
            await expect(
                service.signEip712('org-1', 'wallet-1', { ...eip712Req, domain: { ...eip712Req.domain, name: undefined } }),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('signPersonalMessage', () => {
        it('returns signature + EIP-191 hash', async () => {
            const result = await service.signPersonalMessage('org-1', 'wallet-1', { message: 'Hello world' });
            expect(result.signature).toBe('0xsignature');
            expect(result.hash).toBe(hashMessage('Hello world'));
        });

        it('delegates with prefixed hash', async () => {
            await service.signPersonalMessage('org-1', 'wallet-1', { message: 'Hello world' });
            expect(cryptoClient.signHash).toHaveBeenCalledWith(
                seedRow.encrypted_seed, seedRow.seed_nonce, seedRow.encrypted_dek,
                wallet.derivation_path, hashMessage('Hello world'),
            );
        });

        it('writes message_signed audit log', async () => {
            await service.signPersonalMessage('org-1', 'wallet-1', { message: 'Hello world' });
            expect(auditLogRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ org_id: 'org-1', wallet_id: 'wallet-1', event: 'message_signed', status: 'success' }),
            );
        });
    });

    describe('loadWallet guard paths', () => {
        it('rejects when org not onboarded', async () => {
            orgSeedRepo.findByOrgId.mockResolvedValue(undefined);
            await expect(service.signPersonalMessage('org-1', 'wallet-1', { message: 'x' })).rejects.toThrow(BadRequestException);
            expect(cryptoClient.signHash).not.toHaveBeenCalled();
        });

        it('rejects when wallet not found', async () => {
            walletRepo.findById.mockResolvedValue(undefined);
            await expect(service.signEip712('org-1', 'wallet-1', eip712Req)).rejects.toThrow(NotFoundException);
        });

        it('rejects when wallet belongs to another org', async () => {
            walletRepo.findById.mockResolvedValue({ ...wallet, org_id: 'org-2' } as any);
            await expect(service.signEip712('org-1', 'wallet-1', eip712Req)).rejects.toThrow(BadRequestException);
            expect(cryptoClient.signHash).not.toHaveBeenCalled();
        });
    });
});
