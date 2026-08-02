import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { api_keys, NewApiKey, ApiKey } from '../schema/api-keys';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class ApiKeyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async findById(id: string): Promise<ApiKey | undefined> {
    const [apiKey] = await this.db
      .select()
      .from(api_keys)
      .where(eq(api_keys.id, id));
    return apiKey;
  }

  async findByKeyId(keyId: string): Promise<ApiKey | undefined> {
    const [apiKey] = await this.db
      .select()
      .from(api_keys)
      .where(eq(api_keys.key_id, keyId));
    return apiKey;
  }

  async findByOrgId(orgId: string, status?: string): Promise<ApiKey[]> {
    const conditions = [eq(api_keys.org_id, orgId)];
    if (status) {
      conditions.push(eq(api_keys.status, status));
    }
    return this.db
      .select()
      .from(api_keys)
      .where(and(...conditions));
  }

  async create(data: NewApiKey): Promise<ApiKey> {
    const [apiKey] = await this.db.insert(api_keys).values(data).returning();
    return apiKey;
  }

  async update(
    id: string,
    data: Partial<NewApiKey>,
  ): Promise<ApiKey | undefined> {
    const [apiKey] = await this.db
      .update(api_keys)
      .set({ ...data })
      .where(eq(api_keys.id, id))
      .returning();
    return apiKey;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(api_keys).where(eq(api_keys.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async hasScope(keyId: string, requiredScope: string): Promise<boolean> {
    const apiKey = await this.findByKeyId(keyId);
    if (!apiKey || !apiKey.scopes) return false;
    const scopes = apiKey.scopes as string[];
    return scopes.includes(requiredScope);
  }
}
