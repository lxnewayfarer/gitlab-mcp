import { describe, it, expect, vi, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { sha256 } from "../../src/auth/crypto.js";
import { refreshTokenService } from "../../src/auth/refreshTokenService.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

function fakeRepo() {
  const rows = new Map<string, any>();
  return {
    rows,
    async create({ userId, clientId, tokenHash, expiresAt }: any) {
      const row = { id: "r" + rows.size, userId, clientId, tokenHash, expiresAt, revokedAt: null };
      rows.set(tokenHash, row); return row;
    },
    async findByHash(h: string) { return rows.get(h) ?? null; },
    async revokeByHash(h: string, when: Date) { const r = rows.get(h); if (r) r.revokedAt = when; return { count: r ? 1 : 0 }; },
    async revokeAllForUser() { return { count: 0 }; },
  };
}

describe("refreshTokenService", () => {
  it("issues a token and validates it", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    const ctx = await svc.validate(token);
    expect(ctx).toEqual({ userId: "u1", clientId: "c1" });
  });

  it("rejects a revoked token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it("rotate revokes old and issues new", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token: old } = await svc.issue("u1", "c1");
    const { token: fresh } = await svc.rotate(old, "u1", "c1");
    expect(await svc.validate(old)).toBeNull();
    expect(await svc.validate(fresh)).toEqual({ userId: "u1", clientId: "c1" });
    expect(repo.rows.get(sha256(old))!.revokedAt).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    repo.rows.get(sha256(token))!.expiresAt = new Date(Date.now() - 1000);
    expect(await svc.validate(token)).toBeNull();
  });
});
