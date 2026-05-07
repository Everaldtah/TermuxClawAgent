/**
 * api/activity.js — serves the latest agent activity log
 * Status page polls this every 3s to show live thinking + tool feed.
 */

import { ghRead } from "../src/sync/github-storage.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    const result = await ghRead("activity/log.json");
    if (!result) return res.status(200).json({ entries: [] });
    const data = JSON.parse(result.content);
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ entries: [], error: err.message });
  }
}
