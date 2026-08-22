import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../constants';
import { IAuditLogRepository } from '../repositories/interfaces/audit-log.repository.interface';
import { AuditLog, NewAuditLog, audit_log } from '../schema/audit-log';
import { getRequestContext } from '../request-context';
import { eq, desc, and, gte, lte } from 'drizzle-orm';

export interface AuditLogQuery {
  orgId: string;
  event?: string;
  userId?: string;
  walletId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditLogRepository implements IAuditLogRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async create(data: NewAuditLog): Promise<AuditLog> {
    // Attach request metadata (client IP, user agent) captured at the HTTP
    // edge by the middleware in main.ts. Undefined outside HTTP request
    // handling (cron jobs, tests) → columns stay NULL.
    const ctx = getRequestContext();
    const result = await this.db
      .insert(audit_log)
      .values({
        ...data,
        ip_address: ctx?.ip,
        user_agent: ctx?.userAgent,
      })
      .returning();
    return result[0];
  }

  async query(filters: AuditLogQuery): Promise<AuditLog[]> {
    const conditions = [eq(audit_log.org_id, filters.orgId)];

    if (filters.event) {
      conditions.push(eq(audit_log.event, filters.event));
    }
    if (filters.userId) {
      conditions.push(eq(audit_log.user_id, filters.userId));
    }
    if (filters.walletId) {
      conditions.push(eq(audit_log.wallet_id, filters.walletId));
    }
    if (filters.startDate) {
      conditions.push(gte(audit_log.created_at, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(audit_log.created_at, filters.endDate));
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    return this.db
      .select()
      .from(audit_log)
      .where(and(...conditions))
      .orderBy(desc(audit_log.created_at))
      .limit(limit)
      .offset(offset);
  }
}
