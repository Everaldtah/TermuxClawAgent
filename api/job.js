/**
 * api/job.js — Background job status polling
 *
 * GET /job?id=<jobId>
 * → { id, status, message, rounds, reply, error, created, updated, durationMs }
 *
 * status: "running" | "done" | "error"
 */

import { ghRead } from "../src/sync/github-storage.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const jobId = req.query?.id;
  if (!jobId || !/^[0-9a-f-]{36}$/.test(jobId)) {
    return res.status(400).json({ error: "missing or invalid job id" });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const result = await ghRead(`sessions/jobs/${jobId}.json`);
    if (!result) return res.status(404).json({ error: "job not found" });
    const job = JSON.parse(result.content);
    res.status(200).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
