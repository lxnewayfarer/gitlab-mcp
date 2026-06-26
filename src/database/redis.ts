import { Redis } from "ioredis";
import { getConfig } from "../config/index.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getConfig().REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    client.on("error", (err: Error) => {
      // Redis is a cache, not the source of truth — log but never crash on it.
      console.error("[redis] error:", err.message);
    });
  }
  return client;
}

/** Test helper. */
export function setRedis(c: Redis): void {
  client = c;
}

export async function disconnectRedis(): Promise<void> {
  if (client) await client.quit();
}
