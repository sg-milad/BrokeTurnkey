import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { IOrganisationRepository } from './interfaces/organisation.repository.interface';
import { Organisation, NewOrganisation, organisations } from '../schema/organisations';
import { eq } from 'drizzle-orm';

@Injectable()
export class OrganisationRepository implements IOrganisationRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findById(id: string): Promise<Organisation | undefined> {
        const result = await this.db.select().from(organisations).where(eq(organisations.id, id));
        return result[0];
    }

    async findBySlug(slug: string): Promise<Organisation | undefined> {
        const result = await this.db.select().from(organisations).where(eq(organisations.slug, slug));
        return result[0];
    }

    async create(data: NewOrganisation): Promise<Organisation> {
        const result = await this.db.insert(organisations).values(data).returning();
        return result[0];
    }
}
