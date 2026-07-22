import { pgTable, bigserial, uuid, varchar, text, jsonb, timestamp, inet, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';
import { wallets } from './wallets';
import { api_keys } from './api-keys';

export const audit_log = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  org_id: uuid('org_id').notNull().references(() => organizations.id),
  user_id: uuid('user_id').references(() => users.id),
  wallet_id: uuid('wallet_id').references(() => wallets.id),
  api_key_id: uuid('api_key_id').references(() => api_keys.id),
  event: varchar('event', { length: 60 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  metadata: jsonb('metadata'),
  ip_address: inet('ip_address'),
  user_agent: text('user_agent'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('idx_audit_log_org_id').on(t.org_id),
  index('idx_audit_log_org_event').on(t.org_id, t.event),
  index('idx_audit_log_org_wallet').on(t.org_id, t.wallet_id),
  index('idx_audit_log_created_at').on(t.created_at),
]);

export type AuditLog = typeof audit_log.$inferSelect;
export type NewAuditLog = typeof audit_log.$inferInsert;
