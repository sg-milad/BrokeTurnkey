import { ConfigService } from '@nestjs/config';
import { SpeedUpService } from './speed-up.service';

describe('SpeedUpService', () => {
    let service: SpeedUpService;
    let signingRequestRepo: any;
    let walletRepo: any;
    let orgSeedRepo: any;
    let gasService: any;
    let cryptoClient: any;
    let config: any;

    const row = {
        id: 'req-1',
        wallet_id: 'wallet-1',
        org_id: 'org-1',
        chain_id: 11155111,
        tx_payload: {
            nonce: 0,
            chainId: 11155111,
            to: '0x2222222222222222222222222222222222222222',
            value: '1000000000000000000',
            data: '0x',
            gasLimit: 21000,
            maxFeePerGas: '1000000000',
            maxPriorityFeePerGas: '100000000',
        },
        tx_hash: '0xabc',
        original_tx_hash: null,
        speed_up_attempts: 0,
    };

    beforeEach(() => {
        signingRequestRepo = {
            update: jest.fn().mockResolvedValue(undefined),
        };
        walletRepo = {
            findById: jest.fn().mockResolvedValue({
                id: 'wallet-1',
                org_id: 'org-1',
                derivation_path: "m/44'/60'/0'/0/0",
            }),
        };
        orgSeedRepo = {
            findByOrgId: jest.fn().mockResolvedValue({
                org_id: 'org-1',
                encrypted_seed: 'enc-seed',
                seed_nonce: 'seed-nonce',
                encrypted_dek: 'enc-dek',
            }),
        };
        gasService = {
            estimateFees: jest.fn().mockResolvedValue({
                gasLimit: 21000,
                maxFeePerGas: '1000000000',
                maxPriorityFeePerGas: '100000000',
            }),
            broadcastTransaction: jest.fn().mockResolvedValue('0xreplacement'),
        };
        cryptoClient = {
            signTransaction: jest.fn().mockResolvedValue({
                rawTx: '0xrawreplacement',
                txHash: '0xreplacement',
                signature: '0xsig',
            }),
        };
        config = { get: jest.fn().mockImplementation((key: string, def: string) => def) };

        service = new SpeedUpService(
            signingRequestRepo,
            walletRepo,
            orgSeedRepo,
            gasService,
            cryptoClient,
            config as ConfigService,
        );
    });

    it('rebuilds replacement tx using wallet metadata and org seed', async () => {
        await service.speedUp(row as any);

        expect(walletRepo.findById).toHaveBeenCalledWith('wallet-1');
        expect(orgSeedRepo.findByOrgId).toHaveBeenCalledWith('org-1');
        expect(cryptoClient.signTransaction).toHaveBeenCalledWith(
            'enc-seed',
            'seed-nonce',
            'enc-dek',
            "m/44'/60'/0'/0/0",
            expect.objectContaining({
                chainId: 11155111,
                nonce: 0,
                to: row.tx_payload.to,
                value: row.tx_payload.value,
                data: row.tx_payload.data,
            }),
        );
        expect(signingRequestRepo.update).toHaveBeenCalledWith('req-1', expect.objectContaining({
            tx_hash: '0xreplacement',
            speed_up_attempts: 1,
            status: 'broadcasted',
        }));
    });

    it('fails permanently when wallet metadata is missing', async () => {
        walletRepo.findById.mockResolvedValue(undefined);

        await service.speedUp(row as any);

        expect(signingRequestRepo.update).toHaveBeenCalledWith('req-1', expect.objectContaining({
            status: 'failed',
            error_type: 'permanent',
            failure_reason: 'wallet metadata unavailable for speed-up',
        }));
    });

    it('fails permanently when organization seed is missing', async () => {
        orgSeedRepo.findByOrgId.mockResolvedValue(undefined);

        await service.speedUp(row as any);

        expect(signingRequestRepo.update).toHaveBeenCalledWith('req-1', expect.objectContaining({
            status: 'failed',
            error_type: 'permanent',
            failure_reason: 'organization seed unavailable for speed-up',
        }));
    });

    it('marks failed when max speed-up attempts reached', async () => {
        await service.speedUp({ ...row, speed_up_attempts: 3 } as any);

        expect(signingRequestRepo.update).toHaveBeenCalledWith('req-1', expect.objectContaining({
            status: 'failed',
            error_type: 'permanent',
            failure_reason: 'max speed-up attempts reached',
        }));
        expect(cryptoClient.signTransaction).not.toHaveBeenCalled();
    });
});
