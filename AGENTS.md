# WalletMVP (wallet2)

Self-hosted, zero-cost custodial Wallet-as-a-Service (Turnkey-inspired, MVP/learning
reference). NestJS API (`apps/api`) coordinates wallets, gas, nonces, and broadcast;
a Go crypto sidecar (`cmd/crypto`) is the only component that touches key material
(BIP39/BIP32, AES-256-GCM, RLP, secp256k1 signing); HashiCorp Vault Transit (Docker,
port 8200) wraps DEKs via a single `wallet-signer` AppRole; Postgres (port 5432)
stores ciphertext only. NestJS never holds a Vault token or plaintext key. Every
client request is authenticated by a P-256 "stamp" header — see docs/STAMP_AUTH.md.

## Dev environment

- pnpm workspace (pnpm@11.20.0 via `packageManager`). Never use npm/yarn; install with `pnpm install --frozen-lockfile`. Node 22 in CI.
- Copy `.env.example` to `.env` (gitignored; `.env*` is ignored, `.env.example` is force-added). Required: `POSTGRES_PASSWORD`, `CRYPTO_AUTH_TOKEN` (`openssl rand -hex 32`), `VAULT_ROLE_ID`, `VAULT_SECRET_ID`. Compose refuses to start without `POSTGRES_PASSWORD`.
- Full stack: `docker compose up -d` (Postgres + Vault). Vault init/unseal runbook: docs/VAULT_INIT.md, scripts/unseal.sh.
- Local `.env`, `.env.crypto`, `.env.vault` exist on dev machines — never read, print, or commit them.

## Build & test

- `pnpm run build` — nest build
- `pnpm run test` — jest, ts-jest, all `*.spec.ts` under apps/ and libs/ (`pnpm run test:cov` for coverage)
- `pnpm run lint` — eslint `--fix`; repo-wide pre-existing debt, CI runs it non-blocking (`continue-on-error`)
- `pnpm run format` — prettier `--write apps/**/*.ts libs/**/*.ts`
- `pnpm run db:push` / `pnpm run db:studio` — drizzle-kit, requires `TS_NODE_PROJECT=drizzle.tsconfig.json` (already in the scripts)
- Go: `go vet ./...` and `go test ./... -count=1` in `cmd/crypto` (module `wallet`, go 1.24). Vault integration tests self-skip unless `VAULT_ADDR`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID` are set (see `cmd/crypto/vault_test.go` loadEnv); CI provisions a throwaway Vault with `scripts/ci-vault-setup.sh`.
- CI (`.github/workflows/ci.yml`) runs go-tests, go-tests-vault (services: hashicorp/vault:1.17, `VAULT_DEV_ROOT_TOKEN_ID: root`), and nest-tests (build + jest + non-blocking lint).

## Docs (read before touching the relevant area)

docs/ is the contract — code that diverges from it is a bug, not a docs problem.

- docs/ARCHITECTURE.md — every component, what it does/does not do, communication map. Start here.
- docs/HOW_IT_WORKS.md — runtime walkthrough of the four services and why each boundary exists.
- docs/STAMP_AUTH.md — P-256 stamp auth spec: X-Stamp construction, replay protection. Read before touching libs/auth or any guard.
- docs/KEY_MANAGEMENT.md — key hierarchy, crypto decisions, security guarantees and limits.
- docs/CRYPTO_SERVICE.md — Go sidecar API reference + auth-token guide. Read before changing cmd/crypto or libs/crypto-client.
- docs/API.md — API reference with worked curl examples; scripts/api/* has bash request helpers.
- docs/SEQUENCE_DIAGRAMS.md — Mermaid flows for every operation.
- docs/VAULT.md / docs/VAULT_INIT.md — Vault concepts/runtime behaviour; VAULT_INIT is the step-by-step init runbook (init once, unseal on restart).
- docs/ERC4337_SMART_ACCOUNTS.md — smart-account integration guide; read before any ERC-4337 work.
- docs/TASKS.md — phased engineering roadmap with per-phase definition-of-done.
- docs/schema.dbml — database schema reference.

## Conventions

- Path aliases: `@app/<lib>` → `libs/<lib>/src` (tsconfig `paths` + jest `moduleNameMapper`). Add both when adding a lib.
- libs export their public surface via `src/index.ts` (`export * from ...`); libs carry their own `tsconfig.lib.json`, app carries `tsconfig.app.json`.
- DB schema lives in `libs/db/src/schema` (Drizzle, 9 tables: wallets, api-keys, audit_log, nonces, etc.); repositories in `libs/db/src/repositories`. `drizzle.config.ts` is the kit config.
- Prettier: single quotes, trailing commas.
- Commit messages: conventional commits (`ci:`, `fix:`, `build(deps):`, ...). Docs (docs/*.md) are treated as the contract — code-vs-docs divergences are bugs.
- Security findings are tracked in SECURITY_AUDIT.md at repo root with `[ ]`/`[x]` status checkboxes; CRITICALs C-1..C-3 are still open (EIP-712 signing allowlist defaults to allow-all, split env files, rotate leaked AppRole SecretID). Fix in severity batches; update the status boxes.

## Pitfalls

- TypeScript must stay on 5.x. TypeScript 7 (the Go port) lacks the compiler API that Nest CLI, ts-jest, and typescript-eslint require — tooling breaks.
- `pnpm run test:e2e` points at a stale path (`./apps/wallet2/test/jest-e2e.json`); the real config is `apps/api/test/jest-e2e.json`. Fix the script before relying on e2e.
- `pnpm run lint` uses `--fix` — it rewrites files, not just reports.
- Do not add plaintext key handling to the NestJS side or broaden the Go service's signing surface (it is a pure signing oracle by design — policy/allowlist gating belongs in NestJS, see C-1).
- dist/, node_modules/, and all `.env*` files are gitignored.
