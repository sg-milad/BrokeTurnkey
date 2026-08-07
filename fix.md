# Auth Guard & Controller Review — Fix Tracker

## Critical Issues

- [x] **1. StampVerifierGuard: Raw body access is fragile** — ALREADY FIXED
  - `main.ts` lines 16-23 use `express.json({ verify: ... })` to capture `req.rawBody` before parsing. No action needed.

- [x] **2. ApiKeysController: Bootstrap token flow is broken** — ALREADY FIXED
  - Controller has `@Public()` + `@UseGuards(OptionalStampVerifierGuard)` at line 44-45.
  - `auth.service.ts` accepts `bootstrapToken` and `requestingKeyId` params with proper validation.
  - Docs are stale; code is correct.

- [x] **3. ScopesGuard: Missing scope enforcement on several routes** — FIXED
  - Added `@Scopes('wallet:create')` to `POST /wallets`
  - Added `@Scopes('wallet:sign')` to all 4 signing endpoints (`sign-transaction`, `sign`, `sign-typed`, `sign-message`)
  - Existing decorators verified correct: `key:write` on api-keys create/revoke, users create/delete; `policy:write` on policies create/delete; `@Public()` on org creation.
  - Build passes, lint clean, all tests pass.

## High Severity

- [ ] **4. StampVerifierGuard: Timestamp validation window**
  - Verify implementation uses milliseconds (not seconds) and exactly 5min past / 30s future tolerance.

- [ ] **5. StampVerifierGuard: Signature length check**
  - Per spec: reject if decoded signature outside 68–75 bytes (DER P-256) BEFORE attempting crypto verification.

- [ ] **6. Rate limiting: In-memory storage warning**
  - File: `libs/auth/src/api-key-throttler.guard.ts`
  - In-memory storage means rate limits are per-instance when running >1 replica. Add TODO/comment or migrate to Redis.

- [ ] **7. OrganizationsController: POST /organizations must be @Public()**
  - Org creation is the entry point with no existing API key. Must have `@Public()` decorator.

## Medium Severity

- [ ] **8. User decorator: Type safety**
  - Ensure property names in `user.decorator.ts` match what `StampVerifierGuard` attaches (`orgId`, `apiKeyId`, `keyId`, `scopes`).

- [ ] **9. Auth service spec is a stub**
  - File: `libs/auth/src/auth.service.spec.ts`
  - Only tests "should be defined". No coverage for bootstrap validation, scope checking, key revocation.

- [ ] **10. Logging interceptor: Sensitive data leakage risk**
  - File: `apps/api/src/common/logging.interceptor.ts`
  - Verify it does NOT log X-Stamp values, X-Bootstrap-Token, encrypted seed material, or public keys.

## Low Severity

- [ ] **11. StampVerifierGuard: last_used_at update must be fire-and-forget**
  - Verify DB update doesn't await inside `canActivate`.

- [ ] **12. Error message consistency**
  - Cross-reference guard error messages against exact strings in `docs/STAMP_AUTH.md` error table.

- [ ] **13. GET endpoints and empty body signing**
  - Verify guard handles empty/missing body correctly, producing SHA-256("") = `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`.
