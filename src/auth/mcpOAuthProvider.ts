import type { Response } from "express";
import { createHash } from "node:crypto";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { oauthClientStore } from "./oauthClientStore.js";
import { oauthStateStore } from "./oauthStateStore.js";
import { pendingAuthorizeStore } from "./pendingAuthorizeStore.js";
import { authCodeStore } from "./authCodeStore.js";
import { sessionService } from "./sessionService.js";
import { refreshTokenService } from "./refreshTokenService.js";
import { startGitLabLogin } from "../http/authRoutes.js";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function mcpOAuthProvider(deps?: {
  clients?: OAuthRegisteredClientsStore;
  stateStore?: ReturnType<typeof oauthStateStore>;
  pendingStore?: ReturnType<typeof pendingAuthorizeStore>;
  codeStore?: ReturnType<typeof authCodeStore>;
  sessions?: ReturnType<typeof sessionService>;
  refresh?: ReturnType<typeof refreshTokenService>;
  startLogin?: typeof startGitLabLogin;
}): OAuthServerProvider {
  const clients = deps?.clients ?? oauthClientStore();
  const stateStore = deps?.stateStore ?? oauthStateStore();
  const pendingStore = deps?.pendingStore ?? pendingAuthorizeStore();
  const codeStore = deps?.codeStore ?? authCodeStore();
  const sessions = deps?.sessions ?? sessionService();
  const refresh = deps?.refresh ?? refreshTokenService();
  const startLogin = deps?.startLogin ?? startGitLabLogin;

  return {
    // Tell the SDK's token handler to skip its own PKCE verification and pass
    // the code_verifier through to exchangeAuthorizationCode, which performs its
    // own S256 check. This keeps all PKCE logic in one place.
    skipLocalPkceValidation: true as const,

    get clientsStore(): OAuthRegisteredClientsStore {
      return clients;
    },

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      const url = await startLogin(
        { stateStore, pendingStore },
        {
          pending: {
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            clientState: params.state,
            codeChallenge: params.codeChallenge,
          },
        },
      );
      res.redirect(url);
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const challenge = await codeStore.peekChallenge(authorizationCode);
      if (!challenge) throw new InvalidGrantError("Unknown or expired authorization code");
      return challenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      codeVerifier?: string,
      redirectUri?: string,
      // resource is part of the SDK interface but not used by this server
      _resource?: URL,
    ): Promise<OAuthTokens> {
      const data = await codeStore.consume(authorizationCode);
      if (!data) throw new InvalidGrantError("Invalid or expired authorization code");
      if (data.clientId !== client.client_id) throw new InvalidGrantError("Code was issued to a different client");
      if (redirectUri !== undefined && redirectUri !== data.redirectUri) {
        throw new InvalidGrantError("redirect_uri mismatch");
      }
      if (!codeVerifier || s256(codeVerifier) !== data.codeChallenge) {
        throw new InvalidGrantError("PKCE verification failed");
      }

      const { token: refreshToken } = await refresh.issue(data.userId, client.client_id);
      return {
        access_token: data.sessionToken,
        token_type: "bearer",
        refresh_token: refreshToken,
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      // scopes and resource are part of the SDK interface but not used by this server
      _scopes?: string[],
      _resource?: URL,
    ): Promise<OAuthTokens> {
      const ctx = await refresh.validate(refreshToken);
      if (!ctx || ctx.clientId !== client.client_id) {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }
      // sessionService.issue needs a User; we only have userId here.
      // issue() reads only user.id, so passing a minimal object is safe.
      const { token: accessToken } = await sessions.issue({ id: ctx.userId } as never);
      const { token: newRefresh } = await refresh.rotate(refreshToken, ctx.userId, client.client_id);
      return {
        access_token: accessToken,
        token_type: "bearer",
        refresh_token: newRefresh,
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const ctx = await sessions.validate(token);
      if (!ctx) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: "", // not tracked per-session; resource server does not need it
        scopes: [],
        // SDK bearerAuth middleware requires expiresAt as Unix seconds (number).
        expiresAt: Math.floor(ctx.expiresAt.getTime() / 1000),
        extra: { userId: ctx.userId, sessionId: ctx.sessionId },
      };
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      // RFC 7009: revocation must be best-effort — never throw for unknown/garbage tokens.
      // Cascade: resolve userId from whichever token type was presented, then revoke
      // that token AND all refresh tokens for the user so the rotation chain is fully severed.
      const token = request.token;

      // Try as refresh token first.
      const refreshCtx = await refresh.validate(token).catch(() => null);
      if (refreshCtx) {
        await refresh.revoke(token).catch(() => undefined);
        await refresh.revokeAllForUser(refreshCtx.userId).catch(() => undefined);
        return;
      }

      // Try as access (session) token.
      const sessionCtx = await sessions.validate(token).catch(() => null);
      if (sessionCtx) {
        await sessions.revoke(token).catch(() => undefined);
        await refresh.revokeAllForUser(sessionCtx.userId).catch(() => undefined);
        return;
      }

      // Unknown/garbage token — silently ignore per RFC 7009.
    },
  };
}
