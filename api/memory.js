/**
 * api/memory.js — Persistent memory API
 *
 * GET  /memory?op=list                       → { facts: [...], summaries: [...], turns: [...] }
 * GET  /memory?op=read&path=memory/facts/x.md → { path, content }
 * GET  /memory?op=recall&q=...&k=5            → { hits: [...] }
 * POST /memory?op=save  { fact, scope? }      → { ok, path }
 *
 * All paths are sandboxed to memory/** for safety.
 */

import {
  recall as memoryRecall,
  saveFact as memorySaveFact,
  listMemoryRoots,
  readMemoryFile,
} from "../src/memory/cloud-memory.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const op = (req.query?.op || req.body?.op || "list").toString();

  try {
    if (req.method === "GET" && op === "list") {
      const roots = await listMemoryRoots();
      return res.status(200).json(roots);
    }

    if (req.method === "GET" && op === "read") {
      const path = String(req.query?.path || "");
      const file = await readMemoryFile(path);
      if (!file) return res.status(404).json({ error: "not found or out of scope" });
      return res.status(200).json(file);
    }

    if (req.method === "GET" && op === "recall") {
      const q = String(req.query?.q || "");
      const k = Math.min(parseInt(req.query?.k ?? "5", 10) || 5, 20);
      const hits = await memoryRecall(q, { k });
      return res.status(200).json({ query: q, hits });
    }

    if (req.method === "POST" && op === "save") {
      const { fact, scope, sessionId } = req.body ?? {};
      if (!fact || typeof fact !== "string") return res.status(400).json({ error: "missing fact" });
      const target = scope === "session" ? (sessionId || "_global") : "_global";
      const out = await memorySaveFact(fact, { sessionId: target, source: "user" });
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: `unknown op: ${op}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
