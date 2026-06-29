import { describe, it, expect, vi, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { sessionService } from "../../src/auth/sessionService.js";
import { sha256 } from "../../src/auth/crypto.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    SESSION_TTL_HOURS: "1",
  } as NodeJS.ProcessEnv));
});

function fakeRepo(expiresAt: Date = new Date(Date.now() + 3600 * 1000)) {
  const rows = new Map<string, any>();
  return {
    rows,
    async create({ userId, tokenHash, expiresAt: exp }: any) {
      const row = { id: "sess-1", userId, tokenHash, expiresAt: exp ?? expiresAt, revokedAt: null };
      rows.set(tokenHash, row);
      return row;
    },
    async findActiveByHash(h: string) { return rows.get(h) ?? null; },
    async revokeByHash(h: string, when: Date) { const r = rows.get(h); if (r) r.revokedAt = when; },
    async revokeAllForUser(userId: string, when: Date) {
      const hashes: string[] = [];
      for (const r of rows.values()) if (r.userId === userId && r.revokedAt === null) { r.revokedAt = when; hashes.push(r.tokenHash); }
      return hashes;
    },
  };
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _ex: string, _ttl: number) { store.set(key, value); return "OK"; },
    async get(key: string) { return store.get(key) ?? null; },
    async del(key: string) { store.delete(key); return 1; },
  };
}

describe("sessionService", () => {
  it("issue and validate via DB path returns SessionContext with Date expiresAt", async () => {
    const repo = fakeRepo();
    const redis = fakeRedis();
    // Use a redis that always misses so the DB path is exercised on validate
    const missRedis = { ...redis, async get() { return null; } };
    const svc = sessionService({ repo: repo as any, redis: missRedis as any });

    const { token, expiresAt } = await svc.issue({ id: "u1" } as any);
    const ctx = await svc.validate(token);

    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe("u1");
    expect(ctx!.sessionId).toBe("sess-1");
    expect(ctx!.expiresAt).toBeInstanceOf(Date);
    expect(ctx!.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -2);
  });

  it("validate via cache path returns SessionContext with Date expiresAt (not a string)", async () => {
    const repo = fakeRepo();
    const redis = fakeRedis();
    const svc = sessionService({ repo: repo as any, redis: redis as any });

    // issue() writes to cache; the subsequent validate() should hit the cache
    const { token } = await svc.issue({ id: "u1" } as any);
    const ctx = await svc.validate(token);

    expect(ctx).not.toBeNull();
    expect(ctx!.expiresAt).toBeInstanceOf(Date);
    // Must be a real Date — calling .getTime() must not return NaN
    expect(Number.isFinite(ctx!.expiresAt.getTime())).toBe(true);
  });

  it("validate returns null for an expired session", async () => {
    const repo = fakeRepo();
    // Bypass cache so expiry check in DB path is exercised
    const missRedis = { ...fakeRedis(), async get() { return null; } };
    const svc = sessionService({ repo: repo as any, redis: missRedis as any });

    const { token } = await svc.issue({ id: "u1" } as any);
    // Backdate the row's expiresAt to simulate expiry
    const h = sha256(token);
    repo.rows.get(h)!.expiresAt = new Date(Date.now() - 1000);
    expect(await svc.validate(token)).toBeNull();
  });

  it("validate returns null for a revoked session", async () => {
    const repo = fakeRepo();
    const missRedis = { ...fakeRedis(), async get() { return null; } };
    const svc = sessionService({ repo: repo as any, redis: missRedis as any });

    const { token } = await svc.issue({ id: "u1" } as any);
    // Simulate revocation by marking revokedAt in the fake repo
    repo.rows.get(sha256(token))!.revokedAt = new Date();
    expect(await svc.validate(token)).toBeNull();
  });

  it("revokeAllForUser revokes sessions and purges them from the cache", async () => {
    const repo = fakeRepo();
    const redis = fakeRedis();
    const svc = sessionService({ repo: repo as any, redis: redis as any });

    const { token } = await svc.issue({ id: "u1" } as any);
    // Cache is populated by issue(); a fresh validate() would hit it.
    expect(await svc.validate(token)).not.toBeNull();

    await svc.revokeAllForUser("u1");

    // Cache key must be gone, and the DB row revoked.
    expect(redis.store.get("session:" + sha256(token))).toBeUndefined();
    expect(repo.rows.get(sha256(token))!.revokedAt).not.toBeNull();
    // And validation now fails even though the row still exists.
    expect(await svc.validate(token)).toBeNull();
  });
});
