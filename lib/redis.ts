import { Redis } from "@upstash/redis";
import { REDIS_TIMEOUT_MS } from "./constants";

let client: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!client) {
    client = new Redis({
      url,
      token,
      retry: { retries: 1, backoff: () => 100 },
      // Each request gets its own timeout so a slow Redis never eats the 10s webhook budget.
      signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
  }
  return client;
}

/**
 * Runs a Redis operation. On any failure (unset env, timeout, Upstash down) logs MEMORY_ERROR
 * and returns null so the bot keeps working without memory/cart.
 * Never logs keys (they contain the userId) or values (they contain message text).
 */
export async function redisOp<T>(op: string, fn: (r: Redis) => Promise<T>): Promise<T | null> {
  const redis = getRedis();
  if (!redis) {
    console.error("MEMORY_ERROR", { op, message: "KV_REST_API_URL / KV_REST_API_TOKEN is not set" });
    return null;
  }
  try {
    return await fn(redis);
  } catch (err) {
    console.error("MEMORY_ERROR", { op, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
