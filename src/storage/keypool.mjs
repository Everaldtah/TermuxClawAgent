/**
 * src/storage/keypool.mjs — round-robin NVIDIA API key pool
 *
 * Add keys as env vars: NVIDIA_API_KEY, NVIDIA_API_KEY_2, NVIDIA_API_KEY_3 …
 * The pool uses a Redis counter to distribute load across all keys.
 * Falls back to simple mod-by-index if Redis is unavailable.
 */

import { redisIncr } from "./redis.mjs";

// Collect all NVIDIA_API_KEY*  AND  NVIDIA_KEY_* env vars in sorted order.
// Any NVIDIA-issued key on NIM can call any NIM-hosted model, so the
// per-specialist keys (NVIDIA_KEY_DEEPSEEK, NVIDIA_KEY_GLM, …) double as
// general-purpose coordinator keys when NVIDIA_API_KEY itself is unset.
const KEY_POOL = Object.keys(process.env)
  .filter(k => /^NVIDIA_API_KEY\d*$/.test(k) || /^NVIDIA_KEY_[A-Z0-9_]+$/.test(k))
  .sort()
  .map(k => process.env[k])
  .filter(Boolean);

let _localCounter = 0;

export function poolSize() { return KEY_POOL.length; }

export async function nextApiKey() {
  if (KEY_POOL.length === 0) return "";
  if (KEY_POOL.length === 1) return KEY_POOL[0];

  try {
    const idx = await redisIncr("nim_key_idx");
    return KEY_POOL[Number(idx) % KEY_POOL.length];
  } catch {
    // Redis unavailable — local counter fallback
    _localCounter++;
    return KEY_POOL[_localCounter % KEY_POOL.length];
  }
}
