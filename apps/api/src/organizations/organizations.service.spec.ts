import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrganizationsService } from './organizations.service';
import { organizationRepository } from '@app/db/repositories/organization.repository';
import { WalletService } from '@app/wallet';
import { AuthService } from '@app/auth';
import { CreateOrganizationDto } from './dto/create-organization.dto';

describe('OrganizationsService', () => {
    let service: OrganizationsService;
    let organizationRepo: {
        findBySlug: jest.Mock;
        findById: jest.Mock;
        create: jest.Mock;
    };
    let walletService: Record<string, jest.Mock>;
    let authService: { generateBootstrapToken: jest.Mock };

    const orgRow = {
        id: 'org-1',
        name: 'Acme',
        slug: 'acme',
        bootstrap_token_hash: 'deadbeef',
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
        bootstrapToken: undefined,
    };

    beforeEach(async () => {
        organizationRepo = {
            findBySlug: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
        };
        walletService = {
            onBoardOrganization: jest.fn(),
            listWalletsByOrgId: jest.fn(),
            listSigningRequestsByOrgId: jest.fn(),
        };
        authService = { generateBootstrapToken: jest.fn() };

        const module = await Test.createTestingModule({
            providers: [
                OrganizationsService,
                {
                    provide: organizationRepository,
                    useValue: organizationRepo,
                },
                { provide: WalletService, useValue: walletService },
                { provide: AuthService, useValue: authService },
            ],
        }).compile();

        service = module.get(OrganizationsService);
    });

    describe('create', () => {
        const dto: CreateOrganizationDto = {
            name: 'Acme',
            slug: 'acme',
        };

        it('throws ConflictException when slug already exists', async () => {
            organizationRepo.findBySlug.mockResolvedValue(orgRow);

            await expect(service.create(dto)).rejects.toThrow(
                ConflictException,
            );
            await expect(service.create(dto)).rejects.toThrow(
                'organization with slug "acme" already exists',
            );

            expect(organizationRepo.findBySlug).toHaveBeenCalledWith('acme');
            expect(organizationRepo.create).not.toHaveBeenCalled();
            expect(walletService.onBoardOrganization).not.toHaveBeenCalled();
            expect(authService.generateBootstrapToken).not.toHaveBeenCalled();
        });

        it('creates organization, auto-onboards and returns org with bootstrap token', async () => {
            const created = { ...orgRow };
            organizationRepo.findBySlug.mockResolvedValue(undefined);
            organizationRepo.create.mockResolvedValue(created);
            walletService.onBoardOrganization.mockResolvedValue({
                firstAddress: '0xabc123',
            });
            authService.generateBootstrapToken.mockResolvedValue('bootstrap-123');

            const result = await service.create(dto);

            expect(organizationRepo.create).toHaveBeenCalledWith(dto);
            expect(walletService.onBoardOrganization).toHaveBeenCalledWith(
                'org-1',
            );
            expect(authService.generateBootstrapToken).toHaveBeenCalledWith(
                'org-1',
            );
            expect(result).toEqual({
                id: 'org-1',
                name: 'Acme',
                slug: 'acme',
                created_at: created.created_at,
                updated_at: created.updated_at,
                bootstrapToken: 'bootstrap-123',
                walletAddress: '0xabc123',
            });
            // Internal state must never cross the API boundary.
            expect(result).not.toHaveProperty('bootstrap_token_hash');
        });

        it('does not create wallet/token when repo.create rejects', async () => {
            organizationRepo.findBySlug.mockResolvedValue(undefined);
            organizationRepo.create.mockRejectedValue(new Error('db down'));

            await expect(service.create(dto)).rejects.toThrow('db down');

            expect(walletService.onBoardOrganization).not.toHaveBeenCalled();
            expect(authService.generateBootstrapToken).not.toHaveBeenCalled();
        });
    });

    describe('findOne', () => {
        it('returns the organization without the internal bootstrap_token_hash', async () => {
            organizationRepo.findById.mockResolvedValue(orgRow);

            const { bootstrap_token_hash, ...publicOrg } = orgRow;
            await expect(service.findOne('org-1')).resolves.toEqual(publicOrg);
            expect(organizationRepo.findById).toHaveBeenCalledWith('org-1');
        });

        it('returns undefined when not found', async () => {
            organizationRepo.findById.mockResolvedValue(undefined);

            await expect(service.findOne('missing')).resolves.toBeUndefined();
        });
    });

    describe('findBySlug', () => {
        it('delegates to repository and strips internal bootstrap_token_hash', async () => {
            organizationRepo.findBySlug.mockResolvedValue(orgRow);

            const { bootstrap_token_hash, ...publicOrg } = orgRow;
            await expect(service.findBySlug('acme')).resolves.toEqual(
                publicOrg,
            );
            expect(organizationRepo.findBySlug).toHaveBeenCalledWith('acme');
        });
    });

    describe('listWalletsByOrgId', () => {
        it('delegates to wallet service', async () => {
            const wallets = [{ id: 'w-1' }];
            walletService.listWalletsByOrgId.mockResolvedValue(wallets);

            await expect(service.listWalletsByOrgId('org-1')).resolves.toEqual(
                wallets,
            );
            expect(walletService.listWalletsByOrgId).toHaveBeenCalledWith(
                'org-1',
            );
        });
    });

    describe('listSigningRequestsByOrgId', () => {
        it('delegates to wallet service', async () => {
            const requests = [{ id: 'sr-1' }];
            walletService.listSigningRequestsByOrgId.mockResolvedValue(requests);

            await expect(
                service.listSigningRequestsByOrgId('org-1'),
            ).resolves.toEqual(requests);
            expect(
                walletService.listSigningRequestsByOrgId,
            ).toHaveBeenCalledWith('org-1');
        });
    });
});