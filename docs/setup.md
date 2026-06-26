# Setup Guide

This guide covers running the GitLab MCP server both locally (for development)
and via Docker Compose.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 22+ | Only needed for local (non-Docker) development. |
| npm | 10+ | Ships with Node 22. |
| Docker + Docker Compose | recent | For the Postgres/Redis datastores and/or the full stack. |
| A GitLab OAuth application | — | See [oauth.md](./oauth.md). |

## Environment variables

Copy the example file and edit it:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime environment (`development` / `production`). | `development` |
| `PORT` | Port the HTTP server listens on. | `3000` |
| `PUBLIC_BASE_URL` | Public base URL the server is reached at. Used to build the OAuth redirect and the MCP endpoint URL shown to users. | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string. | `postgresql://gitlab_mcp:gitlab_mcp@localhost:5432/gitlab_mcp?schema=public` |
| `REDIS_URL` | Redis connection string (session cache + OAuth state). | `redis://localhost:6379` |
| `GITLAB_BASE_URL` | Base URL of the GitLab instance. | `https://gitlab.com` |
| `GITLAB_CLIENT_ID` | OAuth Application ID from GitLab. | — (required) |
| `GITLAB_CLIENT_SECRET` | OAuth Application Secret from GitLab. | — (required) |
| `GITLAB_REDIRECT_URI` | OAuth callback URL. Must match the app registration exactly. | `${PUBLIC_BASE_URL}/auth/callback` |
| `GITLAB_SCOPES` | Space-separated OAuth scopes. | `read_user api` |
| `ENCRYPTION_KEY` | 32-byte key (hex or base64) for AES-256-GCM token encryption. | — (required) |
| `SESSION_TTL_HOURS` | Lifetime of issued bearer/session tokens. | `168` (7 days) |
| `TOKEN_REFRESH_SKEW_SECONDS` | Refresh GitLab tokens this many seconds before expiry. | `60` |

### Generating `ENCRYPTION_KEY`

The key must decode to **exactly 32 bytes**. Generate a hex key with:

```bash
openssl rand -hex 32
```

Paste the output into `ENCRYPTION_KEY`. (A base64-encoded 32-byte value also
works, e.g. `openssl rand -base64 32`.)

> ⚠️ Treat this key like a password. If it changes, all previously stored
> GitLab tokens become undecryptable and every user must log in again.

## Local development

Run the datastores in Docker, and the app directly via Node for fast iteration:

```bash
# 1. Start Postgres + Redis only
docker compose up -d postgres redis

# 2. Install dependencies
npm install

# 3. Generate the Prisma client
npm run db:generate

# 4. Apply database migrations (creates tables)
npm run db:migrate

# 5. Run the dev server (watch mode)
npm run dev
```

The server starts on `http://localhost:3000`. Begin the login flow at
`http://localhost:3000/auth/login`.

## Docker (full stack)

To run everything (Postgres, Redis, and the app) in containers:

```bash
docker compose up --build
```

This builds the app image, starts all services, runs migrations automatically
on startup, and exposes the server on `http://localhost:3000`.

## Running migrations

- **Local development:** `npm run db:migrate` (creates and applies migrations).
- **Production / Docker:** migrations are applied automatically on container
  start via the entrypoint, which runs `prisma migrate deploy`. To apply them
  manually: `npm run db:deploy`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|-------------------|
| `Can't reach database server` | Postgres isn't up or `DATABASE_URL` host is wrong. For local dev the host is `localhost`; inside Docker Compose the app uses `postgres` as the host. Run `docker compose ps` to verify health. |
| `ECONNREFUSED` to Redis | Redis isn't running or `REDIS_URL` is wrong. Start it with `docker compose up -d redis`. |
| `ENCRYPTION_KEY must decode to 32 bytes` | The key isn't a valid 32-byte hex/base64 string. Regenerate with `openssl rand -hex 32`. |
| OAuth redirect error / mismatch | `GITLAB_REDIRECT_URI` must exactly match the redirect URI registered on the GitLab OAuth app. See [oauth.md](./oauth.md). |
| Migrations not applied | Ensure the DB is reachable, then run `npm run db:deploy` (or restart the container so the entrypoint runs). |
