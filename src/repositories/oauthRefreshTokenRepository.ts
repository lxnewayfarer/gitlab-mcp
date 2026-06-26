import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function oauthRefreshTokenRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: { userId: string; clientId: string; tokenHash: string; expiresAt: Date }) {
      return db.oAuthRefreshToken.create({ data: params });
    },

    async findByHash(tokenHash: string) {
      return db.oAuthRefreshToken.findUnique({ where: { tokenHash } });
    },

    async revokeByHash(tokenHash: string, when: Date) {
      return db.oAuthRefreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: when },
      });
    },

    async revokeAllForUser(userId: string, when: Date) {
      return db.oAuthRefreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: when },
      });
    },
  };
}
