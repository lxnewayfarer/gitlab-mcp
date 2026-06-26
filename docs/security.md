# Security Review

This document reviews the security posture of the GitLab MCP server. File
references point to the implementation.

## Threat model summary

The server is a multi-user bridge between AI agents (MCP clients) and GitLab.
The primary assets are: users' GitLab OAuth tokens, the issued MCP bearer
tokens, and the integrity of actions performed against GitLab. The main threats
are: token theft (at rest or in transit), privilege escalation beyond a user's
GitLab permissions, abuse of an overly broad API surface, and leakage of
secrets via logs or errors. The design mitigates these through encryption,
strict authorization delegation to GitLab, a minimal tool surface, and audit
logging.

## Authentication

- After GitLab OAuth login, the server issues its **own opaque bearer token**
  (not the GitLab token) for use with the MCP endpoint
  (`src/auth/sessionService.ts`).
- The bearer token is **never stored in plaintext** — only its **SHA-256 hash**
  is persisted in the `Session` table. The raw token is shown to the user once.
- Sessions have a TTL (`SESSION_TTL_HOURS`) and an explicit expiry timestamp.
- **Revocation / logout:** `POST /auth/logout` invalidates the session; the
  bearer token is then rejected.

## Token storage

- GitLab access **and** refresh tokens are encrypted at rest with
  **AES-256-GCM** (`src/auth/crypto.ts`):
  - 12-byte random IV per encryption,
  - 16-byte GCM authentication tag (tamper detection),
  - 256-bit key derived from `ENCRYPTION_KEY` (must decode to exactly 32 bytes).
- Tokens are decrypted only in memory at the moment of use and are **never
  logged**.
- Rotating `ENCRYPTION_KEY` renders existing ciphertext undecryptable by design
  (see the rotation note in [deployment.md](./deployment.md)).

## OAuth security

- **PKCE (S256)** is used on the authorization code exchange, protecting against
  code interception.
- The OAuth **`state`** parameter is **single-use**, stored in Redis with a
  **10-minute TTL**, and validated on callback to prevent CSRF.
- The client is **confidential**: the token exchange authenticates with
  `GITLAB_CLIENT_SECRET` in addition to PKCE.

## Authorization model

- **No privilege elevation. No shared service token.** Every GitLab call is made
  with the **authenticated user's own access token**, so GitLab itself enforces
  that user's real permissions.
- Before each tool executes, the server calls **`assertProjectAccess`**
  (`src/services/gitlabService.ts`) to confirm the user can access the target
  project. A `403`/`404` from GitLab → access denied.
- The server cannot grant access a user does not already have in GitLab.

## Attack surface minimization

Only **9 whitelisted MCP tools** are exposed:
`create_merge_request`, `update_merge_request`, `get_merge_request`,
`list_merge_requests`, `add_comment`, `get_pipeline_status`, `list_pipelines`,
`assign_reviewer`, `set_labels`.

The server explicitly does **not** expose:

- arbitrary / raw GitLab API calls (no API proxy endpoint),
- repository deletion,
- project settings modification,
- token management,
- runner management,
- group administration,
- user administration,
- CI/CD variable modification.

There is no generic pass-through; the GitLab REST surface is reachable only
through these specific, validated operations.

## Audit logging

Every tool invocation is recorded in the `AuditLog` table: timestamp, user id,
GitLab username, tool name, **sanitized parameters**, result status, error (if
any), and execution time. Parameters are scrubbed of secrets via
`sanitizeParams` (`src/mcp/sanitize.ts`) before persistence, so tokens and
secret-like fields never enter the audit trail.

## Transport security

The MCP bearer token is sent on every request. **In production the server must
run behind HTTPS** (TLS-terminating reverse proxy) so tokens are never
transmitted in cleartext. See [deployment.md](./deployment.md).

## Input validation

Every tool defines a **Zod schema** for its inputs; requests with malformed or
unexpected parameters are rejected before any GitLab call is made. Project IDs,
IIDs, and enums (e.g. MR state) are constrained.

## Error handling

Errors are mapped to meaningful, **secret-free** messages
(`src/middleware/errors.ts`): expired/revoked tokens, insufficient permissions
(403), not found (404), rate limiting (429), GitLab outages (5xx), and
malformed requests each produce a distinct, safe response. Raw upstream payloads
and secrets are not leaked to the client.

## Operational hardening

- The application runs as a **non-root user** in the container image.
- Datastore credentials and secrets are injected via environment variables, not
  baked into the image.
- Dependencies are pinned via the lockfile; rebuild to pick up security patches.

## Residual risks & recommendations

1. **`ENCRYPTION_KEY` management** — store it in a secret manager (not plain
   env files in source control). Rotation requires all users to re-login;
   perform it as a planned event.
2. **Rate limiting** — consider adding rate limiting in front of `/auth/login`,
   `/auth/callback`, and `/mcp` (e.g. at the reverse proxy) to limit brute-force
   and abuse.
3. **Database encryption at rest** — enable disk/volume encryption for the
   PostgreSQL data directory for defense-in-depth beyond app-level token
   encryption.
4. **Secret management** — use Docker/Kubernetes secrets or a vault for
   `GITLAB_CLIENT_SECRET`, `ENCRYPTION_KEY`, and `POSTGRES_PASSWORD`.
5. **Scope minimization** — the `api` scope is broad on GitLab's side. If GitLab
   introduces finer-grained scopes covering only MR/pipeline operations, prefer
   those to reduce the blast radius of a stolen token.
6. **Audit log retention** — define a retention/rotation policy for `audit_logs`
   consistent with your compliance requirements.
