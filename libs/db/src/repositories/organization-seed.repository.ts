import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IorganizationSeedRepository } from './interfaces';
import type { DrizzleClient } from '../db';
import { organizationSeed, organization_seeds, NeworganizationSeed } from '../schema';
import { DRIZZLE_CLIENT } from '../constants';
@Injectable()
export class organizationSeedRepository implements IorganizationSeedRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findByOrgId(orgId: string): Promise<organizationSeed | undefined> {
        const result = await this.db.select().from(organization_seeds).where(eq(organization_seeds.org_id, orgId));
        return result[0];
    }

    async create(data: NeworganizationSeed): Promise<organizationSeed> {
        const result = await this.db.insert(organization_seeds).values(data).returning();
        return result[0];
    }
}
