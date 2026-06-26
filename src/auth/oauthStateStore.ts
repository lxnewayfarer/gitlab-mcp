import { getRedis } from "../database/redis.js";

/**
 * Short-lived store for OAuth `state` → PKCE verifier, used to survive the
 * round-trip to GitLab and back. Backed by Redis with a 10-minute TTL.
 */
const PREFIX = "oauth:state:";
const TTL_SECONDS = 600;

export interface PendingAuth {
  verifier: string;
}

export function oauthStateStore(redis = getRedis()) {
  return {
    async save(state: string, data: PendingAuth): Promise<void> {
      await redis.set(PREFIX + state, JSON.stringify(data), "EX", TTL_SECONDS);
    },
    async take(state: string): Promise<PendingAuth | null> {
      const key = PREFIX + state;
      const raw = await redis.get(key);
      if (!raw) return null;
      await redis.del(key); // single-use
      return JSON.parse(raw) as PendingAuth;
    },
  };
}
