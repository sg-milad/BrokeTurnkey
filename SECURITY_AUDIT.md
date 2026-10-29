# WalletMVP Security Audit Report

- **Date:** 2026-08-21
- **Scope:** Full project — NestJS API (`apps/api`, `libs/*`), Go crypto sidecar (`cmd/crypto`), HashiCorp Vault, PostgreSQL/Drizzle, Docker wiring, scripts, git history.
- **Method:** Docs read first as the contract (STAMP_AUTH, KEY_MANAGEMENT, CRYPTO_SERVICE, ARCHITECTURE, TASKS, VAULT_*), then every claimed security property verified against code. Findings are doc-vs-code divergences and real attack paths, not generic best practices.
- **Status legend:** `[ ]` open, `[~]` partially fixed/mitigated, `[x]` fixed.

---

## CRITICAL

### [C-1] Typed-data signing is an unconstrained signing oracle (allowlist ships empty = allow all)

- **Status:** [~] **PARTIALLY FIXED 2026-10-29** — empty allowlists now deny; all of domain name/chainId/verifyingContract/primaryType must be allowlisted; personal-message signing defaults off. Remaining: typed-data/message paths still do not call `PolicyService.evaluate`.
- **Location:**
  - `libs/wallet/src/signing.service.ts` — `assertEip712Allowed` now denies when any allowlist is empty
  - `.env.example` — `EIP712_*` allowlists default empty (= deny)
  - `libs/wallet/src/signing.service.ts` — `signPersonalMessage` gated by `PERSONAL_MESSAGE_SIGNING_ENABLED` (default false)
  - `apps/api/src/wallets/wallets.controller.ts` — both routes gated by `@Scopes('wallet:sign')` only
- **Attack path:**
  Any API key with `wallet:sign` scope can call `POST /wallets/:id/sign-typed` for any domain/primaryType the operator has allowlisted, and `POST /wallets/:id/sign-message` when personal signing is enabled. NestJS hashes it (viem `hashTypedData` / `hashMessage`), and the Go sidecar signs whatever 32-byte hash it receives (`cmd/crypto/handlers.go` — raw hash signing). With a broad allowlist a compromised key can still create a Permit/Permit2 approval for the allowlisted contract, and neither path runs `PolicyService`.
  Practical exploit: craft an EIP-712 Permit / Permit2 message granting an attacker-controlled address unlimited ERC-20 allowance from the org's wallet, get it signed, submit on-chain. Org token balances drain with no broadcast through the platform, no policy check, and the signature cannot be revoked on-chain.
  Contrast: `requestSign` runs the policy engine (`libs/wallet/src/wallet.service.ts:248-255`), but `signEip712`/`signPersonalMessage` skip policy entirely.
- **Doc-vs-code divergence:** `docs/CRYPTO_SERVICE.md:236-238` and `docs/TASKS.md` Phase 5 claim NestJS gates this with an allowlist — the gate exists but defaults to off, and messages have no gate at all.
- **Fix:**
  1. Default-deny: treat unset/empty `EIP712_DOMAIN_ALLOWLIST` as deny-all, not allow-all.
  2. Validate `domain.chainId` and `domain.verifyingContract` against org-registered contracts, not just the domain name.
  3. Run `PolicyService.evaluate` on both paths; add an explicit allowlist for message prefixes/length for `sign-message`, or disable it by default.
  4. Require EIP-712 `types` to be from an allowlisted set (e.g. Permit, Permit2, SIWE) rather than arbitrary.

### [C-2] Vault master-key shares, root token, and AppRole SecretID are injected into the API container via shared `.env`

