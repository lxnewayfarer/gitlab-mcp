# MCP Client-Driven OAuth 2.0 — Design

Date: 2026-06-26

## Goal

Let MCP clients (e.g. Claude Code) connect to this server and authenticate
automatically through a browser, instead of the current manual flow where a user
visits `/auth/login`, copies an opaque session token from an HTML page, and pastes
it into the client config.

After this change a user can run:

```bash
claude mcp add --transport http gitlab http://localhost:3000/mcp
```

with **no token**. On first use Claude Code discovers the OAuth metadata, registers
itself, opens a browser, the user logs in with GitLab once, and the client obtains
and refreshes tokens on its own.

## Why this is non-trivial

The MCP OAuth spec requires the server to act as an **OAuth 2.0 Authorization
Server (AS)** toward the client: it must publish discovery metadata, support
Dynamic Client Registration (DCR), and run the authorization-code + PKCE grant.
But the real identity provider is GitLab. So the server sits in the middle:

```
Claude Code  ──(our OAuth)──►  MCP server  ──(GitLab OAuth)──►  GitLab
   client                      AS + RS                          upstream IdP
```

The current server (per CLAUDE.md and code) does NOT support this: `/mcp` returns
`401` with a plain JSON body (no `WWW-Authenticate`), there are no
`/.well-known/oauth-*` endpoints, no `/register`, and the SDK is wired without an
OAuth provider.

## Decisions (settled during brainstorming)

1. **Own AS layered over GitLab** (not a direct proxy to GitLab). The server issues
   its own tokens to the client and keeps GitLab tokens encrypted server-side. This
   preserves the security model in CLAUDE.md — the GitLab token never leaks to the
   client.
2. **Full Dynamic Client Registration (RFC 7591)** — clients self-register and
   receive a `client_id`. This is what Claude Code uses by default; zero manual
   config.
3. **Reuse the existing opaque session token as the client's `access_token`** —
   minimal new code; `sessionService.validate()` and `bearerAuth` are reused.
4. **Support refresh tokens** — `/token` issues an `access_token` (= session) plus a
   separate opaque `refresh_token` with rotation, so the client renews without a new
   browser login.
5. **Keep the old manual flow as a fallback** — both paths converge on
   `sessionService.issue()`.
6. **Implement via the SDK.** `@modelcontextprotocol/sdk@^1.12.0` exports
   `mcpAuthRouter`, the `OAuthServerProvider` interface, `mcpAuthMetadataRouter`, and
   typed OAuth errors. The SDK serves discovery, DCR, request parsing, and error
   formatting. We implement only the `OAuthServerProvider` business logic.

## Flow (double-PKCE with a parked authorization request)

1. Claude Code fetches discovery → `POST /oauth/register` (DCR) → gets a `client_id`.
2. Claude Code opens a browser to **`/oauth/authorize`** with its own PKCE
   `code_challenge_A`, its `redirect_uri`, and `state`.
3. The server does **not** show its own login screen. It **parks** the client's
   request (`client_id`, `redirect_uri`, `state`, `code_challenge_A`) in Redis under
   a key, then redirects the browser into the **existing GitLab flow** (the
   `/auth/login` logic: a fresh internal `state_B` + PKCE `verifier_B`). The parked
   request is correlated to `state_B`.
4. GitLab authenticates the user → existing **`/auth/callback`** → the server
   exchanges the code, upserts the user + encrypted GitLab tokens (unchanged), and
   calls `sessionService.issue(user)` → opaque session token.
5. **New branch in `/auth/callback`:** if a parked OAuth request exists for this
   `state_B`, the server generates **our authorization code**, binds it to the
   freshly issued session, and redirects the browser back to the client's
   `redirect_uri` with `code` + the original `state`. Otherwise it falls back to the
   existing HTML page that displays the token.
6. Claude Code calls **`/oauth/token`** with `code` + `code_verifier_A`. The server
   verifies PKCE_A and the binding, then returns the **opaque session token** as
   `access_token` plus a `refresh_token`.
7. Claude Code sends `Authorization: Bearer <session token>` to `/mcp`. The existing
   `bearerAuth` middleware validates it (essentially unchanged).

Token renewal: when the session expires, Claude Code calls `/oauth/token` with
`grant_type=refresh_token`; `exchangeRefreshToken` issues a new session and rotates
the refresh token. If the client has no valid refresh token, `/mcp` returns
`401` + `WWW-Authenticate`, and the client re-runs the browser authorization (one
click).

## Data model

Two new Prisma models (conventions: `cuid()` id, `createdAt`/`updatedAt`,
`@@map` snake_case, secrets stored only as sha-256 hashes like `Session.tokenHash`).

```prisma
model OAuthClient {
  id               String   @id @default(cuid())
  clientId         String   @unique           // issued at DCR (public)
  clientName       String?                     // from client_metadata
  redirectUris     String[]                    // registered redirect_uris
  grantTypes       String[] @default(["authorization_code", "refresh_token"])
  clientSecretHash String?                     // null for public PKCE clients
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@map("oauth_clients")
}

model OAuthRefreshToken {
  id        String    @id @default(cuid())
  tokenHash String    @unique     // sha-256, raw token never stored
  userId    String
  clientId  String                 // OAuthClient.clientId
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("oauth_refresh_tokens")
}
```

`User` gets a `oauthRefreshTokens OAuthRefreshToken[]` back-relation.

**Ephemeral state lives in Redis** (by analogy with the existing
`oauthStateStore`), not Postgres:

