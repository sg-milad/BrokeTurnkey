import { Organisation, NewOrganisation } from '../../schema/organisations';

export interface IOrganisationRepository {
    findById(id: string): Promise<Organisation | undefined>;
    findBySlug(slug: string): Promise<Organisation | undefined>;
    create(data: NewOrganisation): Promise<Organisation>;
}
