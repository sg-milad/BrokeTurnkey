import { organization, Neworganization } from '../../schema/organizations';

export interface IorganizationRepository {
    findById(id: string): Promise<organization | undefined>;
    findBySlug(slug: string): Promise<organization | undefined>;
    create(data: Neworganization): Promise<organization>;
}
