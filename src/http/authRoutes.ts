import { Router } from "express";
import { getConfig } from "../config/index.js";
import { randomToken } from "../auth/crypto.js";
import {
  buildAuthorizeUrl,
  exchangeCode as defaultExchangeCode,
  fetchGitLabUser as defaultFetchGitLabUser,
  generatePkce,
} from "../auth/gitlabOAuth.js";
import { oauthStateStore } from "../auth/oauthStateStore.js";
import { pendingAuthorizeStore, type PendingAuthorize } from "../auth/pendingAuthorizeStore.js";
import { authCodeStore } from "../auth/authCodeStore.js";
import { sessionService } from "../auth/sessionService.js";
import { userRepository } from "../repositories/userRepository.js";
import { oauthAccountRepository } from "../repositories/oauthAccountRepository.js";

export interface AuthRoutesDeps {
  stateStore?: ReturnType<typeof oauthStateStore>;
  pendingStore?: ReturnType<typeof pendingAuthorizeStore>;
  codeStore?: ReturnType<typeof authCodeStore>;
  sessions?: ReturnType<typeof sessionService>;
  users?: ReturnType<typeof userRepository>;
  accounts?: ReturnType<typeof oauthAccountRepository>;
  exchangeCode?: typeof defaultExchangeCode;
  fetchGitLabUser?: typeof defaultFetchGitLabUser;
}

/**
 * Starts the GitLab login leg. Stores the PKCE verifier under a fresh internal
 * `state`. If `pending` is given, the request originated from an MCP client's
 * /oauth/authorize and the callback will return an authorization code instead
 * of the HTML page.
 */
export async function startGitLabLogin(
  deps: { stateStore: ReturnType<typeof oauthStateStore>; pendingStore: ReturnType<typeof pendingAuthorizeStore> },
  opts?: { pending?: PendingAuthorize },
): Promise<string> {
  const state = randomToken(16);
  const { verifier, challenge } = generatePkce();
  await deps.stateStore.save(state, { verifier });
  if (opts?.pending) await deps.pendingStore.save(state, opts.pending);
  return buildAuthorizeUrl(state, challenge);
}

export function authRoutes(deps?: AuthRoutesDeps): Router {
  const router = Router();
  const stateStore = deps?.stateStore ?? oauthStateStore();
  const pendingStore = deps?.pendingStore ?? pendingAuthorizeStore();
  const codeStore = deps?.codeStore ?? authCodeStore();
  const sessions = deps?.sessions ?? sessionService();
  const users = deps?.users ?? userRepository();
  const accounts = deps?.accounts ?? oauthAccountRepository();
  const exchangeCode = deps?.exchangeCode ?? defaultExchangeCode;
  const fetchGitLabUser = deps?.fetchGitLabUser ?? defaultFetchGitLabUser;

  // Manual login (fallback) — no parked OAuth request.
  router.get("/login", async (_req, res) => {
    const url = await startGitLabLogin({ stateStore, pendingStore });
    res.redirect(url);
  });

  router.get("/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) {
      res.status(400).send("Missing code or state.");
      return;
    }

    const pendingAuth = await stateStore.take(state);
    if (!pendingAuth) {
      res.status(400).send("Invalid or expired OAuth state. Please retry /auth/login.");
      return;
    }

    try {
      const { tokens, expiresAt } = await exchangeCode(code, pendingAuth.verifier);
      const glUser = await fetchGitLabUser(tokens.access_token);

      const user = await users.upsertFromGitLab(glUser);
      await accounts.upsert(user.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenType: tokens.token_type,
        scope: tokens.scope ?? null,
        expiresAt,
      });

      const { token, expiresAt: sessionExp } = await sessions.issue(user, {
        userAgent: req.header("user-agent") ?? null,
        ip: req.ip ?? null,
      });

      // OAuth-client branch: a parked authorize request → issue our code & redirect back.
      // If pendingStore is unavailable (e.g. Redis down), treat as "no parked request"
      // and fall through to the HTML page — never a 502.
      const parked = await pendingStore.take(state).catch(() => null);
      if (parked) {
        const authCode = await codeStore.issue({
          clientId: parked.clientId,
          redirectUri: parked.redirectUri,
          codeChallenge: parked.codeChallenge,
          sessionId: "", // session id is internal; not needed by /token. Kept for audit symmetry.
          userId: user.id,
          sessionToken: token,
        });
        const redirect = new URL(parked.redirectUri);
        redirect.searchParams.set("code", authCode);
        if (parked.clientState) redirect.searchParams.set("state", parked.clientState);
        res.redirect(302, redirect.toString());
        return;
      }

      // Fallback: HTML page with the token.
      res.status(200).type("html").send(connectedPage(user.username, token, sessionExp));
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth failed";
      res.status(502).send(`OAuth login failed: ${escapeHtml(message)}`);
    }
  });

  router.post("/logout", async (req, res) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    if (match) await sessions.revoke(match[1]);
    res.status(200).json({ ok: true });
  });

  return router;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function connectedPage(username: string, token: string, expiresAt: Date): string {
  const cfg = getConfig();
  const mcpUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`;
  return `<!doctype html>
<meta charset="utf-8">
<title>Connected to GitLab MCP</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5}
  code,pre{background:#f4f4f5;border-radius:6px}
  pre{padding:1rem;overflow:auto}
  .tok{user-select:all;word-break:break-all}
  .warn{color:#b45309}
</style>
<h1>✅ Connected as <code>${escapeHtml(username)}</code></h1>
<p>Your MCP session bearer token (expires ${expiresAt.toISOString()}):</p>
<pre class="tok">${escapeHtml(token)}</pre>
<p class="warn">Copy it now — it is shown only once and stored only as a hash.</p>
<h2>Configure your MCP client</h2>
<p>Point your client at the Streamable HTTP endpoint below and send the token as a bearer header:</p>
<pre>URL:    ${escapeHtml(mcpUrl)}
Header: Authorization: Bearer &lt;token&gt;</pre>
<p>To disconnect, send <code>POST /auth/logout</code> with the same bearer header.</p>`;
}
