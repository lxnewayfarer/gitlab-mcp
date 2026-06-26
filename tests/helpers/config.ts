import { Buffer } from "node:buffer";
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
    gitlabApiBase: "https://gitlab.example.com/api/v4",
    encryptionKey: Buffer.alloc(32, 1),
    ...overrides,
  };
  setConfig(cfg);
  return cfg;
}
