# GitLab OAuth Configuration Guide

This server authenticates every user with **their own GitLab account** via
OAuth 2.0. There are **no Personal Access Tokens** — users never paste GitLab
tokens. Instead they log in through GitLab, and the server issues its own
short-lived bearer token for use with the MCP endpoint.

## 1. Register an OAuth application

You need a GitLab OAuth application. Register it at one of these levels.

### gitlab.com or self-hosted — user-owned application

1. Go to **User Settings → Applications** (`/-/user_settings/applications`).
2. Fill in:
   - **Name:** e.g. `GitLab MCP Server`.
   - **Redirect URI:** `${PUBLIC_BASE_URL}/auth/callback`
     (for local dev: `http://localhost:3000/auth/callback`).
   - **Confidential:** ✅ **checked** (this server keeps a client secret).
   - **Scopes:** check `read_user` and `api`.
3. Click **Save application**.
4. Copy the **Application ID** and **Secret**.

### Self-hosted GitLab — group or instance application

For a shared deployment you can register the app at a higher level so it isn't
tied to one person's account:

- **Group application:** Group → **Settings → Applications**.
- **Instance-wide application (admin):** **Admin Area → Applications**.

The fields (redirect URI, confidential, scopes) are identical.

## 2. Required scopes

| Scope | Why it's needed |
|-------|-----------------|
| `read_user` | To read the authenticated user's profile (id, username, name, email) at login. |
| `api` | To act on the user's behalf — create/update merge requests, add comments, read pipelines, set labels/reviewers. The MCP tools call the GitLab REST API with the user's token, so GitLab enforces that user's real permissions. |

> The `api` scope is broad on GitLab's side, but this server only ever exposes
> the **9 whitelisted MCP tools** — it never proxies arbitrary API calls. See
> [security.md](./security.md).

## 3. Confidential client + PKCE

This is a **confidential** application: it authenticates to GitLab's token
endpoint using `GITLAB_CLIENT_SECRET`, and additionally uses **PKCE (S256)** for
the authorization code exchange. Keep the secret out of client-side code and
version control.

## 4. Map credentials to environment variables

| GitLab field | Environment variable |
|--------------|----------------------|
| Application ID | `GITLAB_CLIENT_ID` |
| Secret | `GITLAB_CLIENT_SECRET` |
| Redirect URI | `GITLAB_REDIRECT_URI` |
| Instance URL | `GITLAB_BASE_URL` (e.g. `https://gitlab.com` or `https://gitlab.example.com`) |

The redirect URI **must match exactly** — same scheme, host, port, and path —
between the GitLab app registration and `GITLAB_REDIRECT_URI`.

## 5. The login flow

```
1. User opens   GET /auth/login
2. Server redirects to GitLab's authorize endpoint
   (with client_id, redirect_uri, scopes, state, PKCE code_challenge)
3. User approves on GitLab
4. GitLab redirects to GET /auth/callback?code=...&state=...
5. Server validates state, exchanges the code (+ PKCE verifier + secret)
   for GitLab access + refresh tokens
6. Server reads the GitLab user (read_user), upserts the user record,
   and stores the encrypted tokens
7. Server issues its OWN bearer token and shows it to the user once
8. User pastes that bearer token into their MCP client config:
      URL:    ${PUBLIC_BASE_URL}/mcp
      Header: Authorization: Bearer <token>
```

From then on the MCP client sends the bearer token with each request; the
server resolves it to the user and acts with that user's GitLab token.

## 6. Token refresh

GitLab access tokens expire. The server stores the refresh token (encrypted)
and automatically refreshes the access token when it is within
`TOKEN_REFRESH_SKEW_SECONDS` of expiry — transparently, before each GitLab
call. Users do not need to re-authenticate unless the refresh token itself is
revoked or expires.

## 7. Logout

To revoke a session, send the bearer token to the logout endpoint:

```bash
curl -X POST ${PUBLIC_BASE_URL}/auth/logout \
  -H "Authorization: Bearer <token>"
```

This invalidates the issued bearer token. The user must run `/auth/login` again
to obtain a new one.

## 8. Connecting an MCP client (e.g. Claude Code) via OAuth

The server is an **OAuth 2.0 Authorization Server** for MCP clients. Clients can authenticate without manually pasting tokens.

### Zero-token client setup

Add the server to your MCP client:

```bash
claude mcp add --transport http gitlab http://localhost:3000/mcp
```

On first use:

1. The client discovers `/.well-known/oauth-authorization-server` (server metadata).
2. The client registers itself via `POST /register` (Dynamic Client Registration).
3. The client opens your browser to `GET /authorize`.
4. You log in with **your GitLab account** (once).
5. GitLab redirects back; the client exchanges the code for **opaque session + refresh tokens**.
6. The client automatically refreshes tokens before expiry — no re-login needed for up to 30 days (or until the refresh token expires).

The MCP client never sees your GitLab token; the server holds it encrypted and acts on your behalf.

### Fallback: manual token flow

If your MCP client does not support OAuth, the legacy manual flow still works:

1. Visit `http://localhost:3000/auth/login` in a browser.
2. Authorize with GitLab.
3. Copy the bearer token shown.
4. Configure your client with:
   - URL: `http://localhost:3000/mcp`
   - Header: `Authorization: Bearer <token>`

## Common pitfalls

| Problem | Fix |
|---------|-----|
| **Redirect URI mismatch** (`The redirect URI included is not valid`) | Ensure `GITLAB_REDIRECT_URI` exactly equals the value registered on the GitLab app, including scheme/host/port/path. |
| **Missing `api` scope** | Login works but tool calls fail with permission/auth errors. Re-create the app with both `read_user` and `api`. |
| **Wrong `GITLAB_BASE_URL` for self-hosted** | The server would talk to gitlab.com instead of your instance. Set `GITLAB_BASE_URL` to your instance origin (no trailing `/api`). |
| **App not marked confidential** | Token exchange with a client secret will fail. Re-create the application as confidential. |
| **Secret leaked / rotated** | Update `GITLAB_CLIENT_SECRET` and restart; users may need to log in again. |