- **Status:** [x] **FIXED 2026-10-29** — env split into `.env.api`/`.env.crypto`/`.env.operator`; compose loads only the matching file; Vault is on an internal network reachable only by crypto; dev source mount no longer mounts the repo root; unseal/backup scripts read `.env.operator`.
- **Original location (pre-fix):**
  - `docker-compose.yml` — both `crypto` and `api` loaded `env_file: .env`
  - `.env.example` — `VAULT_UNSEAL_KEY_1..3`, `VAULT_ROOT_TOKEN` slots in the shared `.env`
  - `scripts/unseal.sh` — sourced `.env` and submitted shares 1+2
- **Doc-vs-code divergence:** `docs/ARCHITECTURE.md:271-273` + `docs/CRYPTO_SERVICE.md:43` claim "give each service its own env file so the API container never holds the token it does not need." The shipped compose does the opposite.
- **Attack path:**
  One RCE (or container-env leak via `docker inspect`/logs) in the NestJS API process yields, from its own environment: Vault root token + 2 Shamir unseal shares + AppRole RoleID/SecretID + `CRYPTO_AUTH_TOKEN` + DB password. With root token + shares an attacker can unseal Vault on a cloned data volume, read the KEK, decrypt every DEK, decrypt every org seed, and derive every wallet private key. The entire documented "NestJS has zero Vault access" / "sealed on restart" model collapses from a single app compromise.
- **Fix:**
  1. Split env files: `api.env` (DB, `CRYPTO_AUTH_TOKEN`, `CRYPTO_SERVICE_URL`, RPC keys only); `crypto.env` (+ `VAULT_*`); never put unseal keys/root token in any container env.
  2. Remove `VAULT_UNSEAL_KEY_*` / `VAULT_ROOT_TOKEN` from the `.env` template entirely; unseal from an operator-held secrets manager via `docker exec`, not from a file the containers also load.
  3. Rotate the root token after init; use only the AppRole for runtime.

### [C-3] Vault AppRole SecretID was committed to git history

- **Status:** [ ] — rotation commands documented (`.env.operator` + `wallet-operator` policy), but the historical SecretID must still be destroyed and `CRYPTO_AUTH_TOKEN` rotated.
- **Location:**
  - Commit `e044572` "feat: add go app" tracked `.env.crypto` containing `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` (variable names verified; values not printed)
  - Removed in `1823f37` "fix: Stop tracking .env.crypto" — but remains in history forever
