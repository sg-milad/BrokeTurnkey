import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { ISigningRequestRepository } from '../repositories/interfaces/signing-request.repository.interface';
import {
  SigningRequest,
  NewSigningRequest,
  signing_requests,
} from '../schema/signing-requests';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../constants';

interface SigningRequestUpdate {
  tx_hash?: string;
  signature?: string;
  status?: string;
  failure_reason?: string;
  error_type?: string;
  tx_payload?: unknown;
  block_number?: number | null;
  gas_used?: string | null;
  effective_gas_price?: string | null;
  signed_at?: Date;
  broadcasted_at?: Date;
  confirmed_at?: Date;
}

@Injectable()
export class SigningRequestRepository implements ISigningRequestRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async findById(id: string): Promise<SigningRequest | undefined> {
    const result = await this.db
      .select()
      .from(signing_requests)
      .where(eq(signing_requests.id, id));
    return result[0];
  }

  async findByIdempotencyKey(key: string): Promise<SigningRequest | undefined> {
    const result = await this.db
      .select()
      .from(signing_requests)
      .where(eq(signing_requests.idempotency_key, key));
    return result[0];
  }

  async findByOrgId(orgId: string): Promise<SigningRequest[]> {
    return await this.db
      .select()
      .from(signing_requests)
      .where(eq(signing_requests.org_id, orgId))
      .orderBy(desc(signing_requests.created_at));
  }

  async findByWalletId(walletId: string): Promise<SigningRequest[]> {
    return await this.db
      .select()
      .from(signing_requests)
      .where(eq(signing_requests.wallet_id, walletId))
      .orderBy(desc(signing_requests.created_at));
  }

  async create(data: NewSigningRequest): Promise<SigningRequest> {
    const result = await this.db
      .insert(signing_requests)
      .values(data)
      .returning();
    return result[0];
  }
  async update(id: string, fields: SigningRequestUpdate): Promise<void> {
    // Drop undefined values so callers can "clear" a column by passing
    // undefined (e.g. failure_reason when reusing a failed request).
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }

    await this.db
      .update(signing_requests)
      .set(set)
      .where(eq(signing_requests.id, id));
  }
}
