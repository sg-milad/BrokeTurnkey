import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IOrganisationSeedRepository } from './interfaces';
import { DRIZZLE_CLIENT } from '../database.module';
import type { DrizzleClient } from '../db';
import { OrganisationSeed, organisation_seeds, NewOrganisationSeed } from '../schema';

@Injectable()
export class OrganisationSeedRepository implements IOrganisationSeedRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findByOrgId(orgId: string): Promise<OrganisationSeed | undefined> {
        const result = await this.db.select().from(organisation_seeds).where(eq(organisation_seeds.org_id, orgId));
        return result[0];
    }

    async create(data: NewOrganisationSeed): Promise<OrganisationSeed> {
        const result = await this.db.insert(organisation_seeds).values(data).returning();
        return result[0];
    }
}
