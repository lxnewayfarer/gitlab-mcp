import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/index.js";

const base = {
  DATABASE_URL: "postgresql://x",
  GITLAB_CLIENT_ID: "id",
  GITLAB_CLIENT_SECRET: "secret",
  GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback",
  ENCRYPTION_KEY: "a".repeat(64), // 64 hex chars = 32 bytes
};

describe("config OAuth TTLs", () => {
  it("defaults code TTL to 60s and refresh TTL to 720h", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(60);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(720);
  });

  it("reads overrides from env", () => {
    const cfg = loadConfig({ ...base, OAUTH_CODE_TTL_SECONDS: "30", OAUTH_REFRESH_TTL_HOURS: "168" } as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(30);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(168);
  });
});
