import { ApiKeyRepository } from './api-key.repository';
import { api_keys } from '../schema/api-keys';

describe('ApiKeyRepository', () => {
    const apiKeyRow = {
        id: 'key-1',
        key_id: 'kid-1',
        org_id: 'org-1',
        name: 'prod',
        scopes: ['wallets:sign', 'wallets:read'],
        status: 'active',
        prefix: 'wtk',
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
    };

    function makeRepo(db: any) {
        return new ApiKeyRepository(db);
    }

    function selectChain(rows: any[]) {
        const where = jest.fn().mockResolvedValue(rows);
        const from = jest.fn().mockReturnValue({ where });
        const select = jest.fn().mockReturnValue({ from });
        return { db: { select } as any, select, from, where };
    }

    describe('findById / findByKeyId', () => {
        it('findById returns row from select chain', async () => {
            const { db, select, from, where } = selectChain([apiKeyRow]);
            const repo = makeRepo(db);

            const result = await repo.findById('key-1');

            expect(select).toHaveBeenCalledWith();
            expect(from).toHaveBeenCalledWith(api_keys);
            expect(where).toHaveBeenCalled();
            expect(result).toEqual(apiKeyRow);
        });

        it('findById returns undefined when no row', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findById('missing');
            expect(result).toBeUndefined();
        });

        it('findByKeyId returns row matching key_id', async () => {
            const { db } = selectChain([apiKeyRow]);
            const repo = makeRepo(db);

            const result = await repo.findByKeyId('kid-1');
            expect(result).toEqual(apiKeyRow);
        });

        it('findByKeyId returns undefined when no row', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findByKeyId('missing');
            expect(result).toBeUndefined();
        });
    });

    describe('findByOrgId', () => {
        it('returns rows for the org', async () => {
            const { db } = selectChain([apiKeyRow]);
            const repo = makeRepo(db);

            const result = await repo.findByOrgId('org-1');

            expect(result).toEqual([apiKeyRow]);
        });

        it('applies status filter when provided', async () => {
            const { db, where } = selectChain([
                apiKeyRow,
                { ...apiKeyRow, id: 'key-2', status: 'revoked' },
            ]);
            const repo = makeRepo(db);

            const result = await repo.findByOrgId('org-1', 'active');

            expect(result).toHaveLength(2);
            expect(where).toHaveBeenCalledWith(expect.anything());
        });

        it('returns empty array when no keys', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findByOrgId('org-1');
            expect(result).toEqual([]);
        });
    });

    describe('create', () => {
        it('inserts and returns created row', async () => {
            const returning = jest.fn().mockResolvedValue([apiKeyRow]);
            const values = jest.fn().mockReturnValue({ returning });
            const insert = jest.fn().mockReturnValue({ values });
            const repo = makeRepo({ insert } as any);

            const result = await repo.create(apiKeyRow as any);

            expect(insert).toHaveBeenCalledWith(api_keys);
            expect(values).toHaveBeenCalledWith(apiKeyRow);
            expect(result).toEqual(apiKeyRow);
        });
    });

    describe('update', () => {
        it('updates and returns row', async () => {
            const updated = { ...apiKeyRow, status: 'revoked' };
            const returning = jest.fn().mockResolvedValue([updated]);
            const where = jest.fn().mockReturnValue({ returning });
            const set = jest.fn().mockReturnValue({ where });
            const update = jest.fn().mockReturnValue({ set });
            const repo = makeRepo({ update } as any);

            const result = await repo.update('key-1', { status: 'revoked' });

            expect(update).toHaveBeenCalledWith(api_keys);
            expect(set).toHaveBeenCalledWith({ status: 'revoked' });
            expect(result?.status).toBe('revoked');
        });

        it('returns undefined when no row updated', async () => {
            const returning = jest.fn().mockResolvedValue([]);
            const where = jest.fn().mockReturnValue({ returning });
            const set = jest.fn().mockReturnValue({ where });
            const update = jest.fn().mockReturnValue({ set });
            const repo = makeRepo({ update } as any);

            const result = await repo.update('missing', { status: 'revoked' });
            expect(result).toBeUndefined();
        });
    });

    describe('delete', () => {
        it('returns true when rowCount > 0', async () => {
            const where = jest.fn().mockResolvedValue({ rowCount: 1 });
            const del = jest.fn().mockReturnValue({ where });
            const repo = makeRepo({ delete: del } as any);

            const result = await repo.delete('key-1');
            expect(result).toBe(true);
        });

        it('returns false when rowCount is 0', async () => {
            const where = jest.fn().mockResolvedValue({ rowCount: 0 });
            const del = jest.fn().mockReturnValue({ where });
            const repo = makeRepo({ delete: del } as any);

            const result = await repo.delete('missing');
            expect(result).toBe(false);
        });

        it('returns false when rowCount is null', async () => {
            const where = jest.fn().mockResolvedValue({ rowCount: null });
            const del = jest.fn().mockReturnValue({ where });
            const repo = makeRepo({ delete: del } as any);

            const result = await repo.delete('missing');
            expect(result).toBe(false);
        });
    });

    describe('hasScope', () => {
        let repo: ApiKeyRepository;

        beforeEach(() => {
            repo = makeRepo({} as any);
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('returns true when scope present', async () => {
            jest.spyOn(repo, 'findByKeyId').mockResolvedValue(apiKeyRow);

            expect(await repo.hasScope('kid-1', 'wallets:sign')).toBe(true);
        });

        it('returns false when scope absent', async () => {
            jest.spyOn(repo, 'findByKeyId').mockResolvedValue(apiKeyRow);

            expect(await repo.hasScope('kid-1', 'admin')).toBe(false);
        });

        it('returns false for unknown api key', async () => {
            jest.spyOn(repo, 'findByKeyId').mockResolvedValue(undefined);

            expect(await repo.hasScope('missing', 'wallets:sign')).toBe(false);
        });

        it('returns false when scopes is empty', async () => {
            jest.spyOn(repo, 'findByKeyId').mockResolvedValue({
                ...apiKeyRow,
                scopes: [],
            });

            expect(await repo.hasScope('kid-1', 'wallets:sign')).toBe(false);
        });

        it('returns false when scopes is null', async () => {
            jest.spyOn(repo, 'findByKeyId').mockResolvedValue({
                ...apiKeyRow,
                scopes: null,
            });

            expect(await repo.hasScope('kid-1', 'wallets:sign')).toBe(false);
        });
    });
});