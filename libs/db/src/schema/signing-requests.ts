import { pgTable, uuid, varchar, text, jsonb, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';
import { wallets } from './wallets';

export const signing_requests = pgTable('signing_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id: uuid('org_id').notNull().references(() => organizations.id),
  wallet_id: uuid('wallet_id').notNull().references(() => wallets.id),
  tx_hash: varchar('tx_hash', { length: 66 }),
  tx_payload: jsonb('tx_payload'),
  signature: text('signature'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  failure_reason: text('failure_reason'),
  error_type: varchar('error_type', { length: 20 }), // 'retryable' | 'permanent' | 'unknown'
  policy_result: jsonb('policy_result'),
  block_number: integer('block_number'),
  gas_used: varchar('gas_used', { length: 50 }),
  effective_gas_price: varchar('effective_gas_price', { length: 50 }),
  idempotency_key: varchar('idempotency_key', { length: 128 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  signed_at: timestamp('signed_at', { withTimezone: true }),
  broadcasted_at: timestamp('broadcasted_at', { withTimezone: true }),
  confirmed_at: timestamp('confirmed_at', { withTimezone: true }),
}, (t) => [
  index('idx_signing_requests_wallet_id').on(t.wallet_id),
  index('idx_signing_requests_org_id').on(t.org_id),
  index('idx_signing_requests_tx_hash').on(t.tx_hash),
  uniqueIndex('uq_signing_requests_idempotency').on(t.idempotency_key),
]);

export type SigningRequest = typeof signing_requests.$inferSelect;
export type NewSigningRequest = typeof signing_requests.$inferInsert;
