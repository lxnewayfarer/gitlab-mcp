import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config/index.js";
import { sessionService } from "../auth/sessionService.js";
import { userRepository } from "../repositories/userRepository.js";
import type { AuthContext } from "../mcp/types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authCtx?: AuthContext;
    }
  }
}

/**
 * Validates the `Authorization: Bearer <session-token>` header, loads the user,
 * and attaches an AuthContext to the request. Rejects with 401 otherwise.
 */
export function bearerAuth(deps?: {
  sessions?: ReturnType<typeof sessionService>;
  users?: ReturnType<typeof userRepository>;
}) {
  const sessions = deps?.sessions ?? sessionService();
  const users = deps?.users ?? userRepository();

  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const cfg = getConfig();
    const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
    const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
    const unauthorized = (error: string, message: string): void => {
      res.setHeader("WWW-Authenticate", challenge);
      res.status(401).json({ error, message });
    };

    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      unauthorized("missing_bearer_token", "Provide 'Authorization: Bearer <token>'. Get a token at /auth/login.");
      return;
    }

    const ctx = await sessions.validate(match[1]);
    if (!ctx) {
      unauthorized("invalid_session", "Session is invalid, expired, or revoked. Log in again at /auth/login.");
      return;
    }

    const user = await users.findById(ctx.userId);
    if (!user) {
      unauthorized("user_not_found", "User no longer exists.");
      return;
    }

    req.authCtx = {
      userId: user.id,
      gitlabUserId: user.gitlabUserId,
      username: user.username,
    };
    next();
  };
}
