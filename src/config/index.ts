import { z } from "zod";

/**
 * Centralized, validated configuration. Import config from here — never read
 * process.env directly elsewhere in the codebase.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Public URL the server is reachable at (used to build the OAuth redirect and
  // to display the bearer-token connection instructions).
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // GitLab instance + OAuth application credentials.
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_CLIENT_ID: z.string().min(1),
  GITLAB_CLIENT_SECRET: z.string().min(1),
  GITLAB_REDIRECT_URI: z.string().url(),
  GITLAB_SCOPES: z.string().default("read_user api"),

  // 32-byte key for AES-256-GCM, supplied as hex (64 chars) or base64.
  ENCRYPTION_KEY: z.string().min(1),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7 days
  // Refresh GitLab tokens when they expire within this many seconds.
  TOKEN_REFRESH_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // TTL for our short-lived authorization codes issued to MCP clients.
  OAUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // TTL for opaque refresh tokens issued to MCP clients (default 30 days).
  OAUTH_REFRESH_TTL_HOURS: z.coerce.number().int().positive().default(720),
});

export type AppConfig = z.infer<typeof schema> & {
  gitlabApiBase: string;
  encryptionKey: Buffer;
};

function decodeKey(raw: string): Buffer {
  // Accept hex (64 chars) or base64; must decode to exactly 32 bytes.
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    buf = Buffer.from(raw, "base64");
  }
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Provide 64 hex chars or 32-byte base64.`,
    );
  }
  return buf;
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    gitlabApiBase: `${parsed.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4`,
    encryptionKey: decodeKey(parsed.ENCRYPTION_KEY),
  };
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: override the cached config. */
export function setConfig(cfg: AppConfig): void {
  cached = cfg;
}
