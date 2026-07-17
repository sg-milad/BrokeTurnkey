import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../database.module';
import { IAuditLogRepository } from '../repositories/interfaces/audit-log.repository.interface';
import { AuditLog, NewAuditLog, audit_log } from '../schema/audit-log';

@Injectable()
export class AuditLogRepository implements IAuditLogRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async create(data: NewAuditLog): Promise<AuditLog> {
        const result = await this.db.insert(audit_log).values(data).returning();
        return result[0];
    }
}
