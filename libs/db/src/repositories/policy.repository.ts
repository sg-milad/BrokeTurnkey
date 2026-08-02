import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { policies, NewPolicy, Policy } from '../schema/policies';
import { eq, and, desc } from 'drizzle-orm';

@Injectable()
export class PolicyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async findById(id: string): Promise<Policy | undefined> {
    const [policy] = await this.db
      .select()
      .from(policies)
      .where(eq(policies.id, id));
    return policy;
  }

  async findByOrgId(orgId: string, status?: string): Promise<Policy[]> {
    const conditions = [eq(policies.org_id, orgId)];
    if (status) {
      conditions.push(eq(policies.status, status));
    }
    return this.db
      .select()
      .from(policies)
      .where(and(...conditions))
      .orderBy(desc(policies.priority));
  }

  async create(data: NewPolicy): Promise<Policy> {
    const [policy] = await this.db.insert(policies).values(data).returning();
    return policy;
  }

  async update(
    id: string,
    data: Partial<NewPolicy>,
  ): Promise<Policy | undefined> {
    const [policy] = await this.db
      .update(policies)
      .set({ ...data, updated_at: new Date() })
      .where(eq(policies.id, id))
      .returning();
    return policy;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(policies).where(eq(policies.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}
