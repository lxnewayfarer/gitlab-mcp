# MCP Client-Driven OAuth 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MCP clients (Claude Code) authenticate to this server via a browser OAuth flow — discover metadata, self-register, log in once with GitLab — instead of pasting an opaque token.

**Architecture:** The server becomes an OAuth 2.0 Authorization Server (AS) toward the client while remaining an OAuth client toward GitLab. We implement the MCP SDK's `OAuthServerProvider` interface and mount `mcpAuthRouter` (which serves discovery, DCR, `/authorize`, `/token`, `/revoke`). The provider parks the client's authorize request, redirects the browser into the *existing* GitLab login leg, and on GitLab callback issues our own authorization code bound to a freshly issued session. `/token` returns the existing opaque session token as the `access_token` plus a rotating opaque refresh token. The legacy manual `/auth/login` HTML flow is preserved as a fallback.

**Tech Stack:** TypeScript (ESM, Node 22+), `@modelcontextprotocol/sdk@^1.12.0` (`/server/auth/*` subpath exports), Express, Prisma + PostgreSQL, Redis (ioredis), Vitest.

## Global Constraints

- **Only `GitLabService` calls GitLab.** This feature adds no GitLab calls beyond the existing `gitlabOAuth` helpers. Do not `fetch` GitLab elsewhere.
- **GitLab tokens never leave the server.** The client only ever receives our opaque session/refresh tokens. GitLab access/refresh stay encrypted in `OAuthAccount`.
- **Secrets stored only as sha-256 hashes** (use `sha256` from `src/auth/crypto.ts`). Raw tokens/codes never persisted.
- **Config comes from `src/config`** (zod-validated). Never read `process.env` elsewhere.
- **No new tools.** The 9-tool surface is unchanged.
- **ESM imports** use explicit `.js` extensions on local paths (e.g. `"../auth/crypto.js"`). SDK auth imports use `@modelcontextprotocol/sdk/server/auth/<file>.js`.
- **PKCE is mandatory** on the client leg; `code_challenge_method=S256` only.
- **Prisma model conventions:** `String @id @default(cuid())`, `createdAt @default(now())`, `updatedAt @updatedAt`, `@@map` snake_case, sha-256 hash columns `@unique`.
- **Run tests with** `npm test -- <path>` (vitest). Typecheck with `npm run typecheck`.

---

## File Structure

**Create:**
- `prisma/schema.prisma` — add `OAuthClient`, `OAuthRefreshToken` models (modify)
- `src/repositories/oauthClientRepository.ts` — Prisma access for `OAuthClient`
- `src/repositories/oauthRefreshTokenRepository.ts` — Prisma access for `OAuthRefreshToken`
- `src/auth/refreshTokenService.ts` — issue/validate/rotate/revoke opaque refresh tokens
- `src/auth/authCodeStore.ts` — Redis store for our short-lived authorization codes
- `src/auth/pendingAuthorizeStore.ts` — Redis store for the parked client authorize request
- `src/auth/oauthClientStore.ts` — adapts `oauthClientRepository` to the SDK `OAuthRegisteredClientsStore` interface
- `src/auth/mcpOAuthProvider.ts` — the SDK `OAuthServerProvider` implementation
- Tests alongside in `tests/unit/` and `tests/integration/`

**Modify:**
- `src/config/index.ts` — add `OAUTH_CODE_TTL_SECONDS`, `OAUTH_REFRESH_TTL_HOURS`
- `src/middleware/bearerAuth.ts` — add `WWW-Authenticate` header to 401s
- `src/http/authRoutes.ts` — OAuth branch in `/callback`; start GitLab leg with a caller-supplied internal state
- `src/http/app.ts` — mount `mcpAuthRouter`

---

### Task 1: Config — add OAuth TTL settings

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/unit/config.test.ts` (create if absent)

**Interfaces:**
- Produces: `AppConfig.OAUTH_CODE_TTL_SECONDS: number`, `AppConfig.OAUTH_REFRESH_TTL_HOURS: number`

- [ ] **Step 1: Write the failing test**

Create/append `tests/unit/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/index.js";

const base = {
  DATABASE_URL: "postgresql://x",
  GITLAB_CLIENT_ID: "id",
  GITLAB_CLIENT_SECRET: "secret",
  GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback",
  ENCRYPTION_KEY: "a".repeat(64), // 64 hex chars = 32 bytes
};

