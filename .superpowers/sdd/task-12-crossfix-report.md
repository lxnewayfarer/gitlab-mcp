# Task 12 Cross-fix Report: WWW-Authenticate resource_metadata URL

## Defect

`src/middleware/bearerAuth.ts` built the WWW-Authenticate header challenge as:

```
Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"
```

But the MCP SDK's `mcpAuthRouter` (in `src/http/app.ts`) is mounted with
`resourceServerUrl = new URL("<PUBLIC_BASE_URL>/mcp")`. The SDK serves protected-resource
metadata at the path derived from that URL's pathname:

```
/.well-known/oauth-protected-resource/mcp
```

This is confirmed by:
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/router.js` line 97:
  `router.use(\`/.well-known/oauth-protected-resource${rsPath === '/' ? '' : rsPath}\`, ...)`
- `tests/integration/oauthDiscovery.test.ts` which asserts `GET /.well-known/oauth-protected-resource/mcp` returns 200.

The bare path `/.well-known/oauth-protected-resource` (no `/mcp`) returns 404, breaking
OAuth auto-discovery for all clients.

## Fix

Used the SDK helper `getOAuthProtectedResourceMetadataUrl` (exported from
`@modelcontextprotocol/sdk/server/auth/router.js`, declared in
`dist/esm/server/auth/router.d.ts` as `export declare function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string`)
so the middleware stays in sync with the SDK's own path computation logic.

**`src/middleware/bearerAuth.ts`** — changed:

```ts
// Before
const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;

// After
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
...
const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${base}/mcp`));
const challenge = `Bearer resource_metadata="${metadataUrl}"`;
```

The SDK helper was preferred over a hardcoded `/mcp` suffix so the two cannot drift
if the resource server URL path changes in `app.ts`.

## Test Updates

**`tests/unit/bearerAuth.test.ts`** — updated both assertions to the corrected URL:

- missing-token test: `toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"')`
- invalid-session test: strengthened from `toContain("Bearer")` to
  `toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"')`

Neither assertion was weakened. The `user_not_found` behavior is untouched.

## RED proof

Before the fix, the old missing-token assertion:

```
resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"
```

would fail against the new middleware which produces:

```
resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
```

confirming the test exercised the right value (the old test was asserting the broken URL).

## Test output

```
npm test -- tests/unit/bearerAuth.test.ts tests/integration/oauthDiscovery.test.ts

 ✓ tests/unit/bearerAuth.test.ts (2 tests) 4ms
 ✓ tests/integration/oauthDiscovery.test.ts (2 tests) 45ms

 Test Files  2 passed (2)
      Tests  4 passed (4)
```

Full suite:

```
npm test

 Test Files  19 passed (19)
      Tests  94 passed (94)
```

`npm run build` (tsc): clean, no errors.

The header URL `http://localhost:3000/.well-known/oauth-protected-resource/mcp`
exactly matches the path the `oauthDiscovery` integration test confirms the SDK serves
at `GET /.well-known/oauth-protected-resource/mcp`.
