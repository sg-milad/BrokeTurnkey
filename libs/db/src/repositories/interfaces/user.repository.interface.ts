import { User, NewUser } from '../../schema/users';

export interface IUserRepository {
    findById(id: string): Promise<User | undefined>;
    findByOrgAndExternalId(orgId: string, externalId: string): Promise<User | undefined>;
    create(data: NewUser): Promise<User>;
}
