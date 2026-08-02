# Phase 4 Implementation Plan

## What's Been Fixed in TASKS.md

1. ✅ Added `scopes` field requirement to `api_keys` schema
2. ✅ Clarified bootstrap token mechanism (UUID v4, SHA-256 hash, single-use)
3. ✅ Added scope validation requirements to StampVerifier
4. ✅ Specified policy evaluation timing (BEFORE nonce reservation)
5. ✅ Added missing repositories to deliverables
6. ✅ Added AuthService methods to deliverables
7. ✅ Added UserService details
8. ✅ Added database schema prerequisites section

## What's Been Implemented in Code

### Database Schema Updates
- ✅ Added `scopes` field to `libs/db/src/schema/api-keys.ts` (jsonb, default `["tx:sign"]`)
- ✅ Added `bootstrap_token_hash` field to `libs/db/src/schema/organizations.ts`

### New Repositories Created
- ✅ `libs/db/src/repositories/policy.repository.ts` - CRUD for policies
- ✅ `libs/db/src/repositories/api-key.repository.ts` - CRUD for API keys with scope validation
- ✅ Updated `libs/db/src/repositories/index.ts` to export new repositories

## What Still Needs to Be Implemented

### 1. Policy Service (`libs/policy/src/policy.service.ts`)
Currently just an empty class. Needs:
- `createPolicy(orgId, policyData)`
- `listPolicies(orgId)`
- `deletePolicy(orgId, policyId)`
- `evaluate(orgId, walletId, txPayload)` - Main policy engine logic
  - Address blocklist check
  - Address allowlist check
  - Per-transaction spend limit
  - Rolling 24-hour spend window
  - Time lock validation

### 2. Auth Service (`libs/auth/src/auth.service.ts`)
Currently just an empty class. Needs:
- `registerApiKey(orgId, name, publicKey, scopes)`
- `listApiKeys(orgId)`
- `revokeApiKey(orgId, keyId)`
- `validateBootstrapToken(orgId, token)`
- P-256 signature verification logic
- Stamp parsing and validation

### 3. Stamp Verifier Guard (`libs/auth/src/stamp-verifier.guard.ts`)
Currently returns `true` without any checks. Needs:
- Parse `X-Stamp` header
- Validate timestamp (not older than 5 min, not more than 30 sec in future)
- Lookup API key by `key_id`
- Verify ES256 signature
- Check scopes for sensitive operations
- Attach `{ orgId, apiKeyId, scopes }` to request context

### 4. User Service (`libs/users/`)
Doesn't exist yet. Needs:
- Create new lib `libs/users/`
- `UserService` with CRUD methods
- Repository already exists (`user.repository.ts`)

### 5. API Controllers
Need to add routes to existing controllers or create new ones:
- `POST /organizations/:id/policies` - Create policy
- `GET /organizations/:id/policies` - List policies
- `DELETE /organizations/:id/policies/:policyId` - Delete policy
- `POST /organizations/:id/api-keys` - Register API key
- `GET /organizations/:id/api-keys` - List API keys
- `DELETE /organizations/:id/api-keys/:keyId` - Revoke API key
- `POST /organizations/:id/users` - Create user
- `GET /organizations/:id/users` - List users
- `GET /organizations/:id/users/:userId` - Get user
- `DELETE /organizations/:id/users/:userId` - Delete user
- `GET /organizations/:id/audit-log` - Query audit log

### 6. Integration Points
- Integrate PolicyService into WalletService.requestSign() BEFORE nonce reservation
- Apply StampVerifierGuard globally or to specific routes
- Wire audit logging to all relevant events
- Update organization onboarding to generate and return bootstrap token

### 7. Database Migration
Run `pnpm db:push` to apply schema changes:
- Add `scopes` column to `api_keys` table
- Add `bootstrap_token_hash` column to `organizations` table

## Recommended Implementation Order

1. **Database migration** - Apply schema changes first
2. **Auth Service** - Implement stamp verification (needed for all other routes)
3. **Stamp Verifier Guard** - Make it functional
4. **API Key management** - Implement CRUD + bootstrap token flow
5. **Policy Service** - Implement policy engine
6. **User Service** - Implement user management
7. **API Controllers** - Add all Phase 4 routes
8. **Integration** - Wire policy evaluation into signing flow
9. **Audit logging** - Ensure all events are logged
10. **Testing** - End-to-end tests for Phase 4 "Done when" criteria

## Dependencies

- Need P-256 (ES256) crypto library for signature verification (e.g., `@noble/curves` or built-in Node.js crypto)
- Policy evaluation needs access to current time, transaction value, recipient address
- Audit log repository already exists but needs to be called from all relevant services
