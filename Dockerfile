# syntax=docker/dockerfile:1.7
# Alpine (musl) + one bundled JS file: only the two native modules ship as node_modules.
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache build-base sqlite-dev
# .npmrc sets ignore-scripts so better-sqlite3 uses its prebuilt musl binary (no C++ toolchain).
COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# esbuild inlines every pure-JS dependency (Octokit, MCP SDK, zod, yaml) into bundle/cli.mjs
RUN npm run bundle

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
 # runtime tree: the bundle plus the native modules it leaves external
 && mkdir -p /out/node_modules/better-sqlite3 \
 && cp -r node_modules/better-sqlite3/lib node_modules/better-sqlite3/package.json \
      /out/node_modules/better-sqlite3/ \
 && mkdir /out/node_modules/better-sqlite3/prebuilds \
 && cp "node_modules/better-sqlite3/prebuilds/linuxmusl-$arch.node" /out/node_modules/better-sqlite3/prebuilds/ \
 && cp -r node_modules/sqlite-vec "node_modules/sqlite-vec-linux-$arch" /out/node_modules/ \
 && cp bundle/cli.mjs /out/cli.mjs

FROM node:24-alpine
RUN apk add --no-cache git \
 && mkdir /data && chown node:node /data
COPY --from=build /out /app
# Env-based git config: mounted repos are owned by another uid ("dubious ownership").
ENV WAYMARK_HOME=/data \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*
VOLUME /data
USER node
ENTRYPOINT ["node", "/app/cli.mjs"]
CMD ["--help"]
