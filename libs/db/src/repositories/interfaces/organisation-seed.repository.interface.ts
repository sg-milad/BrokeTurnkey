import { OrganisationSeed, NewOrganisationSeed } from '../../schema/organisation-seeds';

export interface IOrganisationSeedRepository {
    findByOrgId(orgId: string): Promise<OrganisationSeed | undefined>;
    create(data: NewOrganisationSeed): Promise<OrganisationSeed>;
}