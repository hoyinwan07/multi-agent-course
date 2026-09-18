# Build context is the Assignment_1_Lumina workspace root (npm workspaces:
# @lumina/gateway depends on @lumina/contract, which must be built first).
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json ./packages/contract/package.json
COPY backend/gateway/package.json ./backend/gateway/package.json
COPY backend/agent/package.json ./backend/agent/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY packages/contract ./packages/contract
COPY backend/gateway ./backend/gateway
RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/contract ./packages/contract
COPY --from=build /app/backend/gateway ./backend/gateway
COPY reports/report.json ./reports/report.json

# The app resolves .env / web/dist / reports relative to process.cwd() assuming
# it runs from backend/gateway/ (as it does in local dev) — match that here.
WORKDIR /app/backend/gateway
EXPOSE 8787
CMD ["node", "dist/index.js"]
