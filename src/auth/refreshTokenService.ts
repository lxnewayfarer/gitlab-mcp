import { getConfig } from "../config/index.js";
import { randomToken, sha256 } from "./crypto.js";
import { oauthRefreshTokenRepository } from "../repositories/oauthRefreshTokenRepository.js";

/**
 * Issues and validates opaque refresh tokens for MCP clients. The raw token is
 * never stored — only its sha-256 hash. Rotation revokes the old token and
 * issues a new one (defense against refresh-token theft).
 */
export function refreshTokenService(deps?: {
  repo?: ReturnType<typeof oauthRefreshTokenRepository>;
}) {
  const repo = deps?.repo ?? oauthRefreshTokenRepository();

  return {
    async issue(userId: string, clientId: string): Promise<{ token: string; expiresAt: Date }> {
      const cfg = getConfig();
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + cfg.OAUTH_REFRESH_TTL_HOURS * 3600 * 1000);
      await repo.create({ userId, clientId, tokenHash: sha256(token), expiresAt });
      return { token, expiresAt };
    },

    async validate(token: string): Promise<{ userId: string; clientId: string } | null> {
      const row = await repo.findByHash(sha256(token));
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;
      return { userId: row.userId, clientId: row.clientId };
    },

    async revoke(token: string): Promise<void> {
      await repo.revokeByHash(sha256(token), new Date());
    },

    async rotate(oldToken: string, userId: string, clientId: string): Promise<{ token: string; expiresAt: Date }> {
      await repo.revokeByHash(sha256(oldToken), new Date());
      return this.issue(userId, clientId);
    },

    /** Revoke all refresh tokens belonging to a user (e.g. on logout). */
    async revokeAllForUser(userId: string): Promise<void> {
      await repo.revokeAllForUser(userId, new Date());
    },
  };
}
