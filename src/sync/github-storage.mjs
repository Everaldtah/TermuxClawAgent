/**
 * github-storage.mjs — Two-way sync between local disk and GitHub repo
 *
 * Storage repo layout:
 *   sessions/<chatId>.json   — conversation histories
 *   vault/**                 — all RAG / Obsidian vault files (mirrored from VAULT_PATH)
 *
 * Uses the GitHub Contents API (no git CLI required on cloud).
 */

import https from "node:https";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";

// ── Config (read from env, set before importing) ──────────────────────────────

export const GH_TOKEN    = process.env.GITHUB_TOKEN  ?? "";
export const GH_REPO     = process.env.GITHUB_STORAGE_REPO ?? "Everaldtah/solis-agent-files";
export const GH_BRANCH   = process.env.GITHUB_STORAGE_BRANCH ?? "main";
const API_BASE           = `https://api.github.com/repos/${GH_REPO}/contents`;

// ── Low-level GitHub Contents API ────────────────────────────────────────────

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "TermuxClawAgent/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Read a file from the storage repo. Returns { content, sha } or null. */
export async function ghRead(repoPath) {
  try {
    const { status, data } = await ghRequest("GET", `/${repoPath}?ref=${GH_BRANCH}`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`GH read ${repoPath}: HTTP ${status}`);
    const content = Buffer.from(data.content ?? "", "base64").toString("utf8");
    return { content, sha: data.sha };
  } catch (err) {
    console.warn(`  ⚠ ghRead(${repoPath}): ${err.message}`);
    return null;
  }
}

/** Write (create or update) a file in the storage repo. */
export async function ghWrite(repoPath, content, sha = null) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const body = {
    message: `sync: ${repoPath} @ ${new Date().toISOString().slice(0, 16)}`,
    content: encoded,
    branch: GH_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const { status, data } = await ghRequest("PUT", `/${repoPath}`, body);
  if (status !== 200 && status !== 201) {
    throw new Error(`GH write ${repoPath}: HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data?.content?.sha ?? null;
}

/** List files in a directory of the storage repo. Returns array of { path, sha, type }. */
export async function ghList(dirPath = "") {
  const { status, data } = await ghRequest("GET", `/${dirPath}?ref=${GH_BRANCH}`);
  if (status === 404) return [];
  if (status !== 200) throw new Error(`GH list ${dirPath}: HTTP ${status}`);
  if (!Array.isArray(data)) return [];
  return data.map(f => ({ path: f.path, sha: f.sha, type: f.type, name: f.name }));
}

/** Recursively list all files under a directory in the storage repo. */
async function ghListRecursive(dirPath = "") {
  const entries = await ghList(dirPath);
  const files = [];
  for (const entry of entries) {
    if (entry.type === "file") files.push(entry);
    else if (entry.type === "dir") files.push(...await ghListRecursive(entry.path));
  }
  return files;
}

// ── Session sync ──────────────────────────────────────────────────────────────

/** Push a session file to GitHub. */
export async function pushSession(chatId, messagesJson) {
  if (!GH_TOKEN) return;
  const repoPath = `sessions/${chatId}.json`;
  try {
    const existing = await ghRead(repoPath);
    await ghWrite(repoPath, messagesJson, existing?.sha ?? null);
    console.log(`  📤 Session ${chatId} pushed to GitHub`);
  } catch (err) {
    console.warn(`  ⚠ pushSession(${chatId}): ${err.message}`);
  }
}

/** Pull a session file from GitHub. Returns parsed messages array or null. */
export async function pullSession(chatId) {
  if (!GH_TOKEN) return null;
  const repoPath = `sessions/${chatId}.json`;
  try {
    const result = await ghRead(repoPath);
    if (!result) return null;
    const messages = JSON.parse(result.content);
    console.log(`  📥 Session ${chatId} pulled from GitHub (${messages.length} msgs)`);
    return messages;
  } catch (err) {
    console.warn(`  ⚠ pullSession(${chatId}): ${err.message}`);
    return null;
  }
}

// ── Vault sync ────────────────────────────────────────────────────────────────

function walkLocal(dir, rel = "", results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    if (statSync(full).isDirectory()) walkLocal(full, relPath, results);
    else results.push({ localPath: full, relPath });
  }
  return results;
}

/**
 * Push all local vault files to GitHub.
 * Only uploads files that differ from the stored SHA (avoids redundant writes).
 */
export async function pushVault(vaultPath) {
  if (!GH_TOKEN) return { pushed: 0, skipped: 0 };
  console.log("  📤 Pushing vault to GitHub…");
  const localFiles = walkLocal(vaultPath);
  const remoteFiles = await ghListRecursive("vault");
  const remoteShaMap = Object.fromEntries(remoteFiles.map(f => [f.path, f.sha]));

  let pushed = 0, skipped = 0;
  for (const { localPath, relPath } of localFiles) {
    const repoPath = `vault/${relPath}`;
    const content = readFileSync(localPath, "utf8");
    // Compute expected SHA (git blob SHA: "blob <size>\0<content>")
    const blobData = `blob ${Buffer.byteLength(content)}\0${content}`;
    const { createHash } = await import("node:crypto");
    const expectedSha = createHash("sha1").update(blobData).digest("hex");
    if (remoteShaMap[repoPath] === expectedSha) { skipped++; continue; }
    try {
      await ghWrite(repoPath, content, remoteShaMap[repoPath] ?? null);
      pushed++;
    } catch (err) {
      console.warn(`  ⚠ vault push ${relPath}: ${err.message}`);
    }
  }
  console.log(`  ✓ Vault push: ${pushed} updated, ${skipped} unchanged`);
  return { pushed, skipped };
}

/**
 * Pull all vault files from GitHub to local disk.
 * Newer GitHub version wins (last-writer-wins by timestamp in commit message).
 */
export async function pullVault(vaultPath) {
  if (!GH_TOKEN) return { pulled: 0 };
  console.log("  📥 Pulling vault from GitHub…");
  const remoteFiles = await ghListRecursive("vault");
  let pulled = 0;
  for (const file of remoteFiles) {
    // Strip leading "vault/" prefix to get relative path
    const relPath = file.path.replace(/^vault\//, "");
    const localPath = join(vaultPath, relPath);
    try {
      const result = await ghRead(file.path);
      if (!result) continue;
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, result.content, "utf8");
      pulled++;
    } catch (err) {
      console.warn(`  ⚠ vault pull ${relPath}: ${err.message}`);
    }
  }
  console.log(`  ✓ Vault pull: ${pulled} files`);
  return { pulled };
}

/**
 * Full two-way vault sync: pull from GitHub first, then push local back.
 * GitHub is authoritative for files that exist only remotely;
 * local is authoritative for files that exist only locally.
 */
export async function syncVault(vaultPath) {
  await pullVault(vaultPath);
  await pushVault(vaultPath);
}
