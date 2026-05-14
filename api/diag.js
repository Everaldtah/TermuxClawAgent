/**
 * api/diag.js — health-check endpoint
 *
 * GET /diag → reports presence of critical env vars, storage repo target,
 * pool size, and which features the cloud agent thinks are available.
 * Does NOT leak any key values.
 */

import { poolSize } from "../src/storage/keypool.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();

  const has = (k) => Boolean(process.env[k] && String(process.env[k]).trim().length);
  const NVIDIA_KEY_NAMES = Object.keys(process.env).filter(k => /^NVIDIA_API_KEY\d*$/.test(k) || /^NVIDIA_KEY_[A-Z0-9_]+$/.test(k));

  res.status(200).json({
    ok: true,
    storage: {
      repo: process.env.GITHUB_STORAGE_REPO || "Everaldtah/solis-agent-files",
      branch: process.env.GITHUB_STORAGE_BRANCH || "main",
      tokenSet: has("GITHUB_TOKEN"),
    },
    model: {
      coordinator: process.env.MODEL || "moonshotai/kimi-k2.6",
      baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    },
    keys: {
      poolSize: poolSize(),
      keyVars: NVIDIA_KEY_NAMES.sort(),
      nvidia_api_key_set: has("NVIDIA_API_KEY"),
    },
    bridge: {
      windows_bridge_configured: has("WINDOWS_BRIDGE_URL"),
    },
    runtime: {
      node: process.version,
      region: process.env.VERCEL_REGION || null,
    },
  });
}
