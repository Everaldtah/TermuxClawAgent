/**
 * cloud-memory.mjs — Persistent memory + RAG for the Vercel cloud agent.
 *
 * Layout in the storage repo (Everaldtah/solis-agent-files):
 *
 *   memory/
 *     facts/<sessionId>.md          # distilled durable facts per session
 *     facts/_global.md              # facts marked as user-wide
 *     turns/<sessionId>.jsonl       # append-only turn log (user/agent pairs)
 *     summaries/<sessionId>.md      # latest condensed summary per session
 *     index.html                    # human-readable browse page (rendered)
 *
 *   vault/(recursive)                # the RAG corpus, .md and .html files
 *
 * Retrieval is keyword-based (BM25-lite). No embedding API required.
 * Files cached per warm function instance for CACHE_TTL_MS (5 min default).
 */

import { ghRead, ghWrite, ghList } from "../sync/github-storage.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS     = parseInt(process.env.MEMORY_CACHE_TTL_MS ?? "300000", 10); // 5 min
const MAX_RECALL_FILES = parseInt(process.env.MEMORY_MAX_FILES   ?? "200", 10);
const MAX_RECALL_BYTES = parseInt(process.env.MEMORY_MAX_BYTES   ?? "300000", 10);  // ~300KB indexed
const SUPPORTED_EXT    = /\.(md|markdown|html?|txt)$/i;
const RAG_ROOTS        = ["memory/facts", "memory/summaries", "vault"];

// ── Cache ─────────────────────────────────────────────────────────────────────

let _cache = null; // { at: number, docs: Doc[] }

/** @typedef {{ path: string, name: string, kind: "md"|"html"|"txt", content: string, len: number, tf: Map<string,number>, len_norm: number }} Doc */

// ── HTML / Markdown cleaning ──────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,  " ")
    .replace(/<!--[\s\S]*?-->/g,          " ")
    .replace(/<[^>]+>/g,                  " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFrontmatter(md) {
  return md.startsWith("---") ? md.replace(/^---[\s\S]*?---\s*/, "") : md;
}

function toPlain(content, ext) {
  if (ext === "html" || ext === "htm") return stripHtml(content);
  if (ext === "md"  || ext === "markdown") return stripFrontmatter(content);
  return content;
}

// ── Tokenisation ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a","an","the","and","or","but","of","in","to","for","on","with","at","by","from","is","are","was","were","be","been","being",
  "this","that","these","those","it","its","as","if","then","than","so","not","no","do","does","did","done",
  "i","you","he","she","we","they","them","my","your","our","their","me","us","him","her",
  "have","has","had","will","would","can","could","should","may","might","just","also","only","very","more","most","some","any","all","each","every",
]);

function tokenize(text) {
  return text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g)?.filter(t => !STOPWORDS.has(t)) ?? [];
}

function tfMap(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// ── Corpus loading ────────────────────────────────────────────────────────────

async function listAllUnder(dir, depth = 0, max = 4) {
  if (depth > max) return [];
  const entries = await ghList(dir).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (e.type === "file" && SUPPORTED_EXT.test(e.name)) out.push(e);
    else if (e.type === "dir") out.push(...await listAllUnder(e.path, depth + 1, max));
  }
  return out;
}

async function loadCorpus() {
  // Reuse warm-instance cache if still fresh.
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.docs;

  let allFiles = [];
  for (const root of RAG_ROOTS) {
    const files = await listAllUnder(root);
    allFiles.push(...files);
    if (allFiles.length >= MAX_RECALL_FILES) break;
  }
  allFiles = allFiles.slice(0, MAX_RECALL_FILES);

  // Fetch contents in parallel (small batches to avoid GH rate limits).
  const docs = [];
  let bytes = 0;
  const BATCH = 6;
  for (let i = 0; i < allFiles.length && bytes < MAX_RECALL_BYTES; i += BATCH) {
    const slice = allFiles.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(f => ghRead(f.path).then(r => ({ f, r })).catch(() => ({ f, r: null }))));
    for (const { f, r } of results) {
      if (!r?.content) continue;
      const extMatch = f.name.match(/\.([a-z]+)$/i);
      const ext = (extMatch?.[1] ?? "").toLowerCase();
      const plain = toPlain(r.content, ext);
      if (!plain) continue;
      const tokens = tokenize(plain);
      if (!tokens.length) continue;
      const tf = tfMap(tokens);
      bytes += plain.length;
      docs.push({
        path: f.path,
        name: f.name,
        kind: (ext === "html" || ext === "htm") ? "html" : (ext === "md" || ext === "markdown") ? "md" : "txt",
        content: plain.slice(0, 8000), // capped for snippet extraction
        rawContent: r.content.slice(0, 16000),
        len: tokens.length,
        tf,
      });
      if (bytes >= MAX_RECALL_BYTES) break;
    }
  }

  // Length normalisation factor — average doc length
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1);
  for (const d of docs) d.len_norm = d.len / avgLen;

  _cache = { at: Date.now(), docs };
  return docs;
}

/** Force-refresh cache after a write so the new content is searchable immediately. */
export function invalidateMemoryCache() {
  _cache = null;
}

// ── BM25-lite ranking ─────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

function score(doc, queryTokens, df, N) {
  let s = 0;
  for (const q of queryTokens) {
    const tf = doc.tf.get(q);
    if (!tf) continue;
    const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
    const norm = 1 - BM25_B + BM25_B * doc.len_norm;
    s += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
  }
  return s;
}

