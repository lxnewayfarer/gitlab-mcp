import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function sessionRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | null;
      ip?: string | null;
    }) {
      return db.session.create({ data: params });
    },

    async findActiveByHash(tokenHash: string) {
      return db.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
    },

    async revokeByHash(tokenHash: string, when: Date) {
      return db.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: when },
      });
    },

    /**
     * Revoke every active session for a user. Returns the affected token hashes
     * so the caller can purge them from the session cache.
     */
    async revokeAllForUser(userId: string, when: Date): Promise<string[]> {
      const active = await db.session.findMany({
        where: { userId, revokedAt: null },
        select: { tokenHash: true },
      });
      if (active.length === 0) return [];
      await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: when },
      });
      return active.map((s) => s.tokenHash);
    },
  };
}
