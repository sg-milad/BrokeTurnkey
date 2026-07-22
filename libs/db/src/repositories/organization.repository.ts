import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { IorganizationRepository } from './interfaces/organization.repository.interface';
import { organization, Neworganization, organizations } from '../schema/organizations';
import { eq } from 'drizzle-orm';

@Injectable()
export class organizationRepository implements IorganizationRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findById(id: string): Promise<organization | undefined> {
        const result = await this.db.select().from(organizations).where(eq(organizations.id, id));
        return result[0];
    }

    async findBySlug(slug: string): Promise<organization | undefined> {
        const result = await this.db.select().from(organizations).where(eq(organizations.slug, slug));
        return result[0];
    }

    async create(data: Neworganization): Promise<organization> {
        const result = await this.db.insert(organizations).values(data).returning();
        return result[0];
    }
}
