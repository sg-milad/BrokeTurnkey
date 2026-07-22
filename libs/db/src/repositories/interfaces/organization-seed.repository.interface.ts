import { organizationSeed, NeworganizationSeed } from '../../schema/organization-seeds';

export interface IorganizationSeedRepository {
    findByOrgId(orgId: string): Promise<organizationSeed | undefined>;
    create(data: NeworganizationSeed): Promise<organizationSeed>;
}