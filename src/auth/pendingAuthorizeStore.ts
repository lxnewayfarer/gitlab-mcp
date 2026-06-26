import { getRedis } from "../database/redis.js";

/**
 * Short-lived store for an MCP client's authorize request while the user is
 * redirected through GitLab. Keyed by the internal GitLab `state`. Redis,
 * 10-minute TTL, single-use.
 */
const PREFIX = "oauth:pending:";
const TTL_SECONDS = 600;

export interface PendingAuthorize {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
}

export function pendingAuthorizeStore(redis = getRedis()) {
  return {
    async save(internalState: string, data: PendingAuthorize): Promise<void> {
      await redis.set(PREFIX + internalState, JSON.stringify(data), "EX", TTL_SECONDS);
    },
    async take(internalState: string): Promise<PendingAuthorize | null> {
      const key = PREFIX + internalState;
      const raw = await redis.get(key);
      if (!raw) return null;
      await redis.del(key);
      return JSON.parse(raw) as PendingAuthorize;
    },
  };
}
