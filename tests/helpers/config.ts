import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { setConfig, type AppConfig } from "../../src/config/index.js";

/** Install a deterministic in-memory config for tests (no env / no .env). */
export function installTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    NODE_ENV: "test",
    PORT: 3000,
    PUBLIC_BASE_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://test",
    REDIS_URL: "redis://localhost:6379",
    GITLAB_BASE_URL: "https://gitlab.example.com",
    GITLAB_CLIENT_ID: "client-id",
    GITLAB_CLIENT_SECRET: "client-secret",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback",
    GITLAB_SCOPES: "read_user api",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("hex"),
    SESSION_TTL_HOURS: 168,
    TOKEN_REFRESH_SKEW_SECONDS: 60,
    OAUTH_CODE_TTL_SECONDS: 60,
    OAUTH_REFRESH_TTL_HOURS: 720,
    gitlabApiBase: "https://gitlab.example.com/api/v4",
    encryptionKey: Buffer.alloc(32, 1),
    ...overrides,
  };
  setConfig(cfg);
  return cfg;
}

/**
 * Build the signed state cookie header the server expects on /auth/callback.
 * Mirrors src/http/stateCookie.ts using the test encryption key.
 */
export function stateCookieHeader(state: string, key: Buffer = Buffer.alloc(32, 1)): string {
  const sig = createHmac("sha256", key).update(state).digest("base64url");
  return `mcp_oauth_state=${encodeURIComponent(`${state}.${sig}`)}`;
}
