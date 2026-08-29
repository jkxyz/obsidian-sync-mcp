FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY container/package.json ./container/package.json
RUN npm ci --workspace @obsidian-sync-mcp/container --include-workspace-root=false
COPY container/tsconfig.json ./container/tsconfig.json
COPY container/src ./container/src
RUN npm run build --workspace @obsidian-sync-mcp/container

FROM node:22.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOME=/home/ob \
    XDG_CONFIG_HOME=/data/config \
    VAULT_ROOT=/data/vault \
    INDEX_PATH=/data/index.sqlite \
    OBSIDIAN_HEADLESS_COMMAND=/app/node_modules/.bin/ob \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
COPY container/package.json ./container/package.json
RUN npm ci --omit=dev --workspace @obsidian-sync-mcp/container --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/container/dist ./container/dist
RUN mkdir -p /data/vault /data/config /home/ob && chown -R node:node /data /app /home/ob

USER node
EXPOSE 8080
CMD ["node", "container/dist/main.js"]