- **Attack path:**
  Anyone with repo history can AppRole-login as `wallet-signer` and encrypt/decrypt any DEK via Transit — i.e. decrypt every org seed (all funds' private keys). Also flag `CRYPTO_AUTH_TOKEN`: if it was ever in a tracked env file, treat it as compromised too.
- **Fix:**
  1. Revoke/re-issue the SecretID in Vault (`approle secret-id destroy`) and rotate `CRYPTO_AUTH_TOKEN` now.
  2. Purge history with `git filter-repo` if the repo ever goes public; treat the credentials as compromised regardless.

### [C-4] API code execution still has a signing path to every org seed

- **Status:** [ ] — mitigated but not eliminated 2026-10-29
- **Location:** `libs/db/src/repositories/organization-seed.repository.ts`; `libs/crypto-client/src/crypto-client.service.ts`; `docker-compose.yml` (API still gets `CRYPTO_AUTH_TOKEN` + DB password)
- **Impact:** the API must hold `CRYPTO_AUTH_TOKEN` and read `organization_seeds` ciphertext at runtime. An attacker with RCE in the API process can call the crypto sidecar directly, bypassing `PolicyService` entirely. Go-side `SIGNER_*` limits (value/chain/destination/selector/gas + hash signing off) and default-deny policies reduce the blast radius, but an in-limit transfer or allowlisted contract call still signs.
- **Remaining fix:** require an out-of-process approval (human/HSM) for signing, or split the API into a policy/signing broker that does not expose a raw signer token to request-handling code. Tracked as architectural debt for the MVP.

---

## HIGH

### [H-1] Rate limiting is bypassable: tracker keys on attacker-controlled key_id BEFORE verification

- **Status:** [x] **FIXED 2026-08-21**
  - `apps/api/src/api.module.ts` — global guard order changed: `StampVerifierGuard` now runs before `ApiKeyThrottlerGuard`.
  - `libs/auth/src/api-key-throttler.guard.ts` — tracker now keys on `request.user.apiKeyId` (the verified identity attached by the stamp guard) and falls back to IP only for unauthenticated/public routes. Fake key_id rotation now gets 401s, not fresh buckets.
- **Location:**
  - `libs/auth/src/api-key-throttler.guard.ts:20-29` — `stamp.split('.')[2]` used verbatim
  - `apps/api/src/api.module.ts:37-39` — throttler registered FIRST, before `StampVerifierGuard`
- **Attack path:**
  Any request with a made-up `key_id` in `X-Stamp` gets its own fresh bucket. An attacker rotating fake key_ids bypasses the 120 req/min limit entirely — unlimited attempts against every endpoint, including the CPU-expensive sign/derive paths (each hits Vault Transit + BIP32 + AES-GCM in Go) and public `POST /organizations` (IP-tracked only). The guard's own comment claims the hole "closes once StampVerifierGuard is enforced globally" — it is global now, but the ordering makes the claim false.
- **Fix:**
  Run `StampVerifierGuard` before the throttler and key the tracker on the verified `request.user.apiKeyId`; use IP only for `@Public` routes; keep a separate stricter IP budget for unauthenticated traffic (edge proxy or in-app).

### [H-2] No policy coverage of calldata, and unbounded value strings enable CPU DoS

- **Status:** [x] **FIXED 2026-10-29** — added `calldata_allowlist` rules and `dataSelector` in the policy payload; Go enforces selector/destination/value/gas limits before decrypt.
  - `libs/wallet/src/wallet.service.ts` — policy payload now includes `dataHash` (SHA-256) and `dataLength`; recorded in policy audit-log metadata.
  - `libs/policy/src/policy.service.ts` — `TxPayload` carries the new fields and supports `calldata_allowlist`; evaluation is default-deny.
  - `apps/api/src/wallets/dto/sign-transaction.dto.ts` — `value` capped at 78 digits (uint256 max), `data` capped at 32 KiB.
  - `cmd/crypto/handlers.go` — Go-side defense in depth: digit-length caps on `value`/`maxFeePerGas`/`maxPriorityFeePerGas` checked BEFORE `big.Int` parsing, `data` capped at 32 KiB.
- **Location:**
  - `libs/wallet/src/wallet.service.ts:243-247` — policy payload = `{ to, value, chainId }`; `data` excluded
  - `apps/api/src/wallets/dto/sign-transaction.dto.ts:24-26` — `value` regex allows unbounded digit length
  - `libs/gas/src/gas.service.ts:46` — `BigInt(value)` on arbitrary-length string
- **Attack path:**
  A `wallet:sign` key can send `value=0` + arbitrary `data` to an allowlisted contract — allowlist/blocklist/spend-limit rules never see the calldata, so token-transfer-via-contract is invisible to policy. Separately, a ~1MB digit string for `value` (body cap is 1 MiB) gets BigInt-parsed in NestJS and Go and RLP-encoded — a CPU/memory spike per request; combined with H-1 this is a cheap CPU DoS. (Go correctly rejects negative values — `cmd/crypto/handlers.go:412-414`.)
- **Fix:**
  Include data hash/length in the policy payload; cap `value` at 78 digits (uint256 max) in the DTO and in Go; add a `data` length cap (e.g. 32KB).

---

## MEDIUM

### [M-1] GET /organizations leaks `bootstrap_token_hash`

- **Status:** [x] **FIXED 2026-08-21**
  - `apps/api/src/organizations/organizations.service.ts` — new `PublicOrganization` type + `toPublicOrg()` sanitizer; `findOne`/`findBySlug`/`create` strip `bootstrap_token_hash` before returning. Controller return types updated; spec updated to assert the strip.
- **Location:** `apps/api/src/organizations/organizations.controller.ts:53-65` + `organizations.service.ts:41-43` (returns the raw org row)
- **Impact:** any authenticated key learns whether the org still has a live bootstrap token pending and its hash. Hash of a UUIDv4 isn't directly usable, but it's internal state that should never leave the API; it also confirms the bootstrap window is open (social-engineering signal).
- **Fix:** strip `bootstrap_token_hash` (and any internal columns) from all org responses; return an explicit `OrganizationDto`.

### [M-2] Wallet derivation index = COUNT race: 500s and silently different wallets on retry

- **Status:** [x] **FIXED 2026-08-21**
  - `libs/wallet/src/wallet.service.ts` — `deriveWallet` now retries on the `uq_wallets_org_path` unique violation (23505): recount, re-derive with the fresh index, up to 3 attempts, then a clean 409 `ConflictException`. A caller can never be told about index N and silently get N+1.
  - Long-term improvement (not done): a per-org atomic counter (e.g. column on `organization_seeds`) would avoid the wasted re-derive under contention.
- **Location:**
  - `libs/wallet/src/wallet.service.ts:109` — `derivIndex = countByOrgId`
  - `libs/db/src/schema/wallets.ts:38` — `uq_wallets_org_path` unique constraint
- **Impact:** two concurrent `POST /wallets` both compute index N; one insert wins, the other hits the unique violation and 500s (unhandled). The client retries → count is now N+1 → a *different* address is derived than the caller was told about. For a custody API this is a correctness/footgun (misrouted funds), and it's attacker-triggerable with two parallel requests.
- **Fix:** derive the index atomically (`INSERT ... SELECT max(index)+1 ... ON CONFLICT` retry), or a per-org counter row with a unique constraint.

### [M-3] Default compose runs the dev target with host repo bind-mounted and Swagger public

- **Status:** [x] **FIXED 2026-08-21**
  - `docker-compose.yml` — api service now builds `target: production`, sets `NODE_ENV: production` (overrides the `.env.example` default), and has no host bind mount / dev command.
  - `docker-compose.dev.yml` — carries the dev overrides (`target: development`, `NODE_ENV: development`, `.:/app` mount, `pnpm run start:dev api`) plus the 8200/5432 port publishes.
  - Both compose files validated with `docker compose config`.
- **Original location (pre-fix):**
  - `docker-compose.yml` — `target: development`, `.:/app` mount, `pnpm run start:dev`
  - `apps/api/src/main.ts` — Swagger enabled when `NODE_ENV !== production`
  - `apps/api/src/config/app.config.ts:4` — `NODE_ENV` defaults to `development`
- **Impact:** the shipped production compose file runs a watch-mode dev server with the host directory writable into the container, and `NODE_ENV` unset → full API schema/docs exposed at `/docs` with zero auth (SwaggerModule registers outside Nest guards). Anyone hitting the box gets a complete route+DTO map; a host-side file write becomes a live code change in the container.
- **Fix:** default `docker-compose.yml` to `target: production` + `NODE_ENV=production`; move dev overrides (bind mount, dev server, `/docs`) into `docker-compose.dev.yml`; remove the `.:/app` mount from the base file.

### [M-4] Node API runs as root in the production image and ships devDependencies

- **Status:** [x] **FIXED 2026-08-21**
  - `Dockerfile` — base pinned to `node:22-alpine` (Node 20 is EOL); production stage installs `pnpm install --prod --frozen-lockfile` (no devDependencies) and runs as `USER node`.
  - Added `.dockerignore` so `.env`, `.env.*`, `backups/`, `dist`, etc. never enter image build contexts.
- **Location:**
  - `Dockerfile:23-30` — no `USER` directive; `CMD ["node", "dist/apps/api/main"]`
  - `Dockerfile:8-9` — `pnpm install --frozen-lockfile` installs devDeps; copied wholesale at `:27`
- **Contrast:** the Go image correctly drops to a non-root user (`Dockerfile.crypto:19-20`).
- **Fix:** add `USER node`; install with `--prod` (or `pnpm prune --prod`) in the production stage; pin base to `node:22-alpine` (Node 20 is EOL since 2026-04).

### [M-5] Vault config: mlock disabled + TLS disabled

- **Status:** [~] **PARTIALLY FIXED 2026-10-29** — Vault is now on a dedicated `vault-internal` network reachable only by crypto; TLS still disabled.
  - `vault/config/vault.hcl` — `disable_mlock` removed (master key can no longer be swapped to disk; `IPC_LOCK` is already granted in compose). **Done.**
  - TLS on the Vault listener: **deferred** — requires runtime cert generation plus Go-client CA trust wiring in `cmd/crypto/vault.go` (it uses bare `http.Post`/`http.NewRequest` with no TLS options today). Shipping half-wired TLS would break Vault startup; revisit with a proper cert story before any multi-host deployment.
- **Location:** `vault/config/vault.hcl` (`tls_disable = true`); `disable_mlock` is now removed.
- **Impact:** with TLS disabled, DEKs (Transit plaintext) and the AppRole SecretID cross the docker bridge in cleartext. `vault-internal` is internal and reachable only by crypto, but any host/container compromise on that bridge still sees traffic.
- **Fix:** enable TLS on the listener (or mTLS). Dedicated network isolation is done.

### [M-6] Backups are one unencrypted bundle of unseal keys + Vault data + Postgres data

- **Status:** [ ]
- **Location:** `scripts/backup.sh` (`.env.operator` copied verbatim as `operator-env.bak` next to `vault-data.tar.gz` and `postgres-data.tar.gz`; `chmod 700` only)
- **Impact:** the backup directory IS the entire platform: unseal shares (`operator-env.bak`) + Vault storage (master key/KEK) + all ciphertext seeds. One copy to a backup bucket or USB = full key extraction by whoever reads it. The script warns, but the design invites it.
- **Fix:** encrypt backups (age/gpg with a key NOT in `.env`), never co-locate unseal keys with data volumes, document offline DR.

---

## LOW

### [L-1] Timestamp parsing accepts trailing garbage

- **Status:** [x] **FIXED 2026-08-21**
  - `libs/auth/src/stamp-verifier.guard.ts` — added `!/^\d{1,16}$/.test(timestampMs)` rejection before `parseInt`, so "\*000x" and leading-zero variants are rejected with a clear 401.
- **Location:** `libs/auth/src/stamp-verifier.guard.ts:52` — `parseInt(timestampMs, 10)` accepts e.g. `"1718000000000x"`
- **Impact:** cosmetic only (payload is reconstructed from the parsed value), but tighten with a `String(timestamp) === timestampMs` round-trip check.

### [L-2] Public-key duplicate check is dead code; no P-256 format validation at registration

- **Status:** [x] **FIXED 2026-08-21**
  - `libs/auth/src/auth.service.ts` — dead `findById(data.publicKey)` pre-check removed; `assertP256PublicKey()` validates that the PEM is a real P-256 SPKI key before it is stored; `23505` unique-violation on `create` is caught and surfaced as a clean `BadRequest` instead of a 500.
- **Location:**
  - `libs/auth/src/auth.service.ts:51` — `findById(data.publicKey)` queries `api_keys.id` with a PEM string → never matches
  - `libs/db/src/schema/api-keys.ts:23` — real duplicate guard is the `public_key` unique constraint, whose `23505` is unhandled → 500
  - `apps/api/src/organizations/dto/create-api-key.dto.ts:25-27` — `publicKey` accepts any string
- **Impact:** garbage keys get stored as dead rows (they can never authenticate); duplicate registration surfaces as a 500 instead of a clean error.
- **Fix:** validate the PEM is a P-256 SPKI (`createPublicKey` + curve OID check) at registration; catch `23505`; remove the dead `findById` check.

### [L-3] `['*']` scope accepted on non-bootstrap key registration

- **Status:** [x] **FIXED 2026-10-29** — wildcard `*` is rejected for all new registrations; bootstrap defaults to management scopes without `wallet:sign`; unknown scopes are rejected; DB default is `[]`.
  - `libs/auth/src/auth.service.ts` — `registerApiKey` rejects `'*'` for every registration, defaults bootstrap to a safe management set, and rejects unknown scopes. DTO/schema docs updated.
- **Location:** `libs/auth/src/auth.service.ts:63-70` — `scopes: data.scopes || ['*']`
- **Impact:** any key with `key:write` can mint a `['*']` (unrestricted) key. Documented as the default, but for defense-in-depth consider forbidding `'*'` on stamp-authenticated registrations (require explicit scopes).

### [L-4] No explicit HTTP timeouts in NestJS → Go and Go → Vault clients

- **Status:** [x] **FIXED 2026-08-21**
  - `libs/crypto-client/src/crypto-client.service.ts` — `fetch` now uses `AbortSignal.timeout(10_000)`.
  - `libs/gas/src/gas.service.ts` — RPC `fetch` calls use `AbortSignal.timeout(10_000)`.
  - `cmd/crypto/vault.go` — all Vault calls (login, token renewal, transit encrypt/decrypt) now use a dedicated `http.Client{Timeout: 10 * time.Second}` instead of `http.DefaultClient`.
- **Location:**
  - `libs/crypto-client/src/crypto-client.service.ts:80-87` — `fetch` with no timeout
  - `cmd/crypto/vault.go:67, 115, 202, 254` — `http.DefaultClient` (bounded only by the Go server's 15s WriteTimeout)
- **Impact:** a hung crypto service hangs API requests indefinitely; a hung Vault hangs signing.
- **Fix:** set explicit timeouts on both clients.

### [L-5] Audit-log IP/user-agent columns never populated

- **Status:** [x] **FIXED 2026-08-21**
  - `libs/db/src/request-context.ts` (new) — `AsyncLocalStorage`-based per-request metadata store.
  - `apps/api/src/main.ts` — middleware captures `req.ip` + `user-agent` before the body parser runs.
  - `libs/db/src/repositories/audit-log.repository.ts` — `create()` reads the context and populates `ip_address` / `user_agent` automatically on every audit row.
- **Location:** `libs/db/src/schema/audit-log.ts:31-32` vs. repositories — `create()` calls never set `ip_address`/`user_agent`
- **Impact:** less data than intended (not a leak); either populate from request context or drop the columns.

### [L-6] Unusual indirect Go dependency; no automated dependency monitoring

- **Status:** [x] **FIXED 2026-08-21**
  - `.github/dependabot.yml` (new) — added weekly scans for npm, gomod, and docker ecosystems with grouped pull requests for NestJS and TypeScript tooling. The Ziren indirect dep is noted; go-ethereum v1.17.4 is a recent version and the dependency is transitive through its KZG/zkVM verifier bundling — expected.
- **Location:** `go.mod:15` — `github.com/ProjectZKM/Ziren/...` (zkVM runtime) pulled via go-ethereum v1.17.4
- **Impact:** supply-chain surface that should be confirmed as expected; security-critical deps (go-ethereum, go-bip32/39, NestJS) have no Dependabot/renovate.
- **Fix:** confirm the Ziren dep is required; add dependency monitoring for both `go.mod` and `package.json`.

### [L-7] No security headers

- **Status:** [x] **FIXED 2026-08-21**
  - `package.json` — added `helmet ^8.3.0`.
  - `apps/api/src/main.ts` — `app.use(helmet({ contentSecurityPolicy: false }))` sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Strict-Transport-Security, and other standard headers. CSP is disabled because the Swagger UI in dev needs inline scripts; the API serves JSON, not HTML.
- **Location:** `apps/api/src/main.ts` — no helmet, no CORS policy
- **Impact:** minor behind an edge proxy; add `helmet` for defense-in-depth.

---

## Documentation corrections (not code bugs)

### [D-1] STAMP_AUTH.md "known issue" is stale — bootstrap flow is implemented

- **Status:** [x] **FIXED 2026-08-21**
  - `docs/STAMP_AUTH.md` — the "known issue" blockquote was replaced with a description of the actual implemented bootstrap flow. The scopes-default wording was updated to reflect the L-3 change (bootstrap-only `'*'`).
- **Location:** `docs/STAMP_AUTH.md:346-353` claims `ApiKeysController` passes `undefined` for the bootstrap token and stamp context and the route always returns 400.
- **Reality:** `apps/api/src/organizations/api-keys.controller.ts:62-90` reads `X-Bootstrap-Token` and the stamp context correctly; `AuthService` validates with constant-time compare and nulls the hash (`libs/auth/src/auth.service.ts:157-178, 75-77`).
- **Fix:** update the doc to reflect the implemented flow (and re-check the "Scope enforcement is live on these routes" list against `docs/TASKS.md` Phase 4).

---

## Priority order to fix

1. **C-3** — Rotate the leaked AppRole SecretID + `CRYPTO_AUTH_TOKEN` (do now; already in git history). Commands are in `docs/VAULT_INIT.md`.
2. **C-4** — Design an out-of-process approval boundary for signing; Go limits are mitigation, not elimination.
3. **C-1** — Run policy evaluation on typed-data/message paths (allowlists now default-deny).
4. **M-5/M-6** — Enable Vault TLS and encrypt/decouple backups.
5. Remaining M/L items (DB least privilege/RLS, AppRole per-org isolation).

Suggested first PR: **C-1 + C-2** (default-deny allowlist + policy on typed/message signing + split env files), then one commit per remaining finding.

---

## What's done well (verified in code)

- Guards ARE global (`apps/api/src/api.module.ts:37-39`) — stamp + scopes on every route except `@Public`.
- Raw-body hashing is correct: `express.json` `verify` captures `rawBody` before parse (`apps/api/src/main.ts:16-23`), guard hashes `request.rawBody` (`libs/auth/src/stamp-verifier.guard.ts:85-89`) — the classic re-serialized-JSON hashing bug is NOT present.
- DER signature length check (68-75 bytes) before `verify` (`libs/auth/src/stamp-verifier.guard.ts:100`) — no `verify()` exceptions on garbage.
- Bootstrap flow is real and reachable (controller reads the header, constant-time hash compare, hash nulled after first key).
- Org scoping enforced on every cross-tenant lookup (wallets, users, policies, keys, slug lookup `organizations.controller.ts:81-84`) — no IDOR found on read or write paths.
- Nonce reservation is a single atomic upsert (`libs/db/src/repositories/wallet-nonce.repository.ts:23-37`) — no FOR UPDATE scope bug; idempotency backed by a unique index (`libs/db/src/schema/signing-requests.ts:54`).
- Go sidecar: fail-closed startup, constant-time token compare, 1 MiB body cap, server timeouts, header cap, per-field tx validation, 32-byte hash enforcement, `ZeroBytes` on all key material, non-root user, no published port.
- Vault: AppRole policy scoped to transit encrypt/decrypt of `wallet-dek` only; ports 8200/5432 not published in base compose; DB password has no insecure fallback in compose.
- Policy engine validates rule configs and evaluates before nonce reservation (`libs/policy/src/policy.service.ts`).
- Log sanitizer covers domain-specific fields (publickey, encrypted, dek, bootstrap, nonce, seed, mnemonic) and never logs header names (`apps/api/src/common/logging.interceptor.ts`).
