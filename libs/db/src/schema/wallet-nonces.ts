import { pgTable, uuid, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets';

export const wallet_nonces = pgTable('wallet_nonces', {
  id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  wallet_id:  uuid('wallet_id').notNull().unique().references(() => wallets.id),
  chain_id:   integer('chain_id').notNull(),
  nonce:      integer('nonce').notNull().default(0),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_nonces_wallet_chain').on(t.wallet_id, t.chain_id),
]);

export type WalletNonce    = typeof wallet_nonces.$inferSelect;
export type NewWalletNonce = typeof wallet_nonces.$inferInsert;
