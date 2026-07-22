import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';

export const organization_seeds = pgTable('organization_seeds', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id: uuid('org_id').notNull().unique().references(() => organizations.id),
  encrypted_seed: text('encrypted_seed').notNull(),
  seed_nonce: text('seed_nonce').notNull(),
  encrypted_dek: text('encrypted_dek').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_org_seeds_org').on(t.org_id),
]);

export type organizationSeed = typeof organization_seeds.$inferSelect;
export type NeworganizationSeed = typeof organization_seeds.$inferInsert;
