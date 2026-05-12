/**
 * api/desktop.js — Windows Desktop Bridge Proxy
 *
 * Proxies requests to the Windows machine running scripts/windows-bridge.py.
 * Configure WINDOWS_BRIDGE_URL and WINDOWS_BRIDGE_TOKEN in Vercel env.
 *
 * Actions (via ?action=<name> or req.body.action):
 *   GET  screenshot  — Returns {screenshot:base64, width, height}
 *   GET  info        — Returns OS/screen info
 *   POST click       — {x, y, button?, double?}
 *   POST rightclick  — {x, y}
 *   POST type        — {text}
 *   POST key         — {key, presses?}
 *   POST hotkey      — {keys: ["ctrl","c"]}
 *   POST move        — {x, y}
 *   POST drag        — {x1, y1, x2, y2}
 *   POST scroll      — {x, y, clicks}
 *   POST run         — {command, timeout_ms?}
 *   POST powershell  — {script, timeout_ms?}
 *   POST open        — {app}
 */

import https from "node:https";
import http from "node:http";

const BRIDGE_URL   = process.env.WINDOWS_BRIDGE_URL   ?? "";
const BRIDGE_TOKEN = process.env.WINDOWS_BRIDGE_TOKEN ?? "";

// ── Bridge request helper ─────────────────────────────────────────────────────

function bridgeRequest(path, method = "GET", body = null, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL) {
      return reject(new Error("WINDOWS_BRIDGE_URL is not configured in Vercel environment variables."));
    }
    const url = new URL(path, BRIDGE_URL.endsWith("/") ? BRIDGE_URL : BRIDGE_URL + "/");
    const payload = body ? JSON.stringify(body) : null;
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": BRIDGE_TOKEN,
          "User-Agent": "TermuxClawAgent/2.0",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ raw: raw.slice(0, 500) });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Bridge request timed out after ${timeoutMs / 1000}s`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Vercel handler ────────────────────────────────────────────────────────────

const READ_ACTIONS  = new Set(["screenshot", "info", "health"]);
const WRITE_ACTIONS = new Set(["click", "rightclick", "type", "key", "hotkey", "move", "drag", "scroll", "run", "powershell", "open"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = String(req.query?.action || (req.method === "GET" ? "screenshot" : "") || "").toLowerCase();

  if (!action) return res.status(400).json({ error: "Missing ?action= parameter" });

  if (!BRIDGE_URL) {
    return res.status(503).json({
      error: "Windows bridge not configured",
      setup: "1. Run scripts/windows-bridge.py on your Windows machine. 2. Set WINDOWS_BRIDGE_URL in Vercel env.",
      docs: "https://github.com/Everaldtah/TermuxClawAgent#windows-bridge",
    });
  }

  const isRead  = READ_ACTIONS.has(action);
  const isWrite = WRITE_ACTIONS.has(action);

  if (!isRead && !isWrite) {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  if (isWrite && req.method !== "POST") {
    return res.status(405).json({ error: `POST required for action: ${action}` });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const result = await bridgeRequest(
      `/${action}`,
      isWrite ? "POST" : "GET",
      isWrite ? (req.body ?? {}) : null,
      action === "screenshot" ? 15000 : 45000
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({
      error: err.message,
      bridge: BRIDGE_URL,
      hint: "Make sure windows-bridge.py is running and reachable from the internet.",
    });
  }
}
