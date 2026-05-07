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
import { ghRead, ghWrite, pullSession, pushSession } from "../src/sync/github-storage.mjs";

// ── Env ───────────────────────────────────────────────────────────────────────

const NVIDIA_API_KEY    = process.env.NVIDIA_API_KEY    ?? "";
const NVIDIA_BASE_URL   = process.env.NVIDIA_BASE_URL   ?? "https://integrate.api.nvidia.com/v1";
const MODEL             = process.env.MODEL             ?? "moonshotai/kimi-k2.6";
const MAX_TOOL_ROUNDS   = parseInt(process.env.MAX_TOOL_ROUNDS   ?? "15", 10);
const HISTORY_MAX_MSGS  = parseInt(process.env.HISTORY_MAX_MSGS  ?? "60", 10);
const NVIDIA_TIMEOUT_MS = parseInt(process.env.NVIDIA_TIMEOUT_MS ?? "250000", 10);

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Solis, an advanced AI agent accessible via the TermuxClawAgent web interface.
You are powered by ${MODEL} via NVIDIA NIM, running on Vercel cloud.

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
- **http_get**: Make an HTTP GET request

## Shell environment
- OS: Amazon Linux (Vercel serverless)
- Available: bash, python3, node, curl, wget, git, grep, awk, sed, jq, find, zip, openssl
- Writable path: /tmp (ephemeral — use vault_write to persist important results)

## Rules
- Always use tools for real work. Never fake or simulate output.
- After running commands, store useful results in the vault for future sessions.
- Be concise but thorough. Use markdown.`;

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
];

// ── Tool executor ─────────────────────────────────────────────────────────────

const vaultCache = new Map();

async function execTool(name, args) {
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
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

function nimPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${NVIDIA_BASE_URL}/chat/completions`);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      req.destroy(); reject(new Error(`NIM timeout after ${NVIDIA_TIMEOUT_MS / 1000}s`));
    }, NVIDIA_TIMEOUT_MS);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST", agent: keepAlive,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
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

async function nimPostRetry(body, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await nimPost(body); }
    catch (err) {
      last = err;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgent(userText, history, send) {
  history.push({ role: "user", content: userText });
  const getMessages = () => [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-HISTORY_MAX_MSGS)];

  let round = 0;
  let finalContent = null;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    send("round", { round });

    const res = await nimPostRetry({
      model: MODEL,
      messages: getMessages(),
      max_tokens: 16384,
      temperature: 1.0,
      top_p: 1.0,
      stream: false,
      tools: TOOLS,
      tool_choice: "auto",
      chat_template_kwargs: { thinking: true },
    });

    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty response from NIM");

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

      const result = await execTool(fnName, fnArgs);
      const out = result.stdout ?? result.content ?? result.error ?? JSON.stringify(result);
      send("tool_result", { text: String(out).slice(0, 500) });

      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: JSON.stringify(result) });
    }

    if (round === MAX_TOOL_ROUNDS) {
      history.push({ role: "user", content: "Tool limit reached. Summarize and give your final answer." });
      const fr = await nimPostRetry({
        model: MODEL, messages: getMessages(), max_tokens: 8192, temperature: 1.0, top_p: 1.0, stream: false,
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

  const { message, sessionId } = req.body ?? {};
  if (!message?.trim() || !sessionId) return res.status(400).json({ error: "missing message or sessionId" });

  // Stream SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (type, data = {}) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };

  try {
    const webSessionKey = `web_${sessionId}`;
    const stored = await pullSession(webSessionKey).catch(() => null);
    const history = stored ?? [];

    const { reply, history: updated } = await runAgent(message.trim(), history, send);

    const toSave = updated.filter(m => m.role !== "system").slice(-HISTORY_MAX_MSGS);
    pushSession(webSessionKey, JSON.stringify(toSave, null, 2)).catch(() => {});

    send("reply", { text: reply });
    send("done");
  } catch (err) {
    send("error", { text: err.message });
  }

  res.end();
}
