import { organizationRepository } from './organization.repository';
import { organizations } from '../schema/organizations';

describe('organizationRepository', () => {
    const orgRow = {
        id: 'org-1',
        name: 'Acme',
        slug: 'acme',
        bootstrap_token_hash: 'deadbeef',
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
    };

    function makeRepo(db: any) {
        return new organizationRepository(db);
    }

    function selectChain(rows: any[]) {
        const where = jest.fn().mockResolvedValue(rows);
        const from = jest.fn().mockReturnValue({ where });
        const select = jest.fn().mockReturnValue({ from });
        return { db: { select } as any, select, from, where };
    }

    describe('findById', () => {
        it('returns the organization when found', async () => {
            const { db, select, from, where } = selectChain([orgRow]);
            const repo = makeRepo(db);

            const result = await repo.findById('org-1');

            expect(select).toHaveBeenCalledWith();
            expect(from).toHaveBeenCalledWith(organizations);
            expect(where).toHaveBeenCalled();
            expect(result).toEqual(orgRow);
        });

        it('returns undefined when not found', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findById('missing');
            expect(result).toBeUndefined();
        });
    });

    describe('findBySlug', () => {
        it('returns the organization matching the slug', async () => {
            const { db } = selectChain([orgRow]);
            const repo = makeRepo(db);

            const result = await repo.findBySlug('acme');
            expect(result).toEqual(orgRow);
        });

        it('returns undefined when no slug match', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findBySlug('nope');
            expect(result).toBeUndefined();
        });
    });

    describe('findByBootstrapTokenHash', () => {
        it('returns the organization matching the bootstrap token hash', async () => {
            const { db, select, from, where } = selectChain([orgRow]);
            const repo = makeRepo(db);

            const result = await repo.findByBootstrapTokenHash('deadbeef');

            expect(select).toHaveBeenCalledWith();
            expect(from).toHaveBeenCalledWith(organizations);
            expect(where).toHaveBeenCalled();
            expect(result).toEqual(orgRow);
        });

        it('returns undefined when hash does not match any org', async () => {
            const { db } = selectChain([]);
            const repo = makeRepo(db);

            const result = await repo.findByBootstrapTokenHash('wrong');
            expect(result).toBeUndefined();
        });
    });

    describe('create', () => {
        it('inserts and returns created organization', async () => {
            const returning = jest.fn().mockResolvedValue([orgRow]);
            const values = jest.fn().mockReturnValue({ returning });
            const insert = jest.fn().mockReturnValue({ values });
            const repo = makeRepo({ insert } as any);

            const result = await repo.create(orgRow as any);

            expect(insert).toHaveBeenCalledWith(organizations);
            expect(values).toHaveBeenCalledWith(orgRow);
            expect(result).toEqual(orgRow);
        });
    });

    describe('update', () => {
        it('updates and returns the row with refreshed updated_at', async () => {
            const updated = { ...orgRow, name: 'Acme Inc' };
            const returning = jest.fn().mockResolvedValue([updated]);
            const where = jest.fn().mockReturnValue({ returning });
            const set = jest.fn().mockReturnValue({ where });
            const update = jest.fn().mockReturnValue({ set });
            const repo = makeRepo({ update } as any);

            const result = await repo.update('org-1', { name: 'Acme Inc' });

            expect(update).toHaveBeenCalledWith(organizations);
            expect(set).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'Acme Inc',
                    updated_at: expect.any(Date),
                }),
            );
            expect(result).toEqual(updated);
        });

        it('returns undefined when no row updated', async () => {
            const returning = jest.fn().mockResolvedValue([]);
            const where = jest.fn().mockReturnValue({ returning });
            const set = jest.fn().mockReturnValue({ where });
            const update = jest.fn().mockReturnValue({ set });
            const repo = makeRepo({ update } as any);

            const result = await repo.update('missing', { name: 'X' });
            expect(result).toBeUndefined();
        });
    });
});