import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';

export const organisation_seeds = pgTable('organisation_seeds', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id: uuid('org_id').notNull().unique().references(() => organisations.id),
  encrypted_seed: text('encrypted_seed').notNull(),
  seed_nonce: text('seed_nonce').notNull(),
  encrypted_dek: text('encrypted_dek').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_org_seeds_org').on(t.org_id),
]);

export type OrganisationSeed = typeof organisation_seeds.$inferSelect;
export type NewOrganisationSeed = typeof organisation_seeds.$inferInsert;
