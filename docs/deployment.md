# Deployment Guide

This guide covers deploying the GitLab MCP server to a production environment
using Docker Compose.

## Overview

The stack consists of two services:

- **app** — the Node.js MCP server (stateless).
- **postgres** — durable storage for users, OAuth accounts, sessions, audit logs.

Migrations are applied automatically on app startup via the container
entrypoint, which runs `prisma migrate deploy`.

## Required production configuration

Set these in your `.env` (or your orchestrator's secret store) before deploying:

| Variable | Production requirement |
|----------|------------------------|
| `POSTGRES_PASSWORD` | A **strong, unique** password. Do not use the example default. |
| `ENCRYPTION_KEY` | A **unique** 32-byte key (`openssl rand -hex 32`). See the rotation warning below. |
| `PUBLIC_BASE_URL` | The real public **HTTPS** URL, e.g. `https://gitlab-mcp.example.com`. |
| `GITLAB_REDIRECT_URI` | `${PUBLIC_BASE_URL}/auth/callback`, and must match the GitLab OAuth app exactly. |
| `GITLAB_BASE_URL` | Your GitLab instance origin (gitlab.com or self-hosted). |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | From the GitLab OAuth application. |
| `NODE_ENV` | `production`. |

### ⚠️ Rotating `ENCRYPTION_KEY`

GitLab access/refresh tokens are encrypted at rest with `ENCRYPTION_KEY`. If you
**change** this key, all previously stored tokens become **undecryptable**.
There is no migration path for the old ciphertext — every user must log in
again via `/auth/login` to re-establish their GitLab tokens. Plan key rotation
as a coordinated event and communicate it to users.

## TLS / reverse proxy

**Bearer tokens must only travel over HTTPS.** Run the app behind a
TLS-terminating reverse proxy (nginx, Traefik, Caddy, or a cloud load
balancer):

- Terminate TLS at the proxy and forward to the app's port `3000`.
- Set `PUBLIC_BASE_URL` to the public `https://` URL so the redirect URI and the
  connection instructions shown to users are correct.
- Forward the `Authorization` header through to the app.
- Do **not** expose the app's plain HTTP port directly to the internet.

Example (Traefik labels or nginx `proxy_pass http://app:3000;`) — terminate TLS,
then proxy to the `app` service.

## Persistence & backups

Two named volumes hold durable state:

- `pgdata` — PostgreSQL data: users, encrypted OAuth accounts, sessions, and
  **audit logs**.

Back up PostgreSQL regularly (it holds the audit trail and account records):

```bash
docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql
```

Store backups securely — they contain encrypted tokens (still protected by
`ENCRYPTION_KEY`) and the audit log.

## Scaling

The server keeps **all** state in PostgreSQL — sessions, OAuth accounts, and
the ephemeral OAuth stores (state, PKCE verifiers, pending authorize requests,
authorization codes) all live in the database, not in an in-process cache.
There is no shared cache layer to keep in sync across processes, so run a
**single app instance**. The state that must survive an app restart lives in
PostgreSQL; the environment that must stay stable across a restart is
`DATABASE_URL` and `ENCRYPTION_KEY` — if either changes, sessions and
previously stored tokens become unusable.

To avoid concurrent `migrate deploy` races at startup if you do run more than
one container transiently (e.g. during a rolling redeploy), run migrations as
a one-shot job before starting new instances, or ensure only one instance runs
the entrypoint migration step.

## Health checks

The app exposes `GET /healthz`, returning `{ "status": "ok" }`. Point your load
balancer / orchestrator liveness and readiness probes at this endpoint.

## Observability

- The app logs to stdout/stderr — collect via your container log driver.
- The `audit_logs` table is the authoritative record of tool usage: timestamp,
  user, GitLab username, tool name, sanitized parameters, result, and execution
  time. Query it for operational and security insight.

## Tuning

| Variable | Guidance |
|----------|----------|
| `SESSION_TTL_HOURS` | Lower for tighter security (more frequent re-login), higher for convenience. Default 168h (7 days). |
| `TOKEN_REFRESH_SKEW_SECONDS` | How early to refresh GitLab tokens before expiry. Increase if you see occasional expiry races under load. |

## Database migrations

Two migrations ship with this server:

- `0001_init` — baseline schema (users, oauth_accounts, sessions, audit_logs).
- `20260626000000_mcp_oauth_client_tokens` — adds MCP OAuth client token tables.

**Fresh database:** `prisma migrate deploy` runs both migrations automatically
(the container entrypoint does this on every startup).

**Existing database that predates the migrations directory** (i.e. the tables
already exist but `_prisma_migrations` is absent or empty): the `0001_init`
migration would fail with "relation already exists". Baseline it first:

```bash
# Mark 0001_init as already applied, then run only the delta migration.
npx prisma migrate resolve --applied 0001_init
npx prisma migrate deploy
```

This tells Prisma that the init schema is already in place and applies only the
`20260626000000_mcp_oauth_client_tokens` delta.

## Deploy

```bash
# with a production .env in place
docker compose up -d --build
```

Verify:

```bash
curl -fsS https://gitlab-mcp.example.com/healthz
```
