import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';
import { users } from './users';

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id: uuid('org_id').notNull().references(() => organisations.id),
  user_id: uuid('user_id').references(() => users.id), // nullable — system wallets have no user
  label: varchar('label', { length: 100 }),
  address: varchar('address', { length: 42 }).notNull(),
  derivation_path: varchar('derivation_path', { length: 50 }).notNull(),
  chain_id: integer('chain_id').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_wallets_org_address').on(t.org_id, t.address),
  uniqueIndex('uq_wallets_org_path').on(t.org_id, t.derivation_path),
  index('idx_wallets_user_id').on(t.user_id),
]);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
