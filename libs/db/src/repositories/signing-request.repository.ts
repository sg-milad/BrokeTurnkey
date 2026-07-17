import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../database.module';
import { ISigningRequestRepository } from '../repositories/interfaces/signing-request.repository.interface';
import { SigningRequest, NewSigningRequest, signing_requests } from '../schema/signing-requests';
import { eq } from 'drizzle-orm';

@Injectable()
export class SigningRequestRepository implements ISigningRequestRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findById(id: string): Promise<SigningRequest | undefined> {
        const result = await this.db.select().from(signing_requests).where(eq(signing_requests.id, id));
        return result[0];
    }

    async create(data: NewSigningRequest): Promise<SigningRequest> {
        const result = await this.db.insert(signing_requests).values(data).returning();
        return result[0];
    }
}
