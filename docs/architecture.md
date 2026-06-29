# Architecture

The GitLab MCP server is a multi-user bridge that lets AI agents (MCP clients)
perform a fixed set of GitLab operations, each executed as the authenticated
GitLab user.

## Hard rules

These invariants hold throughout the codebase:

1. **Only `GitLabService` talks to GitLab.** All outbound GitLab REST calls go
   through one service layer (`src/services/gitlabService.ts`).
2. **Only 9 MCP tools exist.** No raw API proxy, no arbitrary calls.
3. **Actions run as the user.** Every call uses the user's own OAuth token; the
   server holds no privileged service token.
4. **Tokens are encrypted at rest** (AES-256-GCM) and never logged.
5. **Everything is audited** with secrets stripped from the recorded parameters.

## Layered architecture

```mermaid
flowchart TD
    subgraph HTTP["http/ — Express edge"]
      Routes["auth routes + /mcp route + /healthz"]
    end
    subgraph MW["middleware/"]
      Auth["bearer auth"]
      Err["error mapping"]
      Audit["audit logging"]
    end
    subgraph MCP["mcp/"]
      Tools["9 tool definitions (Zod schemas)"]
      Handlers["tool handlers"]
    end
    subgraph SVC["services/"]
      GL["GitLabService (sole GitLab caller)"]
    end
    subgraph REPO["repositories/"]
      R["user / oauthAccount / session / auditLog"]
    end
    subgraph DB["database/"]
      PG[("PostgreSQL")]
      RD[("Redis")]
    end
    subgraph AUTHL["auth/"]
      OAuth["OAuth + PKCE"]
      Sess["session service"]
      Crypto["crypto (AES-256-GCM)"]
      TP["token provider (refresh)"]
    end
    CFG["config/ (env, validated)"]

    Routes --> MW
    MW --> MCP
    Handlers --> GL
    GL -->|REST as the user| GLAPI[("GitLab API")]
    MCP --> REPO
    AUTHL --> REPO
    REPO --> DB
    Routes --> AUTHL
    TP --> OAuth
    Sess --> RD
    Sess --> R
    CFG -.-> SVC
    CFG -.-> AUTHL
```

### Layer responsibilities

| Layer | Responsibility |
|-------|----------------|
| `config/` | Loads and validates environment configuration. |
| `database/` | PostgreSQL (Prisma) and Redis client setup. |
| `auth/` | OAuth flow with PKCE, session issuance/validation, AES-256-GCM crypto, and GitLab token refresh. |
| `services/` | `GitLabService` — the **only** component that calls the GitLab REST API. |
| `repositories/` | Persistence for users, OAuth accounts, sessions, and audit logs. |
| `mcp/` | The 9 tool definitions (Zod-validated) and their handlers. |
| `middleware/` | Bearer-token authentication, error mapping, and audit logging. |
| `http/` | Express app wiring: `/auth` routes, the `/mcp` endpoint, and `/healthz`. It also mounts the SDK `mcpAuthRouter`, which serves the server's own OAuth Authorization Server endpoints — `/authorize`, `/token`, `/register`, `/revoke`, and the `/.well-known/*` discovery documents — for MCP clients that authenticate via OAuth. |

## OAuth login flow

```mermaid
sequenceDiagram
    actor User
    participant Srv as MCP Server
    participant GL as GitLab
    participant DB as PostgreSQL
    participant RD as Redis

    User->>Srv: GET /auth/login
    Srv->>RD: store state + PKCE verifier (10-min TTL)
    Srv-->>User: 302 redirect to GitLab authorize
    User->>GL: authorize (approve)
    GL-->>User: redirect to /auth/callback?code&state
    User->>Srv: GET /auth/callback?code&state
    Srv->>RD: validate + consume state
    Srv->>GL: exchange code (+ secret + PKCE verifier)
    GL-->>Srv: access + refresh tokens
    Srv->>GL: GET /user (read_user)
    GL-->>Srv: user profile
    Srv->>DB: upsert user + store encrypted tokens
    Srv->>DB: create session (store SHA-256 hash)
    Srv-->>User: bearer token (shown once)
```

## MCP tool-call lifecycle

```mermaid
sequenceDiagram
    participant Client as MCP Client
    participant Srv as MCP Server
    participant Auth as bearer auth
    participant TP as token provider
    participant GL as GitLabService
    participant API as GitLab API
    participant DB as PostgreSQL

    Client->>Srv: POST /mcp (Authorization: Bearer <token>, tool call)
    Srv->>Auth: validate bearer (Redis cache → Postgres)
    Auth-->>Srv: resolved user (or 401)
    Srv->>Srv: Zod-validate tool input
    Srv->>TP: get GitLab access token (refresh if near expiry)
    TP-->>Srv: valid access token
    Srv->>GL: assertProjectAccess(project_id)
    GL->>API: GET /projects/:id (as the user)
    API-->>GL: 200 / 403 / 404
    Srv->>GL: perform tool action
    GL->>API: REST call (as the user)
    API-->>GL: result / error
    Srv->>DB: write AuditLog (sanitized params, status, timing)
    Srv-->>Client: structured result or mapped error
```

End to end: the bearer token is validated and mapped to a user; tool input is
schema-validated; the user's GitLab token is fetched (and refreshed if needed);
project access is confirmed; the action runs through `GitLabService` as that
user; and the outcome is recorded in the audit log before the response is
returned. Errors are mapped to safe, meaningful messages along the way.

## Data model

| Model | Purpose |
|-------|---------|
| **User** | A GitLab user known to the server (GitLab id, username, name, email). |
| **OAuthAccount** | The user's GitLab OAuth tokens — access and refresh tokens stored **encrypted** with expiry metadata. |
| **Session** | An issued MCP bearer token, stored as a **SHA-256 hash** with a TTL and revocation state. |
| **AuditLog** | One record per tool invocation: user, GitLab username, tool name, sanitized parameters, result status, error, and execution time. |
