/**
 * api/job.js — Background job status polling + cancellation
 *
 * GET  /job?id=<jobId>                → { id, status, message, rounds, reply, error, ... }
 * POST /job?id=<jobId>&action=cancel  → { ok, status: "cancelling" }
 *
 * Cancellation works by flipping cancelRequested=true on the persisted job
 * record in the storage repo. The agent (chat/submit/computer) checks this
 * flag between rounds and exits cleanly with status="cancelled".
 *
 * status values: "running" | "done" | "error" | "cancelling" | "cancelled"
 */

import { ghRead, ghWrite } from "../src/sync/github-storage.mjs";

const JOB_PATH_RX = /^[0-9a-f-]{36}$/;

async function readJob(jobId) {
  const r = await ghRead(`sessions/jobs/${jobId}.json`);
  if (!r) return null;
  try { return { json: JSON.parse(r.content), sha: r.sha }; } catch { return null; }
}

async function writeJob(jobId, obj, sha) {
  await ghWrite(`sessions/jobs/${jobId}.json`, JSON.stringify(obj, null, 2), sha);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const jobId = req.query?.id;
  if (!jobId || !JOB_PATH_RX.test(jobId)) {
    return res.status(400).json({ error: "missing or invalid job id" });
  }

  // ── GET: status poll ────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const r = await readJob(jobId);
      if (!r) return res.status(404).json({ error: "job not found" });
      return res.status(200).json(r.json);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: cancellation ──────────────────────────────────────────────────────
  if (req.method === "POST") {
    const action = (req.query?.action || req.body?.action || "").toString();
    if (action !== "cancel") return res.status(400).json({ error: `unknown action: ${action}` });

    try {
      const r = await readJob(jobId);
      if (!r) return res.status(404).json({ error: "job not found" });

      // Already finished — no-op
      if (["done", "error", "cancelled"].includes(r.json.status)) {
        return res.status(200).json({ ok: true, status: r.json.status, alreadyFinished: true });
      }

      const updated = {
        ...r.json,
        cancelRequested: true,
        cancelRequestedAt: Date.now(),
        status: "cancelling",
        updated: Date.now(),
      };
      await writeJob(jobId, updated, r.sha);
      return res.status(200).json({ ok: true, status: "cancelling" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
