# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /workspace
ENV NX_DAEMON=false NX_ISOLATE_PLUGINS=false
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY libs/contracts/package.json libs/contracts/package.json
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY nx.json tsconfig.base.json ./
COPY libs/contracts libs/contracts
COPY apps/backend apps/backend
RUN pnpm exec nx build backend
RUN pnpm --filter @acme/backend deploy --prod /prod/backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/dist/apps/backend/ ./
COPY --from=build --chown=node:node /prod/backend/node_modules ./node_modules
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "main.cjs"]
