import { Test } from '@nestjs/testing';
import { WalletsController } from './wallets.controller';
import { WalletService, SigningService } from '@app/wallet';
import { SignTransactionDto } from './dto/sign-transaction.dto';
import { SignTypedDataDto } from './dto/sign-typed-data.dto';
import { SignMessageDto } from './dto/sign-message.dto';

describe('WalletsController', () => {
    let controller: WalletsController;
    let walletService: Record<string, jest.Mock>;
    let signingService: Record<string, jest.Mock>;

    beforeEach(async () => {
        walletService = {
            getWalletById: jest.fn(),
            listSigningRequestsByWalletId: jest.fn(),
            getSigningRequestById: jest.fn(),
            deriveWallet: jest.fn(),
            requestSign: jest.fn(),
        };
        signingService = {
            signEip712: jest.fn(),
            signPersonalMessage: jest.fn(),
        };

        const module = await Test.createTestingModule({
            controllers: [WalletsController],
            providers: [
                { provide: WalletService, useValue: walletService },
                { provide: SigningService, useValue: signingService },
            ],
        }).compile();

        controller = module.get(WalletsController);
    });

    describe('findOne', () => {
        it('fetches wallet scoped to org', async () => {
            const wallet = { id: 'w-1', orgId: 'org-1' };
            walletService.getWalletById.mockResolvedValue(wallet);

            await expect(controller.findOne('org-1', 'w-1')).resolves.toEqual(
                wallet,
            );
            expect(walletService.getWalletById).toHaveBeenCalledWith(
                'w-1',
                'org-1',
            );
        });
    });

    describe('listSigningRequests', () => {
        it('delegates to wallet service with org scoping', async () => {
            const requests = [{ id: 'sr-1' }];
            walletService.listSigningRequestsByWalletId.mockResolvedValue(
                requests,
            );

            await expect(
                controller.listSigningRequests('org-1', 'w-1'),
            ).resolves.toEqual(requests);
            expect(
                walletService.listSigningRequestsByWalletId,
            ).toHaveBeenCalledWith('w-1', 'org-1');
        });
    });

    describe('getSigningRequest', () => {
        it('delegates polling lookup to wallet service', async () => {
            const status = { id: 'sr-1', status: 'broadcasted' };
            walletService.getSigningRequestById.mockResolvedValue(status);

            await expect(
                controller.getSigningRequest('org-1', 'w-1', 'sr-1'),
            ).resolves.toEqual(status);
            expect(walletService.getSigningRequestById).toHaveBeenCalledWith(
                'org-1',
                'w-1',
                'sr-1',
            );
        });
    });

    describe('derive', () => {
        it('derives a wallet for the org', async () => {
            const wallet = { id: 'w-2' };
            walletService.deriveWallet.mockResolvedValue(wallet);
            const dto = { userId: 'user-1', label: 'Ops', chainId: 1 };

            await expect(controller.derive('org-1', dto as any)).resolves.toEqual(
                wallet,
            );
            expect(walletService.deriveWallet).toHaveBeenCalledWith(
                'org-1',
                'user-1',
                'Ops',
                1,
            );
        });
    });

    describe('signTransaction', () => {
        it('maps txFields into requestSign payload', async () => {
            const result = { requestId: 'sr-9' };
            walletService.requestSign.mockResolvedValue(result);

            const dto = {
                txFields: {
                    chainId: 1,
                    to: '0xabc',
                    value: '100',
                    data: '0x',
                },
            } as SignTransactionDto;

            await expect(
                controller.signTransaction('org-1', 'w-1', dto),
            ).resolves.toEqual(result);
            expect(walletService.requestSign).toHaveBeenCalledWith('org-1', 'w-1', {
                chainId: 1,
                to: '0xabc',
                value: '100',
                data: '0x',
            });
        });
    });

    describe('signTyped', () => {
        it('signs EIP-712 typed data via signing service', async () => {
            const signature = '0xsig';
            signingService.signEip712.mockResolvedValue(signature);

            const dto = {
                domain: { name: 'App', version: '1' },
                types: { Person: [{ name: 'name', type: 'string' }] },
                primaryType: 'Person',
                message: { name: 'Alice' },
            } as SignTypedDataDto;

            await expect(
                controller.signTyped('org-1', 'w-1', dto),
            ).resolves.toEqual(signature);
            expect(signingService.signEip712).toHaveBeenCalledWith('org-1', 'w-1', {
                domain: dto.domain,
                types: dto.types,
                primaryType: 'Person',
                message: dto.message,
            });
        });
    });

    describe('signMessage', () => {
        it('signs EIP-191 personal message via signing service', async () => {
            const signature = '0xsig-msg';
            signingService.signPersonalMessage.mockResolvedValue(signature);

            const dto = { message: 'gm' } as SignMessageDto;

            await expect(
                controller.signMessage('org-1', 'w-1', dto),
            ).resolves.toEqual(signature);
            expect(signingService.signPersonalMessage).toHaveBeenCalledWith(
                'org-1',
                'w-1',
                { message: 'gm' },
            );
        });
    });
});