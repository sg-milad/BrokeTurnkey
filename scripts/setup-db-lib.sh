#!/usr/bin/env bash
# ============================================================
# WalletMVP — Task 1.4: libs/db scaffold + wiring script
# Run from repo root: bash scripts/setup-db-lib.sh
# ============================================================
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# 1. libs/db directory structure
# ─────────────────────────────────────────────────────────────
mkdir -p libs/db/src/schema

# ─────────────────────────────────────────────────────────────
# 2. libs/db/package.json
# ─────────────────────────────────────────────────────────────
cat > libs/db/package.json << 'EOF'
{
  "name": "@walletmvp/db",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "drizzle-orm": "^0.39.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
EOF

# ─────────────────────────────────────────────────────────────
# 3. libs/db/tsconfig.lib.json
# ─────────────────────────────────────────────────────────────
cat > libs/db/tsconfig.lib.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "outDir": "../../dist/libs/db"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*spec.ts"]
}
EOF

# ─────────────────────────────────────────────────────────────
# 4. Schema files
# ─────────────────────────────────────────────────────────────

cat > libs/db/src/schema/organisations.ts << 'EOF'
import { pgTable, uuid, varchar, timestamptz } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const organisations = pgTable('organisations', {
  id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name:       varchar('name', { length: 255 }).notNull(),
  slug:       varchar('slug', { length: 100 }).notNull().unique(),
  status:     varchar('status', { length: 20 }).notNull().default('active'),
  plan:       varchar('plan', { length: 50 }).notNull().default('starter'),
  created_at: timestamptz('created_at').notNull().default(sql`now()`),
  updated_at: timestamptz('updated_at').notNull().default(sql`now()`),
});

export type Organisation    = typeof organisations.$inferSelect;
export type NewOrganisation = typeof organisations.$inferInsert;
EOF

