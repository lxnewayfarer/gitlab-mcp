import { getConfig } from "../config/index.js";
import { getRedis } from "../database/redis.js";
import { randomToken, sha256, encrypt, decrypt } from "./crypto.js";

/**
 * Short-lived store for the authorization codes this server issues to MCP
 * clients. The raw code is returned once; only its sha-256 hash is a Redis key.
 * The bound session token is encrypted at rest. TTL is OAUTH_CODE_TTL_SECONDS,
 * single-use via atomic delete on consume.
 */
const PREFIX = "oauth:code:";

export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  sessionId: string;
  userId: string;
  sessionToken: string;
}

export function authCodeStore(redis = getRedis()) {
  return {
    async issue(data: AuthCodeData): Promise<string> {
      const cfg = getConfig();
      const code = randomToken(32);
      const stored = { ...data, sessionToken: encrypt(data.sessionToken) };
      await redis.set(PREFIX + sha256(code), JSON.stringify(stored), "EX", cfg.OAUTH_CODE_TTL_SECONDS);
      return code;
    },

    async peekChallenge(code: string): Promise<string | null> {
      const raw = await redis.get(PREFIX + sha256(code));
      if (!raw) return null;
      return (JSON.parse(raw) as { codeChallenge: string }).codeChallenge;
    },

    async consume(code: string): Promise<AuthCodeData | null> {
      const key = PREFIX + sha256(code);
      const raw = await redis.get(key);
      if (!raw) return null;
      await redis.del(key);
      const stored = JSON.parse(raw) as AuthCodeData;
      return { ...stored, sessionToken: decrypt(stored.sessionToken) };
    },
  };
}
