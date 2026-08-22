# ---- base ----
FROM node:26-alpine AS base
RUN npm install -g pnpm
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- development (used by docker-compose.dev.yml) ----
FROM deps AS development
COPY . .
EXPOSE 3000
CMD ["pnpm", "run", "start:dev"]

# ---- build ----
FROM deps AS builder
COPY . .
RUN pnpm run build

# ---- production ----
# Runs the compiled app as a non-root user with production-only
# dependencies (no devDependencies, no host mount, no watch mode).
FROM node:26-alpine AS production
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/apps/api/main"]
