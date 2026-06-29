# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## What this is

A production-ready **MCP (Model Context Protocol) server** that lets AI agents
interact with GitLab through a **curated set of tools (17 total)**. Every user
authenticates with their own GitLab account via **OAuth 2.0**. The server calls
**GitLab REST APIs directly** — it does NOT use the `glab` CLI.

```
User → GitLab OAuth Login → MCP Server → GitLab REST API
```

## Tech stack

- TypeScript, Node.js 22+ (ESM)
- MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
- Express (HTTP layer + MCP Streamable HTTP transport)
- PostgreSQL + Prisma ORM
- Redis (session cache)
- Vitest (tests), Docker Compose (deploy)

## Architecture (clean / layered)

```
src/
  config/         env loading & validation (zod) — import from here, never read process.env elsewhere
  database/       prisma + redis client singletons
  auth/           OAuth flow, PKCE, session service, AES-256-GCM crypto, token refresh
  services/       GitLabService — the ONLY place allowed to call the GitLab REST API
  repositories/   Prisma data-access (user, oauthAccount, session, auditLog)
  mcp/            MCP server, tool registry, 17 tool definitions + handlers
  middleware/     bearer auth, audit logging, error mapping
  http/           express app, /auth routes, /mcp route, /healthz
```

### Hard rules (do not break these)

1. **Only `GitLabService` calls GitLab.** Tool handlers and routes must never
   `fetch` GitLab directly. Add new GitLab interactions as methods on the service.
2. **Only the allowlisted tools exist (currently 17).** Do NOT add tools that
   expose arbitrary API calls, repo/project/group/runner/variable administration,
   or a raw API proxy. User lookup is limited to `get_current_user` and
   `find_user` (username→id) — no user administration or enumeration beyond that.
   The tool surface is intentionally curated — see `src/mcp/tools/` and
   `src/mcp/registry.ts`. New tools require a security-model check before exposure.
3. **Actions run as the authenticated GitLab user**, using their own OAuth token.
   No shared service token, no privilege elevation.
4. **Tokens are encrypted at rest** (AES-256-GCM via `src/auth/crypto.ts`). Never
   store or log raw tokens. Session tokens are stored as sha-256 hashes.
5. **Every tool call is audited** (`AuditLog`) with secrets stripped from params.
6. **Config comes from `src/config`** (zod-validated). Don't sprinkle `process.env`.

## The tools (17)

**Merge requests:** `create_merge_request`, `update_merge_request`,
`get_merge_request`, `list_merge_requests`, `get_merge_request_diff`,
`get_merge_request_versions`.

**Comments & discussions:** `add_comment`, `list_merge_request_discussions`,
`reply_to_discussion`.

**Review actions:** `assign_reviewer`, `set_labels`, `approve_merge_request`,
`unapprove_merge_request`.

**Pipelines:** `get_pipeline_status`, `list_pipelines`.

**User lookup:** `get_current_user`, `find_user`.

> Note: creating a *new* inline comment on a diff line is intentionally NOT a
> tool — that path stays in the reviewer skill (the nested `position` object is
> awkward to serialize via `glab`). The server reads discussions and replies to
> existing ones.

Each tool: zod input schema → permission check (project access) → `GitLabService`
call → structured response. Errors map to meaningful MCP errors (see
`src/middleware/errors.ts`).

## Common commands

```bash
npm install
npm run db:generate        # prisma generate
npm run db:migrate         # prisma migrate dev (local)
npm run dev                # tsx watch, local dev server
npm run build              # tsc
npm start                  # run built server
npm test                   # vitest run
npm run test:watch
docker compose up          # full stack (postgres + redis + app, runs migrations)
```

## Environment

See `.env.example`. Key vars: `DATABASE_URL`, `REDIS_URL`, `GITLAB_BASE_URL`
(default `https://gitlab.com`), `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`,
`GITLAB_REDIRECT_URI`, `ENCRYPTION_KEY` (32-byte base64/hex), `SESSION_TTL_HOURS`,
`PORT`, `PUBLIC_BASE_URL`.

## Auth flow (how a user gets connected)

### MCP client (OAuth)

MCP clients can authenticate via the server's own OAuth 2.0 endpoints:
- Discovery: `/.well-known/oauth-authorization-server`
- Dynamic Client Registration: `POST /register`
- Authorization: `GET /authorize` (redirects to GitLab login once)
- Token exchange & refresh: `POST /token`
- Token revocation: `POST /revoke`

GitLab is the upstream identity provider; GitLab tokens never leave the server.
The client receives opaque session tokens (access + rotating refresh tokens).

See [`docs/oauth.md`](docs/oauth.md#8-connecting-an-mcp-client-eg-claude-code-via-oauth) for setup.

### Browser (manual token flow — fallback)

For clients without OAuth support:

1. User opens `GET /auth/login` in a browser.
2. Server redirects to GitLab's OAuth authorize endpoint (with `state` + PKCE).
3. GitLab redirects to `GET /auth/callback` → server exchanges code, fetches the
   GitLab user, stores encrypted tokens, issues an **opaque session bearer token**.
4. User pastes that bearer token into their MCP client config as
   `Authorization: Bearer <token>` for `POST /mcp`.
5. `POST /auth/logout` revokes the session.

## Testing notes

- GitLab is always mocked in tests (no live calls). Unit tests cover crypto,
  sessions, authorization, sanitizer, error mapping, schemas. Integration tests
  cover the OAuth callback and each tool handler with `GitLabService` mocked.
- Run a single test: `npm test -- tests/unit/crypto.test.ts`.

## When adding/changing GitLab behavior

- Add a method to `GitLabService`, give it a typed return, map errors through the
  shared `GitLabApiError` so the central error mapper produces a good MCP message.
- If it's a new capability, confirm it fits the security model before exposing it
  as a tool. When in doubt, do NOT expose it.
