import { AuditLog, NewAuditLog } from '../../schema/audit-log';

export interface IAuditLogRepository {
  create(data: NewAuditLog): Promise<AuditLog>;
}
