FROM node:24-bookworm-slim AS build
WORKDIR /app
# .npmrc sets ignore-scripts so better-sqlite3 uses its prebuilt glibc binary (no C++ toolchain).
COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json /app/package.json
# Env-based git config: mounted repos are owned by another uid ("dubious ownership").
ENV WAYMARK_HOME=/data \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*
VOLUME /data
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
