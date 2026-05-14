/**
 * api/chat.js — Web chat endpoint for termuxclawagent.vercel.app
 *
 * Accepts POST { message, sessionId } and streams Server-Sent Events:
 *   { type: "round",       round: N }
 *   { type: "thinking",    text: "..." }
 *   { type: "tool_call",   tool: "shell_exec", args: "..." }
 *   { type: "tool_result", text: "..." }
 *   { type: "reply",       text: "..." }
 *   { type: "error",       text: "..." }
 *   { type: "done" }
 *
 * Sessions are stored under sessions/web_<sessionId>.json in
 * the GitHub storage repo — fully separate from Telegram sessions.
 */

import https from "node:https";
import { exec } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ghRead, ghWrite } from "../src/sync/github-storage.mjs";
import { pullSession, pushSession } from "../src/storage/sessions.mjs";
import { nextApiKey, poolSize } from "../src/storage/keypool.mjs";
import { recall as memoryRecall, saveFact as memorySaveFact, recordTurn as memoryRecordTurn, distillFacts as memoryDistill } from "../src/memory/cloud-memory.mjs";

// ── Env ───────────────────────────────────────────────────────────────────────

const DEFAULT_API_KEY   = process.env.NVIDIA_API_KEY    ?? "";
const DEFAULT_BASE_URL  = process.env.NVIDIA_BASE_URL   ?? "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL     = process.env.MODEL             ?? "moonshotai/kimi-k2.6";
const MAX_TOOL_ROUNDS   = parseInt(process.env.MAX_TOOL_ROUNDS   ?? "15", 10);
const HISTORY_MAX_MSGS  = parseInt(process.env.HISTORY_MAX_MSGS  ?? "60", 10);
const CALL_TIMEOUT_MS   = parseInt(process.env.NVIDIA_TIMEOUT_MS ?? "250000", 10);

// ── Provider registry (all OpenAI-compatible) ─────────────────────────────────

