/**
 * src/storage/sessions.mjs — session CRUD backed by Upstash Redis
 *
 * Falls back to GitHub storage if Redis is unavailable, so the local
 * Termux bridge (which may not have Redis env vars) keeps working.
 */

import { redisGet, redisSet, redisDel } from "./redis.mjs";
import { pullSession as ghPull, pushSession as ghPush } from "../sync/github-storage.mjs";

const REDIS_AVAILABLE = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

function sessionKey(id) { return `session:${id}`; }

export async function pullSession(sessionId) {
  if (REDIS_AVAILABLE) {
    try {
      const raw = await redisGet(sessionKey(sessionId));
      if (!raw) return null;
      const msgs = JSON.parse(raw);
      console.log(`  📥 Session ${sessionId} from Redis (${msgs.length} msgs)`);
      return msgs;
    } catch (err) {
      console.warn(`  ⚠ Redis pull failed, trying GitHub: ${err.message}`);
    }
  }
  return ghPull(sessionId);
}

export async function pushSession(sessionId, messagesJson) {
  const errors = [];

  if (REDIS_AVAILABLE) {
    try {
      await redisSet(sessionKey(sessionId), messagesJson);
      console.log(`  📤 Session ${sessionId} saved to Redis`);
    } catch (err) {
      errors.push(`Redis: ${err.message}`);
    }
  }

  // Always mirror to GitHub so the local bridge can read it too
  try {
    await ghPush(sessionId, messagesJson);
  } catch (err) {
    errors.push(`GitHub: ${err.message}`);
  }

  if (errors.length) console.warn(`  ⚠ pushSession partial failure: ${errors.join(", ")}`);
}

export async function clearSession(sessionId) {
  if (REDIS_AVAILABLE) {
    await redisDel(sessionKey(sessionId)).catch(() => {});
  }
  await ghPush(sessionId, "[]").catch(() => {});
}
