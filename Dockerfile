# ---- base ----
FROM node:20-alpine AS base
RUN npm install -g pnpm
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY libs/vault/package.json ./libs/vault/
COPY libs/wallet/package.json ./libs/wallet/
COPY libs/gas/package.json ./libs/gas/
COPY libs/policy/package.json ./libs/policy/
COPY libs/auth/package.json ./libs/auth/
RUN pnpm install --frozen-lockfile

# ---- development (used by docker compose) ----
FROM deps AS development
COPY . .
EXPOSE 3000
CMD ["pnpm", "run", "start:dev"]

# ---- build ----
FROM deps AS builder
COPY . .
RUN pnpm run build

# ---- production ----
FROM node:20-alpine AS production
RUN npm install -g pnpm
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/apps/api/main"]
