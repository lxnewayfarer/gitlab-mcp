import { getConfig } from "./config/index.js";
import { createApp } from "./http/app.js";
import { disconnectPrisma } from "./database/prisma.js";
import { disconnectRedis } from "./database/redis.js";

const cfg = getConfig();
const app = createApp();

const server = app.listen(cfg.PORT, () => {
  console.log(`[gitlab-mcp] listening on :${cfg.PORT}`);
  console.log(`[gitlab-mcp] GitLab: ${cfg.GITLAB_BASE_URL}`);
  console.log(`[gitlab-mcp] log in at ${cfg.PUBLIC_BASE_URL}/auth/login`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[gitlab-mcp] ${signal} received, shutting down...`);
  server.close();
  await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
