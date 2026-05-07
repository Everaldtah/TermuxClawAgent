/**
 * src/storage/redis.mjs — thin Upstash Redis client over REST API
 * No SDK dependency — uses native https for Vercel serverless compatibility.
 */

import https from "node:https";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

export const SESSION_TTL_SECS = 60 * 60 * 24 * 30; // 30 days

function redisCmd(...args) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL || !REDIS_TOKEN) {
      reject(new Error("Upstash env vars not set"));
      return;
    }
    const body = JSON.stringify(args);
    const u = new URL(REDIS_URL);
    const req = https.request({
      hostname: u.hostname,
      path: "/",
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(raw);
          if (d.error) reject(new Error(`Redis: ${d.error}`));
          else resolve(d.result);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export const redisGet  = (key)              => redisCmd("GET", key);
export const redisDel  = (key)              => redisCmd("DEL", key);
export const redisIncr = (key)              => redisCmd("INCR", key);
export const redisSet  = (key, val, ttl = SESSION_TTL_SECS) =>
  redisCmd("SET", key, val, "EX", String(ttl));