function extractSnippet(plain, queryTokens, maxLen = 360) {
  const lower = plain.toLowerCase();
  let bestIdx = -1, bestHits = 0;
  for (const q of queryTokens) {
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      // Count hits in a 200-char window starting at idx
      const winEnd = Math.min(lower.length, idx + 200);
      let hits = 0;
      for (const q2 of queryTokens) if (lower.slice(idx, winEnd).includes(q2)) hits++;
      if (hits > bestHits) { bestHits = hits; bestIdx = idx; }
      idx += q.length;
    }
  }
  if (bestIdx < 0) return plain.slice(0, maxLen);
  const start = Math.max(0, bestIdx - 80);
  const end   = Math.min(plain.length, start + maxLen);
  return (start > 0 ? "…" : "") + plain.slice(start, end).trim() + (end < plain.length ? "…" : "");
}

/**
 * Search the memory + vault corpus for snippets relevant to `query`.
 * Returns up to `k` results: { path, kind, snippet, score }.
 */
export async function recall(query, { k = 5 } = {}) {
  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return [];

  const docs = await loadCorpus();
  if (!docs.length) return [];

  // Document frequency for each query token
  const df = new Map();
  for (const q of queryTokens) {
    let c = 0;
    for (const d of docs) if (d.tf.has(q)) c++;
    if (c > 0) df.set(q, c);
  }
  if (!df.size) return [];

  const scored = docs
    .map(d => ({ d, s: score(d, queryTokens, df, docs.length) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);

  return scored.map(({ d, s }) => ({
    path: d.path,
    kind: d.kind,
    snippet: extractSnippet(d.content, queryTokens),
    score: Number(s.toFixed(3)),
  }));
}

// ── Fact persistence ──────────────────────────────────────────────────────────

/** Save a single fact (durable cross-session memory). */
export async function saveFact(text, { sessionId = "_global", source = "agent" } = {}) {
  if (!text || typeof text !== "string") return { ok: false, error: "empty fact" };
  const path = `memory/facts/${sessionId}.md`;
  const existing = await ghRead(path).catch(() => null);
  const now = new Date().toISOString();
  const bullet = `- [${now}] (${source}) ${text.trim().replace(/\n+/g, " ")}\n`;
  const next = (existing?.content ?? `# Facts — ${sessionId}\n\n`) + bullet;
  await ghWrite(path, next, existing?.sha ?? null);
  invalidateMemoryCache();
  return { ok: true, path, fact: text.trim() };
}

/** Append a (user, agent) pair to the per-session turn log. */
export async function recordTurn(sessionId, userMsg, agentReply) {
  if (!sessionId) return;
  const path = `memory/turns/${sessionId}.jsonl`;
  const existing = await ghRead(path).catch(() => null);
  const line = JSON.stringify({
    at: Date.now(),
    user: String(userMsg ?? "").slice(0, 4000),
    agent: String(agentReply ?? "").slice(0, 4000),
  }) + "\n";
  // Keep the turn log bounded — last 50 turns.
  const lines = ((existing?.content ?? "").trim() + "\n" + line).trim().split("\n").filter(Boolean).slice(-50);
  await ghWrite(path, lines.join("\n") + "\n", existing?.sha ?? null).catch(() => {});
}

/**
 * Distil durable facts from a recent message slice and append them to
 * memory/facts/<sessionId>.md. `llmCall` is a function (messages) => string.
 */
export async function distillFacts(sessionId, messages, llmCall) {
  if (!sessionId || !messages?.length || !llmCall) return { ok: false, facts: [] };
  // Take the last few turns — enough context, not too many tokens.
  const recent = messages.filter(m => m.role === "user" || m.role === "assistant").slice(-8);
  const transcript = recent.map(m => `${m.role.toUpperCase()}: ${String(m.content ?? "").slice(0, 800)}`).join("\n");

  const distillPrompt = [
    {
      role: "system",
      content:
        "You distil durable cross-session facts from a chat. Output ONLY a JSON array of strings. " +
        "Each string is one fact that will be useful in *future* conversations: user identity, preferences, " +
        "ongoing projects, infrastructure choices, recurring goals, or constraints. Skip greetings, " +
        "trivia about the current turn, and anything ephemeral. Return [] if nothing durable was said.",
    },
    { role: "user", content: `Recent conversation:\n\n${transcript}\n\nReturn the JSON array now.` },
  ];

  let facts = [];
  try {
    const raw = await llmCall(distillPrompt);
    const m = String(raw).match(/\[[\s\S]*\]/);
    facts = JSON.parse(m ? m[0] : raw);
    if (!Array.isArray(facts)) facts = [];
  } catch { facts = []; }

  const cleaned = facts
    .map(f => (typeof f === "string" ? f.trim() : ""))
    .filter(f => f && f.length > 4 && f.length < 400);

  for (const f of cleaned) {
    await saveFact(f, { sessionId, source: "distilled" }).catch(() => {});
  }
  return { ok: true, facts: cleaned };
}

// ── Reader helpers (for /memory endpoint + the browser UI) ────────────────────

export async function listMemoryRoots() {
  const out = {};
  for (const root of ["memory/facts", "memory/summaries", "memory/turns"]) {
    out[root] = await ghList(root).catch(() => []);
  }
  return out;
}

export async function readMemoryFile(path) {
  // Restrict to memory/** for safety.
  if (!/^memory\//.test(path)) return null;
  const r = await ghRead(path).catch(() => null);
  return r ? { path, content: r.content } : null;
}
