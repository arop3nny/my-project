# syntax=docker/dockerfile:1
FROM node:25-alpine AS build
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
COPY apps/frontend apps/frontend
RUN pnpm exec nx build frontend

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/dist/apps/frontend/ /usr/share/nginx/html/
USER 101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
