# ── Stage 1: Build ──────────────────────────────────────────────
FROM oven/bun:1-debian AS builder

WORKDIR /build

# Install deps first (layer cache)
COPY server/package.json ./server/
RUN cd server && bun install

# Copy source
COPY server/ ./server/

# Build server (esbuild bundle)
RUN cd server && bun run build:server

# Build client (Next.js static export)
RUN cd server && bunx --bun next build

# Build standalone binary (compiles src/index.ts into standalone executable)
RUN cd server && bun run build.ts --binary

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled binary + static frontend assets
COPY --from=builder /build/server/dist/gantry ./gantry
COPY --from=builder /build/server/dist/public/ ./dist/public/


# Copy setup script
COPY server/scripts/gantry-setup.ts ./scripts/gantry-setup.ts

ENV FLEET_DIR=/data
ENV PORT=3100
ENV GANTRY_PUBLIC_DIR=/app/dist/public

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

VOLUME /data

ENTRYPOINT ["tini", "--"]
CMD ["./gantry"]
