# Multi-stage build for the zine hosted image.
#
# Stage 1: build the webapp (Vite) → /dist
# Stage 2: build the hosted Go server → /bin/zine-hosted
# Stage 3: minimal runtime with the binary, the built SPA, and a downloads dir.
#
# Desktop installers (dmg/msi/AppImage) are NOT built here — Tauri can't
# cross-build mac/win/linux in one Linux container. Build them per-platform
# (see apps/client/README.md, "Release builds") and drop them into ./downloads/, which
# is mounted or COPYd into /app/downloads.

# --- stage 1: webapp ------------------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /build
# Copy lockfile + manifest first for layer caching.
COPY apps/client/package.json apps/client/package-lock.json ./apps/client/
RUN cd apps/client && npm ci
# Now copy the rest of the client source and build.
COPY apps/client/ ./apps/client/
RUN cd apps/client && npm run build
# → apps/client/dist

# --- stage 2: hosted Go server -------------------------------------------
# go-sqlite3 (the relay's eventstore) is a CGO library, so the build needs a C
# toolchain. We use the full golang image (Debian-based, gcc present) rather
# than -alpine, and build with CGO_ENABLED=1. The resulting binary is glibc-
# linked, which is why the runtime stage is debian-slim, not alpine.
FROM golang:1.25 AS go-build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
# Cache deps first.
COPY relay/go.mod relay/go.sum ./relay/
COPY relay/cmd ./relay/cmd
RUN cd relay && go mod download
# Build only the hosted entry point (not the desktop sidecar main.go).
RUN cd relay && CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /bin/zine-hosted ./cmd/hosted

# --- stage 3: runtime -----------------------------------------------------
# debian-slim (not alpine): the Go binary links glibc (go-sqlite3 is CGO), so
# it needs a glibc runtime. ca-certificates for outbound wss to other relays.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --uid 10001 --create-home zine
WORKDIR /app

# The hosted server binary.
COPY --from=go-build /bin/zine-hosted /app/zine-hosted

# The built SPA (apps/client/dist).
COPY --from=web-build /build/apps/client/dist /app/dist

# Optional seed downloads. If ./downloads/ exists at build time it's baked in;
# in dev/compose it's volume-mounted over this, so this is just a fallback for
# `docker run` without a mount. The server tolerates an empty/missing dir.
COPY downloads/ /app/downloads/

# Persistent sqlite volume.
RUN mkdir -p /data && chown -R zine:zine /app /data
VOLUME ["/data"]

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB=/data/relay.sqlite3 \
    DIST=/app/dist \
    DOWNLOADS=/app/downloads

EXPOSE 8080
USER zine
ENTRYPOINT ["/app/zine-hosted"]
