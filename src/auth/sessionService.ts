import type { User } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { getRedis } from "../database/redis.js";
import { sessionRepository } from "../repositories/sessionRepository.js";
import { randomToken, sha256 } from "./crypto.js";

/**
 * Issues and validates the server's own opaque bearer tokens (sessions).
 * Validation hits Redis first, then Postgres. The raw token is never stored —
 * only its sha-256 hash.
 */

const CACHE_PREFIX = "session:";

export interface SessionContext {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

export function sessionService(deps?: {
  repo?: ReturnType<typeof sessionRepository>;
  redis?: ReturnType<typeof getRedis>;
}) {
  const repo = deps?.repo ?? sessionRepository();
  const redis = deps?.redis ?? getRedis();
  const cfg = getConfig();

  return {
    /** Create a session for a user; returns the raw token (shown once). */
    async issue(
      user: User,
      meta?: { userAgent?: string | null; ip?: string | null },
    ): Promise<{ token: string; expiresAt: Date }> {
      const token = randomToken(32);
      const tokenHash = sha256(token);
      const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3600 * 1000);
      const session = await repo.create({
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: meta?.userAgent ?? null,
        ip: meta?.ip ?? null,
      });
      await cacheSet(redis, tokenHash, { sessionId: session.id, userId: user.id, expiresAt }, expiresAt);
      return { token, expiresAt };
    },

    /** Validate a raw bearer token. Returns context or null if invalid. */
    async validate(token: string): Promise<SessionContext | null> {
      const tokenHash = sha256(token);

      const cached = await cacheGet(redis, tokenHash);
      if (cached) return cached;

      const row = await repo.findActiveByHash(tokenHash);
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;

      const ctx: SessionContext = { sessionId: row.id, userId: row.userId, expiresAt: row.expiresAt };
      await cacheSet(redis, tokenHash, ctx, row.expiresAt);
      return ctx;
    },

    /** Revoke a session by its raw token. */
    async revoke(token: string): Promise<void> {
      const tokenHash = sha256(token);
      await repo.revokeByHash(tokenHash, new Date());
      await redis.del(CACHE_PREFIX + tokenHash).catch(() => undefined);
    },
  };
}

async function cacheSet(
  redis: ReturnType<typeof getRedis>,
  tokenHash: string,
  ctx: SessionContext,
  expiresAt: Date,
): Promise<void> {
  const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  await redis
    .set(CACHE_PREFIX + tokenHash, JSON.stringify(ctx), "EX", ttl)
    .catch(() => undefined);
}

async function cacheGet(
  redis: ReturnType<typeof getRedis>,
  tokenHash: string,
): Promise<SessionContext | null> {
  try {
    const raw = await redis.get(CACHE_PREFIX + tokenHash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionContext;
    // JSON.parse does not revive Date objects — expiresAt comes back as an ISO
    // string; convert it back to a Date so callers can safely call .getTime().
    parsed.expiresAt = new Date(parsed.expiresAt);
    return parsed;
  } catch {
    return null;
  }
}
