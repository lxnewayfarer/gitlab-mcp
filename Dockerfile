# ── Build stage ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install deps (incl. dev) using the lockfile.
COPY package.json package-lock.json* ./
RUN npm ci

# Generate Prisma client, then build TypeScript.
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production deps stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

# ── Runtime stage ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh && chown -R node:node /app

# Run as the non-root node user.
USER node

EXPOSE 3000
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "dist/index.js"]
