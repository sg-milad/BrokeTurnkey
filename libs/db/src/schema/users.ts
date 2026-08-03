import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    external_id: varchar('external_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    role: varchar('role', { length: 30 }).notNull().default('member'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('uq_users_org_external').on(t.org_id, t.external_id)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
