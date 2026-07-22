import { pgTable, uuid, varchar, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';

export const policies = pgTable('policies', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  rule_type: varchar('rule_type', { length: 50 }).notNull(),
  rule_config: jsonb('rule_config').notNull(),
  applies_to: varchar('applies_to', { length: 20 }).notNull().default('all'),
  target_id: uuid('target_id'),
  priority: integer('priority').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('idx_policies_org_id').on(t.org_id),
  index('idx_policies_org_status').on(t.org_id, t.status),
]);

export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
