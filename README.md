# GitLab MCP Server (OAuth)

A production-ready **MCP (Model Context Protocol) server** that lets AI agents
interact with GitLab through a **restricted set of 9 tools**. Every user
authenticates with **their own GitLab account via OAuth 2.0** — no Personal
Access Tokens. The server calls the GitLab REST API directly (no `glab` CLI).

```
User → GitLab OAuth Login → MCP Server → GitLab REST API
```

## Features

- **Per-user OAuth 2.0** login (PKCE + `state`), token auto-refresh, logout.
- **MCP-client OAuth (zero token paste)** — the server is its own OAuth 2.0
  Authorization Server: Dynamic Client Registration + authorization-code/PKCE,
  with opaque, rotating refresh tokens (reuse detection revokes the whole
  rotation family). GitLab is the upstream identity provider. Manual bearer-token
  paste remains as a fallback.
- **Server-issued bearer tokens** — the client sends one bearer token; the
  server maps it to that user's GitLab session.
- **Secure token storage** — GitLab tokens encrypted at rest (AES-256-GCM);
  session tokens stored only as sha-256 hashes.
- **Strict tool allowlist** — only the 9 tools below; no raw API proxy, no
  admin/destructive operations.
- **Real GitLab authorization** — every action runs as the authenticated user
  with their own token; project access is checked before each call.
- **Audit logging** — every tool call recorded in PostgreSQL (secrets stripped).
- **Streamable HTTP MCP transport**, PostgreSQL + Prisma, Redis session cache.
- **Docker Compose** one-command deploy. Vitest unit + integration tests.

## The 9 tools

`create_merge_request`, `update_merge_request`, `get_merge_request`,
`list_merge_requests`, `add_comment`, `get_pipeline_status`, `list_pipelines`,
`assign_reviewer`, `set_labels`.

## Quick start (Docker)

1. **Create a GitLab OAuth application** (User Settings → Applications, or an
   instance/group app). See [`docs/oauth.md`](docs/oauth.md) for details.
   - Scopes: `read_user`, `api`
   - Redirect URI: `http://localhost:3000/auth/callback`
   - Copy the **Application ID** and **Secret**.

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # edit .env: set GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET, GITLAB_REDIRECT_URI
   # and generate an encryption key:
   openssl rand -hex 32          # paste into ENCRYPTION_KEY
   ```
   For self-hosted GitLab, also set `GITLAB_BASE_URL`.

3. **Run the stack** (Postgres + Redis + app, migrations run automatically):
   ```bash
   docker compose up --build
   ```

4. **Log in & get your token:** open <http://localhost:3000/auth/login> in a
   browser, authorize with GitLab, and copy the **bearer token** shown.

5. **Configure your MCP client** to use the Streamable HTTP endpoint:
   - URL: `http://localhost:3000/mcp`
   - Header: `Authorization: Bearer <your-token>`

   Example (clients supporting remote HTTP MCP servers with headers):
   ```json
   {
     "mcpServers": {
       "gitlab": {
         "type": "http",
         "url": "http://localhost:3000/mcp",
         "headers": { "Authorization": "Bearer <your-token>" }
       }
     }
   }
   ```

To disconnect: `curl -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer <token>"`.

## Local development (without Docker for the app)

```bash
# Start datastores only:
docker compose up -d postgres redis

cp .env.example .env          # set GitLab creds + ENCRYPTION_KEY
# point DATABASE_URL/REDIS_URL at localhost (the defaults already do)

npm install
npm run db:generate
npm run db:migrate            # creates/apply migrations locally
npm run dev                   # http://localhost:3000
```

## Tests

```bash
npm test
```

GitLab is always mocked — no live calls and no credentials required.

## Documentation

- [Setup guide](docs/setup.md)
- [OAuth configuration guide](docs/oauth.md)
- [Deployment guide](docs/deployment.md)
- [Security review](docs/security.md)
- [Architecture](docs/architecture.md)
- [`CLAUDE.md`](CLAUDE.md) — repo conventions / hard rules for contributors.

## License

MIT