- **Parked client authorize request** (step 3) — Redis, TTL 10 min, keyed by
  internal `state_B`. Stores `{clientId, redirectUri, state, codeChallenge}`.
- **Our authorization code** (step 5) — Redis, sha-256 of the code → `{clientId,
  redirectUri, codeChallenge, sessionId, userId}`, TTL ~60 s, single-use via atomic
  `take`.

## Components / files

Following the project's layered architecture.

**`src/auth/` (new):**
- `oauthClientStore.ts` — DCR create/read of `OAuthClient` via repository;
  `redirect_uri` validation.
- `authCodeStore.ts` — Redis store for our authorization codes (sha-256 → binding,
  TTL ~60 s, single-use atomic `take`).
- `pendingAuthorizeStore.ts` — Redis store for the parked client request (modeled on
  the existing `oauthStateStore`, TTL 10 min).
- `refreshTokenService.ts` — issue / validate / rotate / revoke opaque refresh
  tokens (sha-256 in Postgres via repository), mirroring `sessionService`.
- `mcpOAuthProvider.ts` — class implementing the SDK `OAuthServerProvider`
  interface: `authorize()`, `exchangeAuthorizationCode()`, `exchangeRefreshToken()`,
  `verifyAccessToken()`, `revokeToken()`. Orchestrates the existing `gitlabOAuth`,
  `sessionService`, and the new stores.

**`src/repositories/` (new):**
- `oauthClient.ts` — Prisma data access for `OAuthClient`.
- `oauthRefreshToken.ts` — Prisma data access for `OAuthRefreshToken`.

**`src/http/` (changes):**
- `app.ts` — mount `mcpAuthRouter(provider, { issuerUrl: PUBLIC_BASE_URL })` at the
  root; it serves `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/oauth/authorize`, `/oauth/token`,
  `/oauth/register`, `/oauth/revoke`. Verify helmet/CSP does not block
  `/.well-known/*`.
- `authRoutes.ts` — `/auth/callback` gains the OAuth branch (step 5): if a parked
  request exists for `state_B`, issue an auth code and redirect to the client's
  `redirect_uri`; else keep the existing HTML fallback. `/auth/login` logic is
  reused to start the GitLab leg from `authorize()`.

**`src/middleware/bearerAuth.ts` (change):**
- Add `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`
  to the 401 responses. Keep the existing JSON body. This header is the trigger that
  makes Claude Code start the automatic OAuth flow.

**`src/config/index.ts` (change):**
- Add `OAUTH_CODE_TTL_SECONDS` (default 60) and `OAUTH_REFRESH_TTL_HOURS` (default,
  e.g. 720 = 30 days). `PUBLIC_BASE_URL` is reused as the issuer URL.

## Error handling & security

**Error mapping.** The provider throws the SDK's typed OAuth errors
(`InvalidRequestError`, `InvalidClientError`, `InvalidGrantError`,
`UnsupportedGrantTypeError`, …); `mcpAuthRouter` serializes them to the standard
OAuth shape (`{"error","error_description"}`). This is a separate channel from the
existing `GitLabApiError` / MCP error mapper in `src/middleware/errors.ts`, which is
untouched for tool calls.

**Security invariants (preserve the CLAUDE.md model):**
- GitLab access/refresh tokens never leave the server — they stay encrypted in
  `OAuthAccount`. The client only ever holds our opaque session + refresh tokens.
- PKCE is mandatory on the client leg (`code_challenge_method=S256`); an auth code
  cannot be exchanged without a matching `code_verifier`.
- Authorization codes: sha-256 in Redis (raw never stored), ~60 s TTL, strictly
  single-use (atomic `take`), bound to `clientId` + `redirect_uri` +
  `code_challenge` — all three re-checked at exchange.
- `redirect_uri` validated at DCR and compared exactly at `/authorize` and `/token`
  (open-redirect defense).
- The client's `state` is passed back transparently (client CSRF defense); the
  internal `state_B` toward GitLab is separate, as today.
- Refresh tokens: opaque, sha-256 in Postgres, **rotated** on every use (old one
  marked `revokedAt`); reuse of a rotated token is rejected.
- `revokeToken()` reuses `sessionService.revoke()` and revokes the linked refresh
  token.
- Issuing an auth code and exchanging it for a token are audited via the existing
  `AuditLog` pattern, with secrets stripped.

## Testing

GitLab is always mocked; Vitest unit + integration, per project conventions.

**Unit:**
- `authCodeStore` (TTL, single-use), `pendingAuthorizeStore`, `oauthClientStore`
  (`redirect_uri` validation), `refreshTokenService` (issue/validate/rotate/revoke).
- `mcpOAuthProvider` (PKCE verification, code↔client↔redirect binding, refresh
  rotation, access-token verification).
- updated `bearerAuth` (asserts `WWW-Authenticate` present on 401).

**Integration:**
- Happy path: DCR → `/oauth/authorize` → (GitLab callback mocked) → redirect with
  `code` → `/oauth/token` → access + refresh → `Bearer` works on `/mcp`.
- Negatives: expired code, replayed code, mismatched `redirect_uri`, bad PKCE,
  rotated refresh token invalidates the old one.
- Discovery: smoke-test that `mcpAuthRouter` serves valid metadata JSON at both
  `/.well-known/*` endpoints.

## Out of scope

- Changing the 9-tool surface or any GitLab behavior.
- Confidential (secret-bearing) OAuth clients — only public PKCE clients (what
  Claude Code uses) are supported; `clientSecretHash` is reserved for the future.
- Replacing the manual `/auth/login` HTML flow (kept as fallback).
