import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config/index.js";

/**
 * Thin GitLab OAuth client: builds the authorize URL (with PKCE), exchanges the
 * authorization code, refreshes tokens, and fetches the authenticated user.
 */

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  created_at?: number;
  expires_in?: number;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  email?: string | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const cfg = getConfig();
  const url = new URL(`${cfg.GITLAB_BASE_URL.replace(/\/$/, "")}/oauth/authorize`);
  url.searchParams.set("client_id", cfg.GITLAB_CLIENT_ID);
  url.searchParams.set("redirect_uri", cfg.GITLAB_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", cfg.GITLAB_SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function expiresAtFrom(resp: OAuthTokenResponse): Date | null {
  if (!resp.expires_in) return null;
  const base = resp.created_at ? resp.created_at * 1000 : Date.now();
  return new Date(base + resp.expires_in * 1000);
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: OAuthTokenResponse; expiresAt: Date | null }> {
  const cfg = getConfig();
  const body = new URLSearchParams({
    client_id: cfg.GITLAB_CLIENT_ID,
    client_secret: cfg.GITLAB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: cfg.GITLAB_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const res = await fetchImpl(`${cfg.GITLAB_BASE_URL.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const tokens = (await res.json()) as OAuthTokenResponse;
  return { tokens, expiresAt: expiresAtFrom(tokens) };
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: OAuthTokenResponse; expiresAt: Date | null }> {
  const cfg = getConfig();
  const body = new URLSearchParams({
    client_id: cfg.GITLAB_CLIENT_ID,
    client_secret: cfg.GITLAB_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    redirect_uri: cfg.GITLAB_REDIRECT_URI,
  });
  const res = await fetchImpl(`${cfg.GITLAB_BASE_URL.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const tokens = (await res.json()) as OAuthTokenResponse;
  return { tokens, expiresAt: expiresAtFrom(tokens) };
}

export async function fetchGitLabUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitLabUser> {
  const cfg = getConfig();
  const res = await fetchImpl(`${cfg.gitlabApiBase}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch GitLab user (${res.status}): ${text}`);
  }
  const u = (await res.json()) as GitLabUser;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email ?? null,
  };
}
