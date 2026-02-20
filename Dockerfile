# ── Build stage ────────────────────────────────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

# Install dependencies first (separate layer for caching)
COPY server/package.json server/bun.lockb* ./server/
RUN cd server && bun install --frozen-lockfile

# ── Final image ─────────────────────────────────────────────────────────────
FROM oven/bun:1

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/server/node_modules ./server/node_modules

# Copy source
COPY server/ ./server/
COPY client/ ./client/

WORKDIR /app/server

ENV PORT=15230
EXPOSE 15230

CMD ["bun", "src/index.js"]
