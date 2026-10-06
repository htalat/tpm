# One image for every component; the compose service chooses the entrypoint.
# MVP note: TypeScript runs through tsx at runtime. A hardened build would
# bundle (esbuild) to plain JS and drop dev dependencies.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/
COPY packages/observability/package.json packages/observability/
COPY packages/testkit/package.json packages/testkit/
COPY apps/api/package.json apps/api/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY examples/package.json examples/
RUN npm ci --include=dev
COPY . .
USER node
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
