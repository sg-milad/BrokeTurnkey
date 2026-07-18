import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { IUserRepository } from './interfaces/user.repository.interface';
import { User, NewUser, users } from '../schema/users';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class UserRepository implements IUserRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findById(id: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(eq(users.id, id));
        return result[0];
    }

    async findByOrgAndExternalId(orgId: string, externalId: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(
            and(
                eq(users.org_id, orgId),
                eq(users.external_id, externalId)
            )
        );
        return result[0];
    }

    async create(data: NewUser): Promise<User> {
        const result = await this.db.insert(users).values(data).returning();
        return result[0];
    }
}