describe("config OAuth TTLs", () => {
  it("defaults code TTL to 60s and refresh TTL to 720h", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(60);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(720);
  });

  it("reads overrides from env", () => {
    const cfg = loadConfig({ ...base, OAUTH_CODE_TTL_SECONDS: "30", OAUTH_REFRESH_TTL_HOURS: "168" } as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(30);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(168);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config.test.ts`
Expected: FAIL — `OAUTH_CODE_TTL_SECONDS` is `undefined`.

- [ ] **Step 3: Add the fields to the zod schema**

In `src/config/index.ts`, inside the `z.object({ ... })`, after the `TOKEN_REFRESH_SKEW_SECONDS` line, add:

```typescript
  // TTL for our short-lived authorization codes issued to MCP clients.
  OAUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // TTL for opaque refresh tokens issued to MCP clients (default 30 days).
  OAUTH_REFRESH_TTL_HOURS: z.coerce.number().int().positive().default(720),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Update `.env.example`**

Append under the Sessions/tokens section of `.env.example`:

```
# OAuth (MCP client-driven). Code TTL is short; refresh TTL longer.
OAUTH_CODE_TTL_SECONDS=60
OAUTH_REFRESH_TTL_HOURS=720
```

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts tests/unit/config.test.ts .env.example
git commit -m "feat(config): add OAuth code/refresh TTL settings"
```

---

### Task 2: Prisma models — OAuthClient & OAuthRefreshToken

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma models `OAuthClient` (fields: `id`, `clientId @unique`, `clientName?`, `redirectUris String[]`, `grantTypes String[]`, `clientSecretHash?`, timestamps) and `OAuthRefreshToken` (fields: `id`, `tokenHash @unique`, `userId`, `clientId`, `expiresAt`, `revokedAt?`, timestamps; relation to `User`).

- [ ] **Step 1: Add the models**

Append to `prisma/schema.prisma`:

```prisma
model OAuthClient {
  id               String   @id @default(cuid())
  clientId         String   @unique
  clientName       String?
  redirectUris     String[]
  grantTypes       String[] @default(["authorization_code", "refresh_token"])
  clientSecretHash String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@map("oauth_clients")
}

model OAuthRefreshToken {
  id        String    @id @default(cuid())
  tokenHash String    @unique
  userId    String
  clientId  String
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("oauth_refresh_tokens")
}
```

- [ ] **Step 2: Add the back-relation to `User`**

In the `User` model, after the `auditLogs    AuditLog[]` line, add:

```prisma
  oauthRefreshTokens OAuthRefreshToken[]
```

- [ ] **Step 3: Generate client and create migration**

Run: `npm run db:generate`
Expected: Prisma client regenerates without error.

Run: `npx prisma migrate dev --name mcp_oauth_client_tokens`
Expected: New migration created and applied; `oauth_clients` and `oauth_refresh_tokens` tables exist. (If no local DB is available, run `npx prisma migrate diff` to generate the SQL and commit the migration file; note this in the commit.)

- [ ] **Step 4: Verify types compile**

Run: `npm run typecheck`
Expected: PASS (no usages yet, just schema/client generation).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add OAuthClient and OAuthRefreshToken models"
```

---

### Task 3: oauthClientRepository

**Files:**
- Create: `src/repositories/oauthClientRepository.ts`
- Test: `tests/unit/oauthClientRepository.test.ts`

**Interfaces:**
- Consumes: `getPrisma()` from `src/database/prisma.js` (pattern from `sessionRepository.ts`).
- Produces: `oauthClientRepository(db?)` returning `{ create(params), findByClientId(clientId) }` where
  `params = { clientId: string; clientName?: string | null; redirectUris: string[]; grantTypes: string[]; clientSecretHash?: string | null }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { oauthClientRepository } from "../../src/repositories/oauthClientRepository.js";

function fakeDb() {
  return {
    oAuthClient: {
      create: vi.fn(async ({ data }: any) => ({ id: "c1", ...data })),
      findUnique: vi.fn(async ({ where }: any) =>
        where.clientId === "known" ? { id: "c1", clientId: "known", redirectUris: ["http://cb"], grantTypes: [], clientName: null, clientSecretHash: null } : null,
      ),
    },
  } as any;
}

describe("oauthClientRepository", () => {
  it("creates a client", async () => {
    const db = fakeDb();
    const repo = oauthClientRepository(db);
    const c = await repo.create({ clientId: "abc", redirectUris: ["http://cb"], grantTypes: ["authorization_code"] });
    expect(db.oAuthClient.create).toHaveBeenCalledOnce();
    expect(c.clientId).toBe("abc");
  });

  it("finds by clientId", async () => {
    const repo = oauthClientRepository(fakeDb());
    expect(await repo.findByClientId("known")).not.toBeNull();
    expect(await repo.findByClientId("missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/oauthClientRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function oauthClientRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: {
      clientId: string;
      clientName?: string | null;
      redirectUris: string[];
      grantTypes: string[];
      clientSecretHash?: string | null;
    }) {
      return db.oAuthClient.create({
        data: {
          clientId: params.clientId,
          clientName: params.clientName ?? null,
          redirectUris: params.redirectUris,
          grantTypes: params.grantTypes,
          clientSecretHash: params.clientSecretHash ?? null,
        },
      });
    },

    async findByClientId(clientId: string) {
      return db.oAuthClient.findUnique({ where: { clientId } });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/oauthClientRepository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repositories/oauthClientRepository.ts tests/unit/oauthClientRepository.test.ts
git commit -m "feat(repo): oauthClientRepository"
```

---

### Task 4: oauthRefreshTokenRepository

**Files:**
- Create: `src/repositories/oauthRefreshTokenRepository.ts`
- Test: `tests/unit/oauthRefreshTokenRepository.test.ts`

**Interfaces:**
- Produces: `oauthRefreshTokenRepository(db?)` returning
  `{ create({ userId, clientId, tokenHash, expiresAt }), findByHash(tokenHash), revokeByHash(tokenHash, when), revokeAllForUser(userId, when) }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { oauthRefreshTokenRepository } from "../../src/repositories/oauthRefreshTokenRepository.js";

function fakeDb() {
  return {
    oAuthRefreshToken: {
      create: vi.fn(async ({ data }: any) => ({ id: "r1", ...data })),
      findUnique: vi.fn(async ({ where }: any) =>
        where.tokenHash === "h" ? { id: "r1", tokenHash: "h", userId: "u1", clientId: "c1", expiresAt: new Date(Date.now() + 1e6), revokedAt: null } : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  } as any;
}

describe("oauthRefreshTokenRepository", () => {
  it("creates, finds, revokes", async () => {
    const db = fakeDb();
    const repo = oauthRefreshTokenRepository(db);
    await repo.create({ userId: "u1", clientId: "c1", tokenHash: "h", expiresAt: new Date() });
    expect(db.oAuthRefreshToken.create).toHaveBeenCalledOnce();
    expect(await repo.findByHash("h")).not.toBeNull();
    await repo.revokeByHash("h", new Date());
    expect(db.oAuthRefreshToken.updateMany).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/oauthRefreshTokenRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/oauthRefreshTokenRepository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repositories/oauthRefreshTokenRepository.ts tests/unit/oauthRefreshTokenRepository.test.ts
git commit -m "feat(repo): oauthRefreshTokenRepository"
```

---

### Task 5: refreshTokenService (issue / validate / rotate / revoke)

**Files:**
- Create: `src/auth/refreshTokenService.ts`
- Test: `tests/unit/refreshTokenService.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256` from `src/auth/crypto.js`; `oauthRefreshTokenRepository`; `getConfig().OAUTH_REFRESH_TTL_HOURS`.
- Produces: `refreshTokenService(deps?)` returning
  - `issue(userId: string, clientId: string): Promise<{ token: string; expiresAt: Date }>`
  - `validate(token: string): Promise<{ userId: string; clientId: string } | null>` (rejects expired/revoked)
  - `revoke(token: string): Promise<void>`
  - `rotate(oldToken: string, userId: string, clientId: string): Promise<{ token: string; expiresAt: Date }>` (revokes old hash, issues new)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { sha256 } from "../../src/auth/crypto.js";
import { refreshTokenService } from "../../src/auth/refreshTokenService.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

function fakeRepo() {
  const rows = new Map<string, any>();
  return {
    rows,
    async create({ userId, clientId, tokenHash, expiresAt }: any) {
      const row = { id: "r" + rows.size, userId, clientId, tokenHash, expiresAt, revokedAt: null };
      rows.set(tokenHash, row); return row;
    },
    async findByHash(h: string) { return rows.get(h) ?? null; },
    async revokeByHash(h: string, when: Date) { const r = rows.get(h); if (r) r.revokedAt = when; return { count: r ? 1 : 0 }; },
    async revokeAllForUser() { return { count: 0 }; },
  };
}

describe("refreshTokenService", () => {
  it("issues a token and validates it", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    const ctx = await svc.validate(token);
    expect(ctx).toEqual({ userId: "u1", clientId: "c1" });
  });

  it("rejects a revoked token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it("rotate revokes old and issues new", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token: old } = await svc.issue("u1", "c1");
    const { token: fresh } = await svc.rotate(old, "u1", "c1");
    expect(await svc.validate(old)).toBeNull();
    expect(await svc.validate(fresh)).toEqual({ userId: "u1", clientId: "c1" });
    expect(repo.rows.get(sha256(old))!.revokedAt).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    repo.rows.get(sha256(token))!.expiresAt = new Date(Date.now() - 1000);
    expect(await svc.validate(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/refreshTokenService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
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
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/refreshTokenService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/refreshTokenService.ts tests/unit/refreshTokenService.test.ts
git commit -m "feat(auth): refresh token service with rotation"
```

---

### Task 6: pendingAuthorizeStore (Redis — parked client request)

**Files:**
- Create: `src/auth/pendingAuthorizeStore.ts`
- Test: `tests/unit/pendingAuthorizeStore.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from `src/database/redis.js` (pattern from `oauthStateStore.ts`).
- Produces: `pendingAuthorizeStore(redis?)` returning `{ save(internalState, data), take(internalState) }` where
  `data: PendingAuthorize = { clientId: string; redirectUri: string; clientState?: string; codeChallenge: string }`. TTL 600s, single-use `take`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { pendingAuthorizeStore } from "../../src/auth/pendingAuthorizeStore.js";

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async set(k: string, v: string) { m.set(k, v); },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { m.delete(k); },
  } as any;
}

describe("pendingAuthorizeStore", () => {
  it("saves and takes once", async () => {
    const store = pendingAuthorizeStore(fakeRedis());
    await store.save("state_b", { clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    const first = await store.take("state_b");
    expect(first).toEqual({ clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    expect(await store.take("state_b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/pendingAuthorizeStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
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
```

Note: the fake redis in the test omits the `"EX", ttl` args; ioredis accepts them at runtime and the fake ignores extras. Keep the real `set(key, val, "EX", TTL_SECONDS)` signature (matches `oauthStateStore.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/pendingAuthorizeStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/pendingAuthorizeStore.ts tests/unit/pendingAuthorizeStore.test.ts
git commit -m "feat(auth): redis store for parked client authorize request"
```

---

### Task 7: authCodeStore (Redis — our authorization codes)

**Files:**
- Create: `src/auth/authCodeStore.ts`
- Test: `tests/unit/authCodeStore.test.ts`

**Interfaces:**
- Consumes: `getRedis()`; `randomToken`, `sha256` from `src/auth/crypto.js`; `getConfig().OAUTH_CODE_TTL_SECONDS`.
- Produces: `authCodeStore(redis?)` returning
  - `issue(data: AuthCodeData): Promise<string>` (returns raw code; stores hash→data with code TTL)
  - `peekChallenge(code: string): Promise<string | null>` (non-consuming; for `challengeForAuthorizationCode`)
  - `consume(code: string): Promise<AuthCodeData | null>` (single-use; atomic delete)
  - where `AuthCodeData = { clientId: string; redirectUri: string; codeChallenge: string; sessionId: string; userId: string; sessionToken: string }`.

  Note: `sessionToken` is the raw opaque session token, stored in Redis only for the code's ~60s lifetime so `/token` can return it as the `access_token`. It is encrypted at rest via `encrypt()` to avoid storing a usable bearer token in plaintext in Redis.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { authCodeStore } from "../../src/auth/authCodeStore.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    async set(k: string, v: string) { m.set(k, v); },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { m.delete(k); },
  } as any;
}

const data = {
  clientId: "c1", redirectUri: "http://cb", codeChallenge: "chal",
  sessionId: "s1", userId: "u1", sessionToken: "raw-session-token",
};

describe("authCodeStore", () => {
  it("issues a code, peeks challenge, consumes once returning data", async () => {
    const store = authCodeStore(fakeRedis());
    const code = await store.issue(data);
    expect(await store.peekChallenge(code)).toBe("chal");
    const got = await store.consume(code);
    expect(got).toEqual(data);
    expect(await store.consume(code)).toBeNull(); // single-use
  });

  it("returns null for unknown code", async () => {
    const store = authCodeStore(fakeRedis());
    expect(await store.consume("nope")).toBeNull();
    expect(await store.peekChallenge("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/authCodeStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { getConfig } from "../config/index.js";
import { getRedis } from "../database/redis.js";
import { randomToken, sha256 } from "./crypto.js";
import { encrypt, decrypt } from "./crypto.js";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/authCodeStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/authCodeStore.ts tests/unit/authCodeStore.test.ts
git commit -m "feat(auth): redis store for issued authorization codes"
```

---

### Task 8: oauthClientStore (adapter to SDK OAuthRegisteredClientsStore)

**Files:**
- Create: `src/auth/oauthClientStore.ts`
- Test: `tests/unit/oauthClientStore.test.ts`

**Interfaces:**
- Consumes: `oauthClientRepository`; `randomToken` from `src/auth/crypto.js`; SDK types from `@modelcontextprotocol/sdk/shared/auth.js` (`OAuthClientInformationFull`).
- Produces: `oauthClientStore(deps?)` implementing the SDK `OAuthRegisteredClientsStore`:
  - `getClient(clientId): Promise<OAuthClientInformationFull | undefined>`
  - `registerClient(client): Promise<OAuthClientInformationFull>` — generates `client_id`, persists, returns full info. Public PKCE clients only (no secret).
- The SDK calls these; we map our Prisma row ⇄ the SDK's `OAuthClientInformationFull` shape (`client_id`, `redirect_uris`, `grant_types`, `client_name`, `token_endpoint_auth_method: "none"`, `client_id_issued_at`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { oauthClientStore } from "../../src/auth/oauthClientStore.js";

function fakeRepo() {
  const byId = new Map<string, any>();
  return {
    byId,
    async create(p: any) { const row = { id: "x", clientSecretHash: null, clientName: p.clientName ?? null, ...p }; byId.set(p.clientId, row); return row; },
    async findByClientId(id: string) { return byId.get(id) ?? null; },
  };
}

describe("oauthClientStore", () => {
  it("registers a client and assigns a client_id", async () => {
    const repo = fakeRepo();
    const store = oauthClientStore({ repo: repo as any });
    const info = await store.registerClient!({
      redirect_uris: ["http://localhost:7777/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      client_name: "Claude Code",
      token_endpoint_auth_method: "none",
    } as any);
    expect(info.client_id).toBeTruthy();
    expect(info.redirect_uris).toEqual(["http://localhost:7777/callback"]);
    expect(repo.byId.has(info.client_id)).toBe(true);
  });

  it("getClient maps a stored row to full info", async () => {
    const repo = fakeRepo();
    const store = oauthClientStore({ repo: repo as any });
    const reg = await store.registerClient!({ redirect_uris: ["http://cb"], grant_types: ["authorization_code"] } as any);
    const got = await store.getClient(reg.client_id);
    expect(got?.client_id).toBe(reg.client_id);
    expect(got?.redirect_uris).toEqual(["http://cb"]);
  });

  it("getClient returns undefined for unknown id", async () => {
    const store = oauthClientStore({ repo: fakeRepo() as any });
    expect(await store.getClient("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/oauthClientStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { randomToken } from "./crypto.js";
import { oauthClientRepository } from "../repositories/oauthClientRepository.js";

/**
 * Adapts our OAuthClient table to the SDK's registered-clients store, which the
 * SDK's DCR handler uses. Public PKCE clients only — no client secret.
 */
export function oauthClientStore(deps?: {
  repo?: ReturnType<typeof oauthClientRepository>;
}): OAuthRegisteredClientsStore {
  const repo = deps?.repo ?? oauthClientRepository();

  function toFull(row: {
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
    grantTypes: string[];
  }): OAuthClientInformationFull {
    return {
      client_id: row.clientId,
      redirect_uris: row.redirectUris as [string, ...string[]],
      grant_types: row.grantTypes,
      client_name: row.clientName ?? undefined,
      token_endpoint_auth_method: "none",
    };
  }

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const row = await repo.findByClientId(clientId);
      return row ? toFull(row) : undefined;
    },

    async registerClient(
      client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    ): Promise<OAuthClientInformationFull> {
      const metadata = client as OAuthClientMetadata;
      const clientId = randomToken(16);
      const row = await repo.create({
        clientId,
        clientName: metadata.client_name ?? null,
        redirectUris: [...metadata.redirect_uris],
        grantTypes: metadata.grant_types ?? ["authorization_code", "refresh_token"],
        clientSecretHash: null,
      });
      return {
        ...toFull(row),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/oauthClientStore.test.ts`
Expected: PASS

- [ ] **Step 5: Verify typecheck against SDK types**

Run: `npm run typecheck`
Expected: PASS — confirms the import paths and `OAuthClientInformationFull` shape are correct.

- [ ] **Step 6: Commit**

```bash
git add src/auth/oauthClientStore.ts tests/unit/oauthClientStore.test.ts
git commit -m "feat(auth): SDK clients-store adapter with DCR"
```

---

### Task 9: bearerAuth — add WWW-Authenticate header

**Files:**
- Modify: `src/middleware/bearerAuth.ts`
- Test: `tests/unit/bearerAuth.test.ts` (create if absent)

**Interfaces:**
- Consumes: existing `bearerAuth(deps?)`.
- Produces: 401 responses now carry header
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { bearerAuth } from "../../src/middleware/bearerAuth.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

function mockRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

describe("bearerAuth WWW-Authenticate", () => {
  it("sets WWW-Authenticate on missing token", async () => {
    const mw = bearerAuth({ sessions: { validate: vi.fn() } as any, users: {} as any });
    const req = { header: () => "" } as any;
    const res = mockRes();
    await mw(req as any, res as any, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"');
  });

  it("sets WWW-Authenticate on invalid session", async () => {
    const mw = bearerAuth({ sessions: { validate: vi.fn(async () => null) } as any, users: {} as any });
    const req = { header: (h: string) => (h.toLowerCase() === "authorization" ? "Bearer bad" : "") } as any;
    const res = mockRes();
    await mw(req as any, res as any, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/bearerAuth.test.ts`
Expected: FAIL — header not set.

- [ ] **Step 3: Implement**

In `src/middleware/bearerAuth.ts`:

Add the import at the top:

```typescript
import { getConfig } from "../config/index.js";
```

Inside the returned middleware function, before the body, add a helper and set the header on every 401. Replace the three 401 blocks so each calls a local `unauthorized`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/bearerAuth.test.ts`
Expected: PASS

- [ ] **Step 5: Run the existing suite to confirm no regression**

Run: `npm test`
Expected: PASS (existing bearerAuth integration tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/middleware/bearerAuth.ts tests/unit/bearerAuth.test.ts
git commit -m "feat(auth): advertise OAuth resource metadata via WWW-Authenticate"
```

---

### Task 10: authRoutes — start GitLab leg with caller state; OAuth branch in /callback

**Files:**
- Modify: `src/http/authRoutes.ts`
- Test: `tests/integration/authCallbackOAuth.test.ts`

**Interfaces:**
- Consumes: existing `exchangeCode`, `fetchGitLabUser`, `buildAuthorizeUrl`, `generatePkce`; `oauthStateStore`; `sessionService`; `userRepository`; `oauthAccountRepository`; and now `pendingAuthorizeStore`, `authCodeStore`.
- Produces:
  - A reusable exported helper `startGitLabLogin(deps, opts?)` that creates internal `state`, stores the PKCE verifier, and returns the GitLab authorize URL. `opts.pending?: PendingAuthorize` — when present, the callback will treat this as an OAuth-client flow.
  - `/auth/callback` gains a branch: if `pendingAuthorizeStore.take(internalState)` returns a parked request, issue an auth code (`authCodeStore.issue`) bound to the freshly issued session and redirect to `redirectUri?code=...&state=...`. Otherwise, fall back to the existing HTML page.
- The provider (Task 11) calls `startGitLabLogin` to begin the GitLab leg.

- [ ] **Step 1: Write the failing integration test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { authRoutes } from "../../src/http/authRoutes.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

// In-memory fakes
function fakes() {
  const pending = new Map<string, any>();
  const states = new Map<string, any>();
  let issuedCode = "";
  return {
    stateStore: {
      async save(s: string, d: any) { states.set(s, d); },
      async take(s: string) { const v = states.get(s); states.delete(s); return v ?? null; },
    },
    pendingStore: {
      async save(s: string, d: any) { pending.set(s, d); },
      async take(s: string) { const v = pending.get(s); pending.delete(s); return v ?? null; },
    },
    codeStore: {
      async issue(_d: any) { issuedCode = "the-code"; return issuedCode; },
      async consume() { return null; },
      async peekChallenge() { return null; },
    },
    sessions: { async issue() { return { token: "sess-tok", expiresAt: new Date(Date.now() + 1e6) }; } },
    users: { async upsertFromGitLab() { return { id: "u1", username: "alice", gitlabUserId: 1, name: "Alice" }; } },
    accounts: { async upsert() {} },
    get issuedCode() { return issuedCode; },
  };
}

describe("/auth/callback OAuth branch", () => {
  it("redirects to the client redirect_uri with code+state when an OAuth request is parked", async () => {
    const f = fakes();
    // Pre-park an OAuth request keyed by the internal state we will use.
    await f.pendingStore.save("st1", { clientId: "c1", redirectUri: "http://localhost:7777/cb", clientState: "cstate", codeChallenge: "chal" });
    // Pre-store the PKCE verifier for that state (as startGitLabLogin would have).
    await f.stateStore.save("st1", { verifier: "v" });

    const exchangeCode = vi.fn(async () => ({ tokens: { access_token: "gl", token_type: "bearer" }, expiresAt: null }));
    const fetchGitLabUser = vi.fn(async () => ({ id: 1, username: "alice", name: "Alice", email: null }));

    const app = express();
    app.use("/auth", authRoutes({
      stateStore: f.stateStore as any, pendingStore: f.pendingStore as any, codeStore: f.codeStore as any,
      sessions: f.sessions as any, users: f.users as any, accounts: f.accounts as any,
      exchangeCode, fetchGitLabUser,
    }));

    const res = await request(app).get("/auth/callback?code=glcode&state=st1");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe("http://localhost:7777/cb");
    expect(loc.searchParams.get("code")).toBe("the-code");
    expect(loc.searchParams.get("state")).toBe("cstate");
  });

  it("falls back to HTML page when no OAuth request is parked", async () => {
    const f = fakes();
    await f.stateStore.save("st2", { verifier: "v" });
    const exchangeCode = vi.fn(async () => ({ tokens: { access_token: "gl", token_type: "bearer" }, expiresAt: null }));
    const fetchGitLabUser = vi.fn(async () => ({ id: 1, username: "alice", name: "Alice", email: null }));

    const app = express();
    app.use("/auth", authRoutes({
      stateStore: f.stateStore as any, pendingStore: f.pendingStore as any, codeStore: f.codeStore as any,
      sessions: f.sessions as any, users: f.users as any, accounts: f.accounts as any,
      exchangeCode, fetchGitLabUser,
    }));

    const res = await request(app).get("/auth/callback?code=glcode&state=st2");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Connected as");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/authCallbackOAuth.test.ts`
Expected: FAIL — `authRoutes` does not accept `pendingStore`/`codeStore`/`exchangeCode`/`fetchGitLabUser` deps and has no OAuth branch.

- [ ] **Step 3: Implement**

Rewrite `src/http/authRoutes.ts`. Add the new imports and deps, extract `startGitLabLogin`, and branch in `/callback`. Full file:

```typescript
import { Router } from "express";
import { getConfig } from "../config/index.js";
import { randomToken } from "../auth/crypto.js";
import {
  buildAuthorizeUrl,
  exchangeCode as defaultExchangeCode,
  fetchGitLabUser as defaultFetchGitLabUser,
  generatePkce,
} from "../auth/gitlabOAuth.js";
import { oauthStateStore } from "../auth/oauthStateStore.js";
import { pendingAuthorizeStore, type PendingAuthorize } from "../auth/pendingAuthorizeStore.js";
import { authCodeStore } from "../auth/authCodeStore.js";
import { sessionService } from "../auth/sessionService.js";
import { userRepository } from "../repositories/userRepository.js";
import { oauthAccountRepository } from "../repositories/oauthAccountRepository.js";

export interface AuthRoutesDeps {
  stateStore?: ReturnType<typeof oauthStateStore>;
  pendingStore?: ReturnType<typeof pendingAuthorizeStore>;
  codeStore?: ReturnType<typeof authCodeStore>;
  sessions?: ReturnType<typeof sessionService>;
  users?: ReturnType<typeof userRepository>;
  accounts?: ReturnType<typeof oauthAccountRepository>;
  exchangeCode?: typeof defaultExchangeCode;
  fetchGitLabUser?: typeof defaultFetchGitLabUser;
}

/**
 * Starts the GitLab login leg. Stores the PKCE verifier under a fresh internal
 * `state`. If `pending` is given, the request originated from an MCP client's
 * /oauth/authorize and the callback will return an authorization code instead
 * of the HTML page.
 */
export async function startGitLabLogin(
  deps: { stateStore: ReturnType<typeof oauthStateStore>; pendingStore: ReturnType<typeof pendingAuthorizeStore> },
  opts?: { pending?: PendingAuthorize },
): Promise<string> {
  const state = randomToken(16);
  const { verifier, challenge } = generatePkce();
  await deps.stateStore.save(state, { verifier });
  if (opts?.pending) await deps.pendingStore.save(state, opts.pending);
  return buildAuthorizeUrl(state, challenge);
}

export function authRoutes(deps?: AuthRoutesDeps): Router {
  const router = Router();
  const stateStore = deps?.stateStore ?? oauthStateStore();
  const pendingStore = deps?.pendingStore ?? pendingAuthorizeStore();
  const codeStore = deps?.codeStore ?? authCodeStore();
  const sessions = deps?.sessions ?? sessionService();
  const users = deps?.users ?? userRepository();
  const accounts = deps?.accounts ?? oauthAccountRepository();
  const exchangeCode = deps?.exchangeCode ?? defaultExchangeCode;
  const fetchGitLabUser = deps?.fetchGitLabUser ?? defaultFetchGitLabUser;

  // Manual login (fallback) — no parked OAuth request.
  router.get("/login", async (_req, res) => {
    const url = await startGitLabLogin({ stateStore, pendingStore });
    res.redirect(url);
  });

  router.get("/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) {
      res.status(400).send("Missing code or state.");
      return;
    }

    const pendingAuth = await stateStore.take(state);
    if (!pendingAuth) {
      res.status(400).send("Invalid or expired OAuth state. Please retry /auth/login.");
      return;
    }

    try {
      const { tokens, expiresAt } = await exchangeCode(code, pendingAuth.verifier);
      const glUser = await fetchGitLabUser(tokens.access_token);

      const user = await users.upsertFromGitLab(glUser);
      await accounts.upsert(user.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenType: tokens.token_type,
        scope: tokens.scope ?? null,
        expiresAt,
      });

      const { token, expiresAt: sessionExp } = await sessions.issue(user, {
        userAgent: req.header("user-agent") ?? null,
        ip: req.ip ?? null,
      });

      // OAuth-client branch: a parked authorize request → issue our code & redirect back.
      const parked = await pendingStore.take(state);
      if (parked) {
        const authCode = await codeStore.issue({
          clientId: parked.clientId,
          redirectUri: parked.redirectUri,
          codeChallenge: parked.codeChallenge,
          sessionId: "", // session id is internal; not needed by /token. Kept for audit symmetry.
          userId: user.id,
          sessionToken: token,
        });
        const redirect = new URL(parked.redirectUri);
        redirect.searchParams.set("code", authCode);
        if (parked.clientState) redirect.searchParams.set("state", parked.clientState);
        res.redirect(302, redirect.toString());
        return;
      }

      // Fallback: HTML page with the token.
      res.status(200).type("html").send(connectedPage(user.username, token, sessionExp));
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth failed";
      res.status(502).send(`OAuth login failed: ${escapeHtml(message)}`);
    }
  });

  router.post("/logout", async (req, res) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    if (match) await sessions.revoke(match[1]);
    res.status(200).json({ ok: true });
  });

  return router;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function connectedPage(username: string, token: string, expiresAt: Date): string {
  const cfg = getConfig();
  const mcpUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`;
  return `<!doctype html>
<meta charset="utf-8">
<title>Connected to GitLab MCP</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5}
  code,pre{background:#f4f4f5;border-radius:6px}
  pre{padding:1rem;overflow:auto}
  .tok{user-select:all;word-break:break-all}
  .warn{color:#b45309}
</style>
<h1>✅ Connected as <code>${escapeHtml(username)}</code></h1>
<p>Your MCP session bearer token (expires ${expiresAt.toISOString()}):</p>
<pre class="tok">${escapeHtml(token)}</pre>
<p class="warn">Copy it now — it is shown only once and stored only as a hash.</p>
<h2>Configure your MCP client</h2>
<p>Point your client at the Streamable HTTP endpoint below and send the token as a bearer header:</p>
<pre>URL:    ${escapeHtml(mcpUrl)}
Header: Authorization: Bearer &lt;token&gt;</pre>
<p>To disconnect, send <code>POST /auth/logout</code> with the same bearer header.</p>`;
}
```

Note on ordering: the existing `/callback` consumed `stateStore.take(state)` for the PKCE verifier. The parked OAuth request is stored under the **same** internal `state`, so we `pendingStore.take(state)` after the GitLab exchange succeeds. Both stores are single-use.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/authCallbackOAuth.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite (existing callback test may need the new deps shape)**

Run: `npm test`
Expected: PASS. If the existing OAuth-callback integration test referenced `connectedPage` output, it remains unchanged (fallback path). If it injected `exchangeCode`/`fetchGitLabUser` by module mock, that still works.

- [ ] **Step 6: Commit**

```bash
git add src/http/authRoutes.ts tests/integration/authCallbackOAuth.test.ts
git commit -m "feat(auth): OAuth-client branch in callback + startGitLabLogin helper"
```

---

### Task 11: mcpOAuthProvider (the SDK OAuthServerProvider)

**Files:**
- Create: `src/auth/mcpOAuthProvider.ts`
- Test: `tests/unit/mcpOAuthProvider.test.ts`

**Interfaces:**
- Consumes: `oauthClientStore`, `pendingAuthorizeStore`, `authCodeStore`, `sessionService`, `refreshTokenService`, `userRepository`, `startGitLabLogin`; SDK types/errors from `@modelcontextprotocol/sdk/server/auth/provider.js`, `.../shared/auth.js`, `.../server/auth/errors.js`, `.../server/auth/types.js`.
- Produces: `mcpOAuthProvider(deps?): OAuthServerProvider` with:
  - `get clientsStore()` → the `oauthClientStore`
  - `authorize(client, params, res)` → park request, redirect to GitLab via `startGitLabLogin`
  - `challengeForAuthorizationCode(client, code)` → `authCodeStore.peekChallenge`
  - `exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?)` → consume code, verify binding + PKCE, issue refresh, return `OAuthTokens` (`access_token` = bound session token)
  - `exchangeRefreshToken(client, refreshToken)` → validate, issue new session, rotate refresh, return `OAuthTokens`
  - `verifyAccessToken(token)` → `sessionService.validate` → `AuthInfo`
  - `revokeToken(client, request)` → revoke session and/or refresh

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { mcpOAuthProvider } from "../../src/auth/mcpOAuthProvider.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

const client = { client_id: "c1", redirect_uris: ["http://localhost:7777/cb"] } as any;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

function deps(over: any = {}) {
  return {
    clients: { getClient: vi.fn(), registerClient: vi.fn() },
    pendingStore: { save: vi.fn(), take: vi.fn() },
    codeStore: {
      issue: vi.fn(),
      peekChallenge: vi.fn(),
      consume: vi.fn(),
    },
    sessions: { validate: vi.fn(), revoke: vi.fn() },
    refresh: { issue: vi.fn(async () => ({ token: "rt", expiresAt: new Date(Date.now() + 1e6) })), validate: vi.fn(), rotate: vi.fn(), revoke: vi.fn() },
    users: { findById: vi.fn(async () => ({ id: "u1" })) },
    stateStore: {},
    startLogin: vi.fn(async () => "https://gitlab.example/oauth/authorize?x=1"),
    ...over,
  };
}

describe("mcpOAuthProvider", () => {
  it("authorize parks the request and redirects to GitLab", async () => {
    const d = deps();
    const p = mcpOAuthProvider(d as any);
    const res = { redirect: vi.fn() } as any;
    await p.authorize(client, { redirectUri: "http://localhost:7777/cb", codeChallenge: "chal", state: "cs" }, res);
    expect(d.startLogin).toHaveBeenCalledWith(
      expect.anything(),
      { pending: { clientId: "c1", redirectUri: "http://localhost:7777/cb", clientState: "cs", codeChallenge: "chal" } },
    );
    expect(res.redirect).toHaveBeenCalledWith("https://gitlab.example/oauth/authorize?x=1");
  });

  it("exchangeAuthorizationCode verifies PKCE and returns the session token as access_token", async () => {
    const verifier = "verifier-123";
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256(verifier), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    const tokens = await p.exchangeAuthorizationCode(client, "code", verifier, "http://localhost:7777/cb");
    expect(tokens.access_token).toBe("the-session");
    expect(tokens.refresh_token).toBe("rt");
    expect(tokens.token_type).toBe("bearer");
  });

  it("exchangeAuthorizationCode rejects a bad verifier", async () => {
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256("right"), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeAuthorizationCode(client, "code", "wrong", "http://localhost:7777/cb")).rejects.toThrow();
  });

  it("exchangeAuthorizationCode rejects a redirect_uri mismatch", async () => {
    const verifier = "v";
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256(verifier), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeAuthorizationCode(client, "code", verifier, "http://evil/cb")).rejects.toThrow();
  });

  it("exchangeRefreshToken rotates and returns a new session", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(async () => ({ userId: "u1", clientId: "c1" })),
        rotate: vi.fn(async () => ({ token: "rt2", expiresAt: new Date(Date.now() + 1e6) })),
        issue: vi.fn(), revoke: vi.fn(),
      },
      sessions: { issue: vi.fn(async () => ({ token: "sess2", expiresAt: new Date(Date.now() + 1e6) })), validate: vi.fn(), revoke: vi.fn() },
    });
    const p = mcpOAuthProvider(d as any);
    const tokens = await p.exchangeRefreshToken(client, "old-rt");
    expect(tokens.access_token).toBe("sess2");
    expect(tokens.refresh_token).toBe("rt2");
  });

  it("verifyAccessToken returns AuthInfo for a valid session", async () => {
    const d = deps({ sessions: { validate: vi.fn(async () => ({ sessionId: "s1", userId: "u1" })), revoke: vi.fn() } });
    const p = mcpOAuthProvider(d as any);
    const info = await p.verifyAccessToken("tok");
    expect(info.token).toBe("tok");
    expect(info.extra?.userId).toBe("u1");
  });

  it("verifyAccessToken throws for an invalid session", async () => {
    const d = deps({ sessions: { validate: vi.fn(async () => null), revoke: vi.fn() } });
    const p = mcpOAuthProvider(d as any);
    await expect(p.verifyAccessToken("bad")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/mcpOAuthProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
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

import { getConfig } from "../config/index.js";
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
    ): Promise<OAuthTokens> {
      const ctx = await refresh.validate(refreshToken);
      if (!ctx || ctx.clientId !== client.client_id) {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }
      // Issue a new session bound to the user. sessionService.issue needs a User;
      // we only have userId here, so pass a minimal object — issue() reads user.id.
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
        extra: { userId: ctx.userId, sessionId: ctx.sessionId },
      };
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      // Best-effort: try both, since we do not know the token type for sure.
      await refresh.revoke(request.token).catch(() => undefined);
      await sessions.revoke(request.token).catch(() => undefined);
    },
  };
}
```

Note on `sessions.issue({ id: ctx.userId } as never)`: `sessionService.issue` only reads `user.id` (see `sessionService.ts:38`). Passing a minimal object is safe. If a reviewer prefers, change `exchangeRefreshToken` to load the full user via `userRepository().findById(ctx.userId)` first — both are acceptable; the minimal object avoids an extra query.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/mcpOAuthProvider.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck against SDK**

Run: `npm run typecheck`
Expected: PASS — confirms the provider satisfies `OAuthServerProvider` and the SDK type imports resolve.

- [ ] **Step 6: Commit**

```bash
git add src/auth/mcpOAuthProvider.ts tests/unit/mcpOAuthProvider.test.ts
git commit -m "feat(auth): MCP OAuthServerProvider over GitLab"
```

---

### Task 12: Mount mcpAuthRouter in the app

**Files:**
- Modify: `src/http/app.ts`
- Test: `tests/integration/oauthDiscovery.test.ts`

**Interfaces:**
- Consumes: `mcpAuthRouter` from `@modelcontextprotocol/sdk/server/auth/router.js`; `mcpOAuthProvider`; `getConfig().PUBLIC_BASE_URL`.
- Produces: app serves `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`.

- [ ] **Step 1: Write the failing integration test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { createApp } from "../../src/http/app.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

describe("OAuth discovery", () => {
  it("serves authorization-server metadata with our endpoints", async () => {
    const res = await request(createApp()).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("http://localhost:3000");
    expect(res.body.authorization_endpoint).toContain("/authorize");
    expect(res.body.token_endpoint).toContain("/token");
    expect(res.body.registration_endpoint).toContain("/register");
  });

  it("serves protected-resource metadata", async () => {
    const res = await request(createApp()).get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/oauthDiscovery.test.ts`
Expected: FAIL — 404, router not mounted.

- [ ] **Step 3: Implement**

In `src/http/app.ts`, add imports:

```typescript
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { getConfig } from "../config/index.js";
import { mcpOAuthProvider } from "../auth/mcpOAuthProvider.js";
```

Mount the router at the root **before** the `/mcp` route. Inside `createApp()`, after `app.use(express.json(...))` and the `/healthz` + `/` routes, add:

```typescript
  const cfg = getConfig();
  app.use(
    mcpAuthRouter({
      provider: mcpOAuthProvider(),
      issuerUrl: new URL(cfg.PUBLIC_BASE_URL),
      resourceServerUrl: new URL(`${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`),
      scopesSupported: ["mcp"],
      resourceName: "GitLab MCP",
    }),
  );
```

Leave `app.use("/auth", authRoutes())` and `app.use("/mcp", mcpRoute())` as they are.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/oauthDiscovery.test.ts`
Expected: PASS

- [ ] **Step 5: Confirm helmet does not block discovery (already passing proves it), and run full suite**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/http/app.ts tests/integration/oauthDiscovery.test.ts
git commit -m "feat(http): mount MCP OAuth router (discovery, DCR, token, revoke)"
```

---

### Task 13: End-to-end happy-path integration test

**Files:**
- Test: `tests/integration/oauthEndToEnd.test.ts`

**Interfaces:**
- Consumes: `createApp`; the GitLab HTTP calls are mocked by injecting fakes — to keep this hermetic, build the app with an injected provider/auth-routes via the existing DI seams. Since `createApp()` uses defaults, this test instead drives the pieces through the public HTTP surface with GitLab `fetch` stubbed globally (the project's convention: GitLab always mocked).

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { setConfig, loadConfig } from "../../src/config/index.js";

// NOTE: This test stubs GitLab token exchange + user fetch at the global fetch
// boundary and uses in-memory Redis/Prisma fakes wired via module mocks.
// It verifies: DCR -> authorize (redirect to GitLab) -> callback (redirect with
// code) -> token (access+refresh) -> the access token verifies on /mcp's auth.

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s",
    GITLAB_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

afterEach(() => vi.restoreAllMocks());

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("MCP OAuth end-to-end", () => {
  it("DCR → authorize → callback → token yields a working access token", async () => {
    // Implementer note: wire in-memory fakes for redis (getRedis) and prisma
    // (getPrisma) via vi.mock at the top of the file, mirroring existing
    // integration tests. Stub global fetch so GitLab /oauth/token returns
    // { access_token, token_type } and /api/v4/user returns a user.
    // Then:
    //   1. POST /register { redirect_uris:[cb], grant_types:[...] } -> client_id
    //   2. GET /authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state=cs
    //        -> 302 to GitLab; capture internal state from the location.
    //   3. GET /auth/callback?code=gl&state=<internal> -> 302 to cb?code=&state=cs
    //   4. POST /token grant_type=authorization_code code=<code> code_verifier=<verifier> client_id redirect_uri
    //        -> { access_token, refresh_token }
    //   5. assert verifyAccessToken(access_token) succeeds (call provider.verifyAccessToken or hit /mcp).
    expect(true).toBe(true); // replace with the wired flow above
  });
});
```

This task is a **placeholder-by-design only for the mock wiring**, which must follow whatever module-mock pattern the existing integration tests use (look at `tests/integration/` for the established `vi.mock("../../src/database/redis.js")` / prisma fakes). The implementer must replace the commented steps with real `request(app)` calls and assertions. Do **not** commit the `expect(true).toBe(true)` stub.

- [ ] **Step 2: Inspect existing integration tests for the mock pattern**

Run: `ls tests/integration && sed -n '1,40p' tests/integration/*.test.ts | head -80`
Expected: Identify the established `vi.mock` setup for redis + prisma. Reuse it verbatim.

- [ ] **Step 3: Implement the real flow**

Replace the commented steps with the five `request(app)` calls. Assert:
- `/register` returns 201 with `client_id`.
- `/authorize` returns 302 to the GitLab base URL; extract internal `state` from the `Location` query.
- `/auth/callback` returns 302 to the client `redirect_uri` with `code` and `state=cs`.
- `/token` returns 200 with `access_token` and `refresh_token`.
- A protected call (`POST /mcp` with `Authorization: Bearer <access_token>`) is **not** rejected at the auth layer (status is not 401).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/oauthEndToEnd.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/integration/oauthEndToEnd.test.ts
git commit -m "test(oauth): end-to-end DCR→authorize→callback→token flow"
```

---

### Task 14: Docs — README/CLAUDE.md note + .env.example finalization

**Files:**
- Modify: `README.md` (or create a short `docs/oauth.md` if README is large)
- Modify: `CLAUDE.md` (auth flow section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the client-driven flow**

Add a section describing the zero-token connect:

```markdown
### Connecting an MCP client (Claude Code) via OAuth

The server is an OAuth 2.0 Authorization Server for MCP clients. To connect:

    claude mcp add --transport http gitlab http://localhost:3000/mcp

On first use the client discovers `/.well-known/oauth-authorization-server`,
registers via `/oauth/register`, opens a browser to `/oauth/authorize`, you log
in with GitLab once, and the client obtains and refreshes its tokens
automatically. No token is pasted by hand.

The legacy manual flow (`/auth/login` → copy bearer token) still works as a
fallback for clients without OAuth support.
```

- [ ] **Step 2: Update CLAUDE.md auth-flow section**

In the "Auth flow" section of `CLAUDE.md`, add a note that MCP clients can now authenticate via the server's own OAuth endpoints (`/oauth/*`, `/.well-known/*`), with GitLab as the upstream IdP, and that the manual token flow is retained as a fallback.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: client-driven OAuth connection instructions"
```

---

## Self-Review

**1. Spec coverage:**
- Own AS over GitLab → Tasks 11, 12. ✓
- Full DCR → Task 8 (`registerClient`) + Task 12 (router serves `/register`). ✓
- Reuse opaque session as access_token → Task 11 `exchangeAuthorizationCode`. ✓
- Refresh tokens with rotation → Tasks 2, 4, 5, 11 (`exchangeRefreshToken`). ✓
- Ephemeral in Redis (auth code, parked request) → Tasks 6, 7. ✓
- `OAuthClient` + `OAuthRefreshToken` in Postgres → Tasks 2, 3, 4. ✓
- Keep manual flow as fallback → Task 10 (HTML branch retained). ✓
- WWW-Authenticate trigger → Task 9. ✓
- Implement via SDK `mcpAuthRouter` + `OAuthServerProvider` → Tasks 11, 12. ✓
- Security: PKCE mandatory, code single-use + bound, redirect_uri exact match, rotation, secrets hashed → Tasks 5, 7, 11. ✓
- Testing: unit + integration, GitLab mocked, discovery smoke test → Tasks 3–13. ✓
- Config TTLs → Task 1. ✓
- Out of scope (confidential clients, tool surface) → respected; `clientSecretHash` reserved, no tool changes. ✓

**2. Placeholder scan:** The only intentional placeholder is the mock-wiring stub in Task 13, explicitly flagged with instructions to inspect existing tests and replace it; all code steps elsewhere contain complete code.

**3. Type consistency:** `AuthCodeData` (Task 7) fields match what Task 10 `codeStore.issue(...)` passes and Task 11 `consume()` reads. `refreshTokenService` method names (`issue`/`validate`/`rotate`/`revoke`) consistent across Tasks 5 and 11. `OAuthClientInformationFull`/`OAuthTokens`/`AuthInfo` used per the SDK type defs read from `node_modules`. `startGitLabLogin` signature consistent between Tasks 10 and 11.

**Open item for the implementer:** Task 2's migration assumes a reachable local Postgres. If running offline, generate the migration SQL via `prisma migrate diff` and commit it; apply on first `docker compose up` (which runs `migrate deploy`).