cat > libs/db/src/schema/users.ts << 'EOF'
import { pgTable, uuid, varchar, timestamptz, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';

export const users = pgTable('users', {
  id:          uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:      uuid('org_id').notNull().references(() => organisations.id),
  external_id: varchar('external_id', { length: 255 }).notNull(),
  email:       varchar('email', { length: 255 }),
  role:        varchar('role', { length: 30 }).notNull().default('member'),
  status:      varchar('status', { length: 20 }).notNull().default('active'),
  created_at:  timestamptz('created_at').notNull().default(sql`now()`),
  updated_at:  timestamptz('updated_at').notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_users_org_external').on(t.org_id, t.external_id),
]);

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
EOF

cat > libs/db/src/schema/api-keys.ts << 'EOF'
import { pgTable, uuid, varchar, timestamptz, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';

export const api_keys = pgTable('api_keys', {
  id:           uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:       uuid('org_id').notNull().references(() => organisations.id),
  name:         varchar('name', { length: 100 }).notNull(),
  public_key:   varchar('public_key').notNull().unique(),
  key_id:       varchar('key_id', { length: 64 }).notNull().unique(),
  status:       varchar('status', { length: 20 }).notNull().default('active'),
  last_used_at: timestamptz('last_used_at'),
  expires_at:   timestamptz('expires_at'),
  created_at:   timestamptz('created_at').notNull().default(sql`now()`),
  revoked_at:   timestamptz('revoked_at'),
}, (t) => [
  uniqueIndex('uq_api_keys_key_id').on(t.key_id),
  index('idx_api_keys_org_id').on(t.org_id),
]);

export type ApiKey    = typeof api_keys.$inferSelect;
export type NewApiKey = typeof api_keys.$inferInsert;
EOF

cat > libs/db/src/schema/organisation-seeds.ts << 'EOF'
import { pgTable, uuid, text, bytea, timestamptz, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';

export const organisation_seeds = pgTable('organisation_seeds', {
  id:             uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:         uuid('org_id').notNull().unique().references(() => organisations.id),
  encrypted_seed: bytea('encrypted_seed').notNull(),
  seed_nonce:     bytea('seed_nonce').notNull(),
  encrypted_dek:  text('encrypted_dek').notNull(),
  created_at:     timestamptz('created_at').notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_org_seeds_org').on(t.org_id),
]);

export type OrganisationSeed    = typeof organisation_seeds.$inferSelect;
export type NewOrganisationSeed = typeof organisation_seeds.$inferInsert;
EOF

cat > libs/db/src/schema/wallets.ts << 'EOF'
import { pgTable, uuid, varchar, integer, timestamptz, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';
import { users } from './users';

export const wallets = pgTable('wallets', {
  id:              uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:          uuid('org_id').notNull().references(() => organisations.id),
  user_id:         uuid('user_id').notNull().references(() => users.id),
  label:           varchar('label', { length: 100 }),
  address:         varchar('address', { length: 42 }).notNull(),
  derivation_path: varchar('derivation_path', { length: 50 }).notNull(),
  chain_id:        integer('chain_id').notNull().default(1),
  status:          varchar('status', { length: 20 }).notNull().default('active'),
  created_at:      timestamptz('created_at').notNull().default(sql`now()`),
  updated_at:      timestamptz('updated_at').notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_wallets_org_address').on(t.org_id, t.address),
  uniqueIndex('uq_wallets_org_path').on(t.org_id, t.derivation_path),
  index('idx_wallets_user_id').on(t.user_id),
]);

export type Wallet    = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
EOF

cat > libs/db/src/schema/signing-requests.ts << 'EOF'
import { pgTable, uuid, varchar, text, jsonb, timestamptz, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';
import { wallets } from './wallets';

export const signing_requests = pgTable('signing_requests', {
  id:             uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:         uuid('org_id').notNull().references(() => organisations.id),
  wallet_id:      uuid('wallet_id').notNull().references(() => wallets.id),
  tx_hash:        varchar('tx_hash', { length: 66 }),
  tx_payload:     jsonb('tx_payload'),
  signature:      text('signature'),
  status:         varchar('status', { length: 20 }).notNull().default('pending'),
  failure_reason: text('failure_reason'),
  policy_result:  jsonb('policy_result'),
  created_at:     timestamptz('created_at').notNull().default(sql`now()`),
  signed_at:      timestamptz('signed_at'),
}, (t) => [
  index('idx_signing_requests_wallet_id').on(t.wallet_id),
  index('idx_signing_requests_org_id').on(t.org_id),
  index('idx_signing_requests_tx_hash').on(t.tx_hash),
]);

export type SigningRequest    = typeof signing_requests.$inferSelect;
export type NewSigningRequest = typeof signing_requests.$inferInsert;
EOF

cat > libs/db/src/schema/wallet-nonces.ts << 'EOF'
import { pgTable, uuid, integer, timestamptz, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets';

export const wallet_nonces = pgTable('wallet_nonces', {
  id:         uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  wallet_id:  uuid('wallet_id').notNull().unique().references(() => wallets.id),
  chain_id:   integer('chain_id').notNull(),
  nonce:      integer('nonce').notNull().default(0),
  updated_at: timestamptz('updated_at').notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('uq_nonces_wallet_chain').on(t.wallet_id, t.chain_id),
]);

export type WalletNonce    = typeof wallet_nonces.$inferSelect;
export type NewWalletNonce = typeof wallet_nonces.$inferInsert;
EOF

cat > libs/db/src/schema/policies.ts << 'EOF'
import { pgTable, uuid, varchar, text, jsonb, integer, timestamptz, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';

export const policies = pgTable('policies', {
  id:          uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  org_id:      uuid('org_id').notNull().references(() => organisations.id),
  name:        varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  rule_type:   varchar('rule_type', { length: 50 }).notNull(),
  rule_config: jsonb('rule_config').notNull(),
  applies_to:  varchar('applies_to', { length: 20 }).notNull().default('all'),
  target_id:   uuid('target_id'),
  priority:    integer('priority').notNull().default(0),
  status:      varchar('status', { length: 20 }).notNull().default('active'),
  created_at:  timestamptz('created_at').notNull().default(sql`now()`),
  updated_at:  timestamptz('updated_at').notNull().default(sql`now()`),
}, (t) => [
  index('idx_policies_org_id').on(t.org_id),
  index('idx_policies_org_status').on(t.org_id, t.status),
]);

export type Policy    = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
EOF

cat > libs/db/src/schema/audit-log.ts << 'EOF'
import { pgTable, bigserial, uuid, varchar, text, jsonb, timestamptz, inet, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './organisations';
import { users } from './users';
import { wallets } from './wallets';
import { api_keys } from './api-keys';

export const audit_log = pgTable('audit_log', {
  id:         bigserial('id', { mode: 'bigint' }).primaryKey(),
  org_id:     uuid('org_id').notNull().references(() => organisations.id),
  user_id:    uuid('user_id').references(() => users.id),
  wallet_id:  uuid('wallet_id').references(() => wallets.id),
  api_key_id: uuid('api_key_id').references(() => api_keys.id),
  event:      varchar('event', { length: 60 }).notNull(),
  status:     varchar('status', { length: 20 }).notNull(),
  metadata:   jsonb('metadata'),
  ip_address: inet('ip_address'),
  user_agent: text('user_agent'),
  created_at: timestamptz('created_at').notNull().default(sql`now()`),
}, (t) => [
  index('idx_audit_log_org_id').on(t.org_id),
  index('idx_audit_log_org_event').on(t.org_id, t.event),
  index('idx_audit_log_org_wallet').on(t.org_id, t.wallet_id),
  index('idx_audit_log_created_at').on(t.created_at),
]);

export type AuditLog    = typeof audit_log.$inferSelect;
export type NewAuditLog = typeof audit_log.$inferInsert;
EOF

cat > libs/db/src/schema/index.ts << 'EOF'
export * from './organisations';
export * from './users';
export * from './api-keys';
export * from './organisation-seeds';
export * from './wallets';
export * from './signing-requests';
export * from './wallet-nonces';
export * from './policies';
export * from './audit-log';
EOF

# ─────────────────────────────────────────────────────────────
# 5. db.ts — Drizzle instance factory
# ─────────────────────────────────────────────────────────────
cat > libs/db/src/db.ts << 'EOF'
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

export function createDrizzleClient(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}
EOF

# ─────────────────────────────────────────────────────────────
# 6. database.module.ts — NestJS global module
# ─────────────────────────────────────────────────────────────
cat > libs/db/src/database.module.ts << 'EOF'
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';

export const DRIZZLE_CLIENT = Symbol('DRIZZLE_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DrizzleClient => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        return createDrizzleClient(url);
      },
    },
  ],
  exports: [DRIZZLE_CLIENT],
})
export class DatabaseModule {}
EOF

# ─────────────────────────────────────────────────────────────
# 7. libs/db/src/index.ts — barrel
# ─────────────────────────────────────────────────────────────
cat > libs/db/src/index.ts << 'EOF'
export * from './schema';
export { DatabaseModule, DRIZZLE_CLIENT } from './database.module';
export type { DrizzleClient } from './db';
EOF

echo "✓ libs/db scaffolded"

# ─────────────────────────────────────────────────────────────
# 8. drizzle.config.ts at repo root
# ─────────────────────────────────────────────────────────────
cat > drizzle.config.ts << 'EOF'
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema:  './libs/db/src/schema/index.ts',
  out:     './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
EOF

echo "✓ drizzle.config.ts written"

# ─────────────────────────────────────────────────────────────
# 9. Patch root tsconfig.json — add @walletmvp/db path alias
# ─────────────────────────────────────────────────────────────
node - << 'JSEOF'
const fs      = require('fs');
const path    = require('path');
const file    = path.resolve('tsconfig.json');
const tsconfig = JSON.parse(fs.readFileSync(file, 'utf8'));
tsconfig.compilerOptions.paths['@walletmvp/db'] = ['libs/db/src/index.ts'];
fs.writeFileSync(file, JSON.stringify(tsconfig, null, 2) + '\n');
console.log('✓ tsconfig.json patched — @walletmvp/db alias added');
JSEOF

# ─────────────────────────────────────────────────────────────
# 10. Patch nest-cli.json — add db library entry
# ─────────────────────────────────────────────────────────────
node - << 'JSEOF'
const fs   = require('fs');
const path = require('path');
const file = path.resolve('nest-cli.json');
const cli  = JSON.parse(fs.readFileSync(file, 'utf8'));
cli.projects['db'] = {
  type:       'library',
  root:       'libs/db',
  entryFile:  'index',
  sourceRoot: 'libs/db/src',
};
fs.writeFileSync(file, JSON.stringify(cli, null, 2) + '\n');
console.log('✓ nest-cli.json patched — db project added');
JSEOF

# ─────────────────────────────────────────────────────────────
# 11. Patch apps/api/package.json — add @walletmvp/db dep
# ─────────────────────────────────────────────────────────────
node - << 'JSEOF'
const fs   = require('fs');
const path = require('path');
const file = path.resolve('apps/api/package.json');
const pkg  = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies['@walletmvp/db'] = 'workspace:*';
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('✓ apps/api/package.json patched — @walletmvp/db added');
JSEOF

# ─────────────────────────────────────────────────────────────
# 12. Patch root package.json — add scripts + devDeps
# ─────────────────────────────────────────────────────────────
node - << 'JSEOF'
const fs   = require('fs');
const path = require('path');
const file = path.resolve('package.json');
const pkg  = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.scripts['db:push']   = 'dotenv -e .env -- drizzle-kit push';
pkg.scripts['db:studio'] = 'dotenv -e .env -- drizzle-kit studio';
pkg.devDependencies['drizzle-kit'] = '^0.30.0';
pkg.devDependencies['@types/pg']   = '^8.11.0';
pkg.devDependencies['dotenv-cli']  = '^7.4.2';
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('✓ root package.json patched — db:push script + drizzle-kit added');
JSEOF

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Scaffold complete. Now run:"
echo ""
echo "  1.  pnpm install"
echo "  2.  pnpm db:push"
echo "  3.  docker exec -it walletmvp-postgres psql -U postgres -d walletmvp -c '\dt'"
echo "══════════════════════════════════════════════════════"