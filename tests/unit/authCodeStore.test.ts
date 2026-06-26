import { describe, it, expect, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { authCodeStore } from "../../src/auth/authCodeStore.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async set(k: string, v: string) { m.set(k, v); },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { m.delete(k); },
  } as any;
}

const data = {
  clientId: "c1", redirectUri: "http://cb", codeChallenge: "chal",
  sessionId: "s1", userId: "u1", sessionToken: "raw-session-token",
};

describe("authCodeStore", () => {
  it("issues a code, peeks challenge, consumes once returning data", async () => {
    const store = authCodeStore(fakeRedis());
    const code = await store.issue(data);
    expect(await store.peekChallenge(code)).toBe("chal");
    const got = await store.consume(code);
    expect(got).toEqual(data);
    expect(await store.consume(code)).toBeNull(); // single-use
  });

  it("returns null for unknown code", async () => {
    const store = authCodeStore(fakeRedis());
    expect(await store.consume("nope")).toBeNull();
    expect(await store.peekChallenge("nope")).toBeNull();
  });
});
