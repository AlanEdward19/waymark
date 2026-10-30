# syntax=docker/dockerfile:1.7
# Alpine (musl) instead of Debian: 311 MB vs 513 MB on disk, 71 MB vs 114 MB compressed (git alone: ~15 MB vs ~100 MB).
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache build-base sqlite-dev
# .npmrc sets ignore-scripts so better-sqlite3 uses its prebuilt musl binary (no C++ toolchain).
COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# sqlite-vec only ships glibc binaries on npm, so build its single-file amalgamation for musl.
# Pinned to the same version as package.json; checksum verified by BuildKit.
ADD --checksum=sha256:3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61 \
    https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-amalgamation.tar.gz \
    /tmp/sqlite-vec.tar.gz
RUN arch="$(node -p process.arch)" \
 && mkdir /tmp/vec && tar -xzf /tmp/sqlite-vec.tar.gz -C /tmp/vec \
 # it uses u_int8_t & co. without including sys/types.h (fine on glibc, not on musl)
 && gcc -O3 -fPIC -shared -D_GNU_SOURCE -include sys/types.h /tmp/vec/sqlite-vec.c \
      -o "node_modules/sqlite-vec-linux-$arch/vec0.so" -lm \
 # better-sqlite3 ships SQLite sources and prebuilds for every platform; keep this arch (musl)
 && cd node_modules/better-sqlite3 \
 && rm -rf deps src \
 && find prebuilds -type f ! -name "linuxmusl-$arch.node" -delete

FROM node:24-alpine
RUN apk add --no-cache git \
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
