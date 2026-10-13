# GripRead server: the web version and the hub devices sync with.
# docker build -t gripread . && docker run -p 8080:8080 -v gripread:/data gripread

FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json tsconfig.native.json vite.config.ts tailwind.config.js postcss.config.js components.json ./
COPY src src
# CI passes the build's version (0.3.0-dev.17) for the page to show.
ARG GRIPREAD_VERSION
RUN if [ -n "$GRIPREAD_VERSION" ]; then npm pkg set version="$GRIPREAD_VERSION"; fi \
    && pnpm build

FROM rust:1-bookworm AS server
WORKDIR /src
# Every workspace member's manifest and sources are needed to resolve the
# workspace; only the server is built.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY src-tauri src-tauri
RUN cargo build --release --locked -p gripread-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1000 --home /data gripread \
    && mkdir -p /data \
    && chown gripread /data
COPY --from=server /src/target/release/gripread-server /usr/local/bin/gripread-server
COPY --from=web /src/dist /app/web
ENV GRIPREAD_DATA=/data GRIPREAD_WEB=/app/web GRIPREAD_PORT=8080
VOLUME /data
EXPOSE 8080
USER gripread
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["gripread-server"]