const PROVIDERS = {
  nvidia:     { baseUrl: "https://integrate.api.nvidia.com/v1",  defaultModel: "moonshotai/kimi-k2.6" },
  openai:     { baseUrl: "https://api.openai.com/v1",            defaultModel: "gpt-4o" },
  groq:       { baseUrl: "https://api.groq.com/openai/v1",       defaultModel: "llama-3.3-70b-versatile" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1",         defaultModel: "openai/gpt-4o" },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1",          defaultModel: "deepseek-chat" },
  xai:        { baseUrl: "https://api.x.ai/v1",                  defaultModel: "grok-2" },
  mistral:    { baseUrl: "https://api.mistral.ai/v1",            defaultModel: "mistral-large-latest" },
  together:   { baseUrl: "https://api.together.xyz/v1",          defaultModel: "meta-llama/Llama-3-70b-chat-hf" },
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(model, providerName) {
  return `You are Solis, an advanced AI agent accessible via the TermuxClawAgent web interface.
You are powered by ${model} via ${providerName}, running on Vercel cloud.

## Identity
- Name: Solis (TermuxClawAgent)
- Interface: Web chat at termuxclawagent.vercel.app
- Storage: GitHub repo — vault and sessions synced

## Your Tools
- **shell_exec**: Run any bash/Linux command (Amazon Linux, /tmp writable)
- **file_write**: Write a file to /tmp (ephemeral — use vault to persist)
- **vault_read**: Read a note from the GitHub memory vault
- **vault_write**: Write a note to the GitHub memory vault
- **vault_list**: List vault notes
- **vault_search**: Full-text search across vault
- **memory_recall**: Search persistent memory + vault (RAG) for prior context
- **memory_save**: Save a durable fact that will survive across sessions
- **http_get**: Make an HTTP GET request

## Persistent Memory
You have a cross-session memory backed by GitHub at solis-agent-files/memory/.
Relevant snippets are auto-injected as <PRIOR_CONTEXT> at the start of each turn.
If you learn something durable (user preferences, project facts, choices), call
memory_save to persist it. Use memory_recall to dig deeper when the auto-context
isn't enough.

## Shell environment
- OS: Amazon Linux (Vercel serverless)
- Available: bash, python3, node, curl, wget, git, grep, awk, sed, jq, find, zip, openssl
- Writable path: /tmp (ephemeral — use vault_write to persist important results)

## Rules
- Always use tools for real work. Never fake or simulate output.
- After running commands, store useful results in the vault for future sessions.
- Be concise but thorough. Use markdown.`;}
const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_MODEL, "NVIDIA NIM");

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a bash command on the Vercel Linux server. Returns stdout, stderr, exit_code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", description: "Max ms (default 25000, max 60000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to /tmp (ephemeral). Use vault_write to persist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path inside /tmp" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_read",
      description: "Read a note from the GitHub memory vault.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "e.g. Memory/Facts/user.md" },
        },
        required: ["note_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_write",
      description: "Write a note to the GitHub memory vault (persists across sessions).",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["note_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_list",
      description: "List notes in the vault.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_search",
      description: "Full-text search across vault notes.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "HTTP GET request. Returns status + body.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Search persistent cross-session memory + the markdown/html vault for snippets relevant to a query. Use when prior context might be useful.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to recall (a question or topic)" },
          k: { type: "integer", description: "Max number of snippets (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description: "Save a durable fact to persistent memory. Use for user identity, preferences, project facts, and any cross-session knowledge.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One concise fact (single sentence)" },
          scope: { type: "string", enum: ["session", "global"], description: "session = this session only; global = all sessions for this user (default global)" },
        },
        required: ["fact"],
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

const vaultCache = new Map();

async function execTool(name, args, ctx = {}) {
  try {
    switch (name) {
      case "shell_exec": {
        const timeout = Math.min(args.timeout_ms ?? 25000, 60000);
        return await new Promise(res =>
          exec(args.command, { timeout, maxBuffer: 1024 * 512, shell: "/bin/bash" }, (err, stdout, stderr) =>
            res({ stdout: (stdout ?? "").slice(0, 6000), stderr: (stderr ?? "").slice(0, 2000), exit_code: err?.code ?? 0 })
          )
        );
      }
      case "file_write": {
        const safe = args.path.startsWith("/tmp/") ? args.path : `/tmp/${args.path.replace(/^\/+/, "")}`;
        mkdirSync(dirname(safe), { recursive: true });
        writeFileSync(safe, args.content, "utf8");
        return { success: true, path: safe };
      }
      case "vault_read": {
        const rp = `vault/${args.note_path}`;
        if (vaultCache.has(rp)) return { content: vaultCache.get(rp) };
        const r = await ghRead(rp);
        if (!r) return { error: `Not found: ${args.note_path}` };
        vaultCache.set(rp, r.content);
        return { content: r.content.slice(0, 10000) };
      }
      case "vault_write": {
        const rp = `vault/${args.note_path}`;
        const ex = await ghRead(rp);
        await ghWrite(rp, args.content, ex?.sha ?? null);
        vaultCache.set(rp, args.content);
        return { success: true, note_path: args.note_path };
      }
      case "vault_list": {
        const { ghList } = await import("../src/sync/github-storage.mjs");
        const prefix = args.path ? `vault/${args.path}` : "vault";
        const entries = await ghList(prefix);
        return { entries: entries.map(e => e.type === "dir" ? e.name + "/" : e.name) };
      }
      case "vault_search": {
        const q = args.query.toLowerCase();
        const results = [];
        async function search(dir) {
          const { ghList } = await import("../src/sync/github-storage.mjs");
          for (const e of await ghList(dir)) {
            if (e.type === "dir") await search(e.path);
            else if (e.name.endsWith(".md")) {
              const f = await ghRead(e.path);
              if (f?.content.toLowerCase().includes(q)) {
                const lines = f.content.split("\n").filter(l => l.toLowerCase().includes(q));
                results.push({ note: e.path.replace(/^vault\//, ""), matches: lines.slice(0, 3) });
              }
            }
          }
        }
        await search("vault");
        return { query: args.query, results };
      }
      case "http_get": {
        return await new Promise(res =>
          https.get(args.url, { timeout: 15000 }, r => {
            let body = "";
            r.on("data", c => body += c);
            r.on("end", () => res({ status: r.statusCode, body: body.slice(0, 8000) }));
          }).on("error", e => res({ error: e.message }))
        );
      }
      case "memory_recall": {
        const k = Math.min(args.k ?? 5, 10);
        const hits = await memoryRecall(args.query ?? "", { k });
        return { query: args.query, hits };
      }
      case "memory_save": {
        const scope = args.scope === "session" ? (ctx.sessionId || "_global") : "_global";
        const r = await memorySaveFact(args.fact ?? "", { sessionId: scope, source: "agent" });
        return r;
      }
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

function llmPost(baseUrl, apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${baseUrl}/chat/completions`);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      req.destroy(); reject(new Error(`LLM timeout after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST", agent: keepAlive,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${apiKey}`,
      },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
      res.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    });
    req.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    req.write(data); req.end();
  });
}

async function llmPostRetry(baseUrl, apiKey, body, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await llmPost(baseUrl, apiKey, body); }
    catch (err) {
      last = err;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(userText, history, send, providerCfg = {}, ctx = {}) {
  const {
    apiKey   = DEFAULT_API_KEY,
    baseUrl  = DEFAULT_BASE_URL,
    model    = DEFAULT_MODEL,
    provider = "NVIDIA NIM",
  } = providerCfg;

  let systemPrompt = buildSystemPrompt(model, provider);

  // ── Auto-inject relevant memory snippets (RAG) ───────────────────────────────
  // Pulled once at the start of the turn from memory/** + vault/** in the
  // storage repo. Gives the agent prior-session context without any tool call.
  try {
    const hits = await memoryRecall(userText, { k: 4 });
    if (hits.length) {
      const block = hits
        .map((h, i) => `[#${i + 1} ${h.path}]\n${h.snippet}`)
        .join("\n\n");
      systemPrompt += `\n\n<PRIOR_CONTEXT note="Top relevant snippets from your persistent memory. Trust them as background, verify before acting on them.">\n${block}\n</PRIOR_CONTEXT>`;
      send("memory_hits", { count: hits.length, paths: hits.map(h => h.path) });
    }
  } catch {}

  history.push({ role: "user", content: userText });
  const getMessages = () => [{ role: "system", content: systemPrompt }, ...history.slice(-HISTORY_MAX_MSGS)];

  // Whether this provider supports NIM-style thinking params
  const isNvidia = baseUrl.includes("nvidia") || baseUrl.includes("integrate.api");

  let round = 0;
  let finalContent = null;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    send("round", { round });

    const reqBody = {
      model,
      messages: getMessages(),
      max_tokens: 16384,
      temperature: 1.0,
      top_p: 1.0,
      stream: false,
      tools: TOOLS,
      tool_choice: "auto",
      ...(isNvidia ? { chat_template_kwargs: { thinking: true } } : {}),
    };

    const res = await llmPostRetry(baseUrl, apiKey, reqBody);

    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty response from provider");

    const msg = choice.message;
    const toolCalls = msg?.tool_calls;
    const thinking = msg?.reasoning_content ?? msg?.reasoning ?? "";

    if (thinking) {
      send("thinking", { text: thinking.slice(0, 600) + (thinking.length > 600 ? "…" : "") });
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msg?.content || thinking || "";
      history.push({ role: "assistant", content: finalContent });
      break;
    }

    history.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      const keyArg = fnArgs.command || fnArgs.note_path || fnArgs.path || fnArgs.query || fnArgs.url || "";
      send("tool_call", { tool: fnName, args: String(keyArg).slice(0, 150) || JSON.stringify(fnArgs).slice(0, 150) });

      const result = await execTool(fnName, fnArgs, ctx);
      const out = result.stdout ?? result.content ?? result.error ?? JSON.stringify(result);
      send("tool_result", { text: String(out).slice(0, 500) });

      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: JSON.stringify(result) });
    }

    if (round === MAX_TOOL_ROUNDS) {
      history.push({ role: "user", content: "Tool limit reached. Summarize and give your final answer." });
      const fr = await llmPostRetry(baseUrl, apiKey, {
        model, messages: getMessages(), max_tokens: 8192, temperature: 1.0, top_p: 1.0, stream: false,
      });
      const fm = fr?.choices?.[0]?.message;
      finalContent = fm?.content || fm?.reasoning_content || "";
      history.push({ role: "assistant", content: finalContent });
    }
  }

  return { reply: (finalContent || "").trim(), history };
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message, sessionId, userApiKey, userProvider, userModel } = req.body ?? {};
  if (!message?.trim() || !sessionId) return res.status(400).json({ error: "missing message or sessionId" });

  // Build provider config — user key takes priority over pool key
  const providerKey = userProvider && PROVIDERS[userProvider] ? userProvider : "nvidia";
  const providerInfo = PROVIDERS[providerKey];
  const poolKey = providerKey === "nvidia" ? await nextApiKey().catch(() => DEFAULT_API_KEY) : DEFAULT_API_KEY;
  const providerCfg = {
    apiKey:   userApiKey?.trim() || poolKey,
    baseUrl:  providerInfo.baseUrl,
    model:    userModel?.trim()  || providerInfo.defaultModel,
    provider: providerKey.charAt(0).toUpperCase() + providerKey.slice(1),
    poolSize: poolSize(),
  };
  if (!providerCfg.apiKey) {
    res.setHeader("Content-Type", "application/json");
    return res.status(400).json({ error: "No API key available. Please add your own key in the API Configuration panel." });
  }

  // Stream SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // ── Dual-track: SSE for live UX + GitHub job record for page-leave survival ─
  const jobId = randomUUID();
  const created = Date.now();
  const jobPath = `sessions/jobs/${jobId}.json`;
  const jobBase = {
    id: jobId,
    mode: "chat",
    status: "running",
    message: message.trim(),
    sessionId,
    provider: providerCfg.provider,
    model: providerCfg.model,
    created,
    updated: created,
    rounds: [],
    reply: null,
    error: null,
    durationMs: null,
  };

  const rounds = [];
  let currentRound = null;

  async function ghSafeWrite(content) {
    try {
      const existing = await ghRead(jobPath);
      await ghWrite(jobPath, content, existing?.sha ?? null);
    } catch {
      try {
        const fresh = await ghRead(jobPath);
        await ghWrite(jobPath, content, fresh?.sha ?? null);
      } catch {}
    }
  }

  // Serialized write chain so concurrent updates don't race the GitHub sha
  let writeChain = ghSafeWrite(JSON.stringify(jobBase, null, 2));
  const persistState = (overrides = {}) => {
    const snap = {
      ...jobBase,
      ...overrides,
      rounds: currentRound ? [...rounds, currentRound] : [...rounds],
      updated: Date.now(),
    };
    writeChain = writeChain.then(() => ghSafeWrite(JSON.stringify(snap, null, 2))).catch(() => {});
  };

  // Tell the client its jobId immediately so it can persist and reattach on reload.
  // We deliberately ignore SSE write failures everywhere — the agent must keep
  // running even after the browser disconnects.
  const sseWrite = (type, data = {}) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };
  sseWrite("job", { jobId });

  // Periodic keep-alive comment so the long SSE doesn't get idled out.
  const keepAlive = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
  }, 15000);

  // Wrap `send` so every event also updates the job record.
  const send = (type, data = {}) => {
    sseWrite(type, data);
    switch (type) {
      case "round":
        if (currentRound) rounds.push(currentRound);
        currentRound = { round: data.round, thinking: "", toolCalls: [] };
        persistState();
        break;
      case "thinking":
        if (currentRound) currentRound.thinking = data.text;
        break;
      case "tool_call":
        if (currentRound) currentRound.toolCalls.push({ tool: data.tool, args: data.args, result: "" });
        break;
      case "tool_result":
        if (currentRound) {
          const tc = currentRound.toolCalls[currentRound.toolCalls.length - 1];
          if (tc) tc.result = data.text;
        }
        break;
    }
  };

  // Detach the run from the request — if the client disconnects, the function
  // keeps running until Vercel's maxDuration. We deliberately do NOT abort on close.
  req.on?.("close", () => { /* no-op; let the agent finish */ });

  try {
    const webSessionKey = `web_${sessionId}`;
    const stored = await pullSession(webSessionKey).catch(() => null);
    const history = stored ?? [];

    send("provider", { name: providerCfg.provider, model: providerCfg.model, poolSize: providerCfg.poolSize });
    const { reply, history: updated } = await runAgent(message.trim(), history, send, providerCfg, { sessionId });
    if (currentRound) { rounds.push(currentRound); currentRound = null; }

    const toSave = updated.filter(m => m.role !== "system").slice(-HISTORY_MAX_MSGS);
    pushSession(webSessionKey, JSON.stringify(toSave, null, 2)).catch(() => {});

    // ── Persistent memory side-effects (best-effort, non-blocking on errors) ──
    memoryRecordTurn(sessionId, message.trim(), reply).catch(() => {});

    // Distil durable facts using one cheap LLM call. We hand it a minimal LLM
    // shim that maps onto our existing llmPostRetry.
    const llmShim = async (msgs) => {
      const r = await llmPostRetry(providerCfg.baseUrl, providerCfg.apiKey, {
        model: providerCfg.model, messages: msgs, max_tokens: 600, temperature: 0.3, top_p: 1.0, stream: false,
      });
      return r?.choices?.[0]?.message?.content ?? "";
    };
    memoryDistill(sessionId, updated, llmShim).catch(() => {});

    sseWrite("reply", { text: reply });
    sseWrite("done");

    await writeChain;
    await ghSafeWrite(JSON.stringify({
      ...jobBase,
      status: "done",
      rounds,
      reply,
      updated: Date.now(),
      durationMs: Date.now() - created,
    }, null, 2));
  } catch (err) {
    sseWrite("error", { text: err.message });
    if (currentRound) { rounds.push(currentRound); currentRound = null; }
    await writeChain;
    await ghSafeWrite(JSON.stringify({
      ...jobBase,
      status: "error",
      rounds,
      error: err.message,
      updated: Date.now(),
      durationMs: Date.now() - created,
    }, null, 2)).catch(() => {});
  }

  clearInterval(keepAlive);
  try { res.end(); } catch {}
}
