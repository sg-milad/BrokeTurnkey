import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { ISigningRequestRepository } from '../repositories/interfaces/signing-request.repository.interface';
import { SigningRequest, NewSigningRequest, signing_requests } from '../schema/signing-requests';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../constants';
@Injectable()
export class SigningRequestRepository implements ISigningRequestRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findById(id: string): Promise<SigningRequest | undefined> {
        const result = await this.db.select().from(signing_requests).where(eq(signing_requests.id, id));
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
        const result = await this.db.insert(signing_requests).values(data).returning();
        return result[0];
    }
}
