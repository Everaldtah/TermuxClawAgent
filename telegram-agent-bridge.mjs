#!/usr/bin/env node
/**
 * Telegram ↔ TermuxClawAgent Bridge
 * - Real OpenAI-style function/tool calling (executed on-device)
 * - Persistent session memory (saved to disk between restarts)
 * - Live tool-feed streamed to Telegram while the agent is thinking
 * - Reasoning/thinking content surfaced in the live feed
 *
 * Configuration via environment variables (see .env.example):
 *   TELEGRAM_TOKEN   — Telegram bot token
 *   NVIDIA_API_KEY   — NVIDIA NIM API key
 *   MODEL            — model override (default: moonshotai/kimi-k2.5)
 */

import https from "node:https";
import { execSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { pushSession, pullSession, syncVault } from "./src/sync/github-storage.mjs";

// ── Environment variable loader ───────────────────────────────────────────────
// Reads .env file from the agent directory if present, then falls back to
// process.env. Credentials MUST be set via env — never hardcode them.

function loadEnv() {
  const envPaths = [
    join(homedir(), "TermuxClawAgent", ".env"),
    join(homedir(), ".termux-agent", ".env"),
    resolve(".env"),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !process.env[key]) process.env[key] = val;
      }
      console.log(`  📄 Loaded env from ${envPath}`);
      break;
    }
  }
}
loadEnv();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Missing required env var: ${name}`);
    console.error(`   Set it in .env or export ${name}=... before starting.`);
    process.exit(1);
  }
  return val;
}

const TELEGRAM_TOKEN  = requireEnv("TELEGRAM_TOKEN");
const NVIDIA_API_KEY  = requireEnv("NVIDIA_API_KEY");
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const MODEL           = process.env.MODEL           ?? "moonshotai/kimi-k2.5";
const NVIDIA_TIMEOUT_MS = parseInt(process.env.NVIDIA_TIMEOUT_MS ?? "300000", 10);
const MAX_TOOL_ROUNDS   = parseInt(process.env.MAX_TOOL_ROUNDS   ?? "20",     10);
const HISTORY_MAX_MSGS  = parseInt(process.env.HISTORY_MAX_MSGS  ?? "60",     10);
const VAULT_PATH        = process.env.VAULT_PATH ?? "/storage/emulated/0/Documents/SoligAgentMemory";
const SESSIONS_PATH     = join(homedir(), ".termux-agent", "sessions");

const TG_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Keep-alive agent prevents Android from killing long-lived NIM connections
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Solis, an advanced AI agent running on Android via Termux. You are powered by ${MODEL} via NVIDIA NIM.

## Identity
- Name: Solis (TermuxClawAgent)
- Platform: Android / Termux
- Interface: Telegram (@SolisTermuxclaw_bot)

## Your Real Tools (call these to actually do things — don't just describe them)
- **shell_exec**: Run any bash/termux command on the device
- **file_read**: Read a file from the filesystem
- **file_write**: Write or overwrite a file
- **file_list**: List files in a directory
- **obsidian_read**: Read a note from your memory vault
- **obsidian_write**: Save a note to your memory vault
- **obsidian_append**: Append content to an existing vault note
- **obsidian_list**: List notes in the vault
- **obsidian_search**: Full-text search across vault notes
- **http_get**: Make an HTTP GET request to an external URL
- **vault_sync**: Commit and push vault changes to GitHub

## Memory Vault Layout (${VAULT_PATH})
- Memory/Skills/ — things you know how to do
- Memory/Daily/  — daily activity logs
- Memory/Facts/  — facts about the user and environment

## Rules
- ALWAYS use tools to do real work. Never fake output.
- After completing a task, briefly summarize what you did.
- Store useful information in the vault so you remember it next session.
- Use markdown for clarity.`;

// ── Tool schemas (OpenAI function-calling format) ─────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a bash command in Termux. Returns stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run" },
          timeout_ms: { type: "integer", description: "Timeout in ms (default 30000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (supports ~ for home)" },
          max_chars: { type: "integer", description: "Max chars to return (default 8000)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file (creates or overwrites).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: home)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obsidian_read",
      description: "Read a note from the Obsidian memory vault.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "Path relative to vault root, e.g. Memory/Facts/user.md" },
        },
        required: ["note_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obsidian_write",
      description: "Write (create or overwrite) a note in the vault.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string" },
          content: { type: "string", description: "Markdown content" },
        },
        required: ["note_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obsidian_append",
      description: "Append content to an existing vault note (creates if missing).",
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
      name: "obsidian_list",
      description: "List notes and folders in the vault.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Sub-path within vault (default: root)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "obsidian_search",
      description: "Full-text search across all vault notes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "Make an HTTP GET request and return the response body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_sync",
      description: "Commit and push all pending vault changes to GitHub.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ── Vault → GitHub auto-sync ──────────────────────────────────────────────────

let _syncTimer = null;
const _pendingFiles = new Set();

function vaultSync(notePath) {
  if (notePath) _pendingFiles.add(notePath);
  if (_syncTimer) clearTimeout(_syncTimer);
  return new Promise((resolve) => {
    _syncTimer = setTimeout(async () => {
      _syncTimer = null;
      const label = [..._pendingFiles].join(", ").slice(0, 120);
      _pendingFiles.clear();
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        const git = (args) => run("git", args, { cwd: VAULT_PATH });
        await git(["add", "-A"]);
        const { stdout: diff } = await git(["diff", "--cached", "--name-only"]);
        if (!diff.trim()) { resolve({ skipped: true }); return; }
        const msg = `${new Date().toISOString().slice(0, 16)} — ${label || "vault update"}`;
        await git(["commit", "-m", msg]);
        await git(["push", "origin", "main"]);
        console.log(`  📤 Vault synced to GitHub: ${msg}`);
        resolve({ synced: true, message: msg });
      } catch (err) {
        console.error(`  ⚠ Vault sync failed: ${err.message}`);
        resolve({ error: err.message });
      }
    }, 3000);
  });
}

// ── Tool executors ────────────────────────────────────────────────────────────

function expandPath(p) {
  if (!p) return homedir();
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

async function execTool(name, args) {
  console.log(`  🔧 TOOL: ${name}(${JSON.stringify(args).slice(0, 120)})`);
  try {
    switch (name) {

      case "shell_exec": {
        const timeout = args.timeout_ms ?? 30000;
        return await new Promise((res) => {
          exec(args.command, { timeout, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
            res({
              stdout: stdout?.slice(0, 4000) || "",
              stderr: stderr?.slice(0, 1000) || "",
              exit_code: err?.code ?? 0,
            });
          });
        });
      }

      case "file_read": {
        const p = expandPath(args.path);
        if (!existsSync(p)) return { error: `File not found: ${p}` };
        const content = readFileSync(p, "utf8");
        const max = args.max_chars ?? 8000;
        return { content: content.slice(0, max), truncated: content.length > max };
      }

      case "file_write": {
        const p = expandPath(args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content, "utf8");
        return { success: true, path: p };
      }

      case "file_list": {
        const p = expandPath(args.path || "~");
        if (!existsSync(p)) return { error: `Path not found: ${p}` };
        const entries = readdirSync(p).map(name => {
          const full = join(p, name);
          return statSync(full).isDirectory() ? name + "/" : name;
        });
        return { path: p, entries };
      }

      case "obsidian_read": {
        const p = join(VAULT_PATH, args.note_path);
        if (!existsSync(p)) return { error: `Note not found: ${args.note_path}` };
        const content = readFileSync(p, "utf8");
        return { content: content.slice(0, 10000) };
      }

      case "obsidian_write": {
        const p = join(VAULT_PATH, args.note_path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content, "utf8");
        vaultSync(args.note_path).catch(() => {});
        return { success: true, note_path: args.note_path };
      }

      case "obsidian_append": {
        const p = join(VAULT_PATH, args.note_path);
        mkdirSync(dirname(p), { recursive: true });
        await appendFile(p, "\n" + args.content, "utf8");
        vaultSync(args.note_path).catch(() => {});
        return { success: true, note_path: args.note_path };
      }

      case "obsidian_list": {
        const sub = args.path || "";
        const p = join(VAULT_PATH, sub);
        if (!existsSync(p)) return { error: `Path not found in vault: ${sub || "(root)"}` };
        function listDir(dir, prefix = "") {
          const out = [];
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
              out.push(prefix + entry + "/");
              out.push(...listDir(full, prefix + entry + "/"));
            } else {
              out.push(prefix + entry);
            }
          }
          return out;
        }
        return { vault_path: p, entries: listDir(p) };
      }

      case "obsidian_search": {
        const q = args.query.toLowerCase();
        const results = [];
        function searchDir(dir, rel = "") {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const relPath = rel ? rel + "/" + entry : entry;
            if (statSync(full).isDirectory()) {
              searchDir(full, relPath);
            } else if (entry.endsWith(".md")) {
              const content = readFileSync(full, "utf8");
              if (content.toLowerCase().includes(q)) {
                const lines = content.split("\n").filter(l => l.toLowerCase().includes(q));
                results.push({ note: relPath, matches: lines.slice(0, 3) });
              }
            }
          }
        }
        searchDir(VAULT_PATH);
        return { query: args.query, results };
      }

      case "http_get": {
        return await new Promise((res) => {
          https.get(args.url, { timeout: 15000 }, (r) => {
            let body = "";
            r.on("data", c => body += c);
            r.on("end", () => res({ status: r.statusCode, body: body.slice(0, 8000) }));
          }).on("error", e => res({ error: e.message }));
        });
      }

      case "vault_sync": {
        return await vaultSync();
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`  ✗ Tool ${name} error: ${err.message}`);
    return { error: err.message };
  }
}

// ── Persistent session memory ─────────────────────────────────────────────────

function sessionFile(chatId) {
  return join(SESSIONS_PATH, `${chatId}.json`);
}

async function loadSession(chatId) {
  const f = sessionFile(chatId);
  // Try GitHub first (two-way: remote may be newer from cloud agent)
  const remote = await pullSession(chatId).catch(() => null);
  if (remote) {
    writeFileSync(f, JSON.stringify(remote, null, 2), "utf8");
    console.log(`  📂 Loaded ${remote.length} messages for chat ${chatId} (GitHub)`);
    return remote;
  }
  if (existsSync(f)) {
    try {
      const data = JSON.parse(readFileSync(f, "utf8"));
      console.log(`  📂 Loaded ${data.length} messages for chat ${chatId} (local)`);
      return data;
    } catch { return []; }
  }
  return [];
}

async function saveSession(chatId, messages) {
  const toSave = messages.filter(m => m.role !== "system").slice(-HISTORY_MAX_MSGS);
  const json = JSON.stringify(toSave, null, 2);
  writeFileSync(sessionFile(chatId), json, "utf8");
  // Push to GitHub so cloud agent can pick it up
  pushSession(chatId, json).catch(err => console.warn(`  ⚠ session push: ${err.message}`));
}

const histories = new Map();

async function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, await loadSession(chatId));
  return histories.get(chatId);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsPost(url, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    let settled = false;

    const wallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      timeout: timeoutMs,
      agent: keepAliveAgent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        if (statusCode === 429) {
          const retryAfter = res.headers["retry-after"];
          const err = new Error(`rate_limited${retryAfter ? `:${retryAfter}` : ""}`);
          err.code = "RATE_LIMITED";
          err.retryAfter = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
          return reject(err);
        }
        if (statusCode >= 500) {
          return reject(new Error(`NIM server error ${statusCode}: ${typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`));
        }
        resolve(parsed);
      });
      res.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        reject(e);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Socket idle timeout")));
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

const RETRYABLE = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "RATE_LIMITED"]);
function isRetryable(err) {
  const msg = err?.message ?? "";
  const code = err?.code ?? "";
  return RETRYABLE.has(code) || msg.includes("ETIMEDOUT") || msg.includes("timed out") || msg.includes("ECONNRESET");
}

async function httpsPostWithRetry(url, body, headers = {}, timeoutMs = 30000, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await httpsPost(url, body, headers, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) break;
      const delay = err.retryAfter ?? (2000 * Math.pow(2, attempt));
      console.warn(`  ⚠ NIM error (${err.message}), retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("NIM request failed");
}

function httpsGet(url, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    let res = await httpsPost(`${TG_BASE}/sendMessage`, {
      chat_id: chatId, text: chunk, parse_mode: "Markdown",
    }).catch(() => null);
    if (!res?.ok) {
      // Fallback: plain text (Markdown might have unescaped chars)
      res = await httpsPost(`${TG_BASE}/sendMessage`, { chat_id: chatId, text: chunk }).catch(() => null);
    }
    if (!res?.ok) console.error("sendMessage failed:", res?.description);
  }
}

async function deleteMessage(chatId, messageId) {
  if (!messageId) return;
  await httpsPost(`${TG_BASE}/deleteMessage`, { chat_id: chatId, message_id: messageId }).catch(() => {});
}

function startTyping(chatId) {
  const send = () =>
    httpsPost(`${TG_BASE}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
  send();
  const iv = setInterval(send, 4000);
  return () => clearInterval(iv);
}

// ── Live stream helper ────────────────────────────────────────────────────────
// Keeps one Telegram message updated with a scrolling log of tool activity.
// Throttled to 1 edit/s to stay under Telegram rate limits.

function makeStreamer(chatId) {
  let msgId = null;
  let lines = [];
  let lastEdit = 0;
  let pending = false;

  const render = () => {
    const body = lines.slice(-18).join("\n");
    return `\`\`\`\n${body}\n\`\`\``;
  };

  const flush = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastEdit < 1100) {
      if (!pending) {
        pending = true;
        setTimeout(() => { pending = false; flush(true); }, 1200);
      }
      return;
    }
    lastEdit = now;
    if (msgId) {
      await httpsPost(`${TG_BASE}/editMessageText`, {
        chat_id: chatId, message_id: msgId, text: render(), parse_mode: "Markdown",
      }).catch(() => {});
    } else {
      const r = await httpsPost(`${TG_BASE}/sendMessage`, {
        chat_id: chatId, text: render(), parse_mode: "Markdown",
      }).catch(() => null);
      msgId = r?.result?.message_id ?? null;
    }
  };

  return {
    push: async (line) => { lines.push(line); await flush(); },
    finish: async () => { await flush(true); },
    delete: async () => { if (msgId) await deleteMessage(chatId, msgId); },
    getMsgId: () => msgId,
  };
}

// ── NVIDIA NIM agentic loop ───────────────────────────────────────────────────

async function runAgent(chatId, userText) {
  const history = await getHistory(chatId);
  history.push({ role: "user", content: userText });

  const getMessages = () => [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-HISTORY_MAX_MSGS),
  ];

  const stream = makeStreamer(chatId);
  await stream.push(`🤖 Solis — ${new Date().toLocaleTimeString()}`);
  await stream.push(`💬 "${userText.slice(0, 60)}${userText.length > 60 ? "…" : ""}"`);
  await stream.push("─".repeat(30));

  let round = 0;
  let finalContent = null;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    console.log(`  → NIM call round ${round}`);
    await stream.push(`▶ [R${round}] calling ${MODEL.split("/").pop()}…`);

    const res = await httpsPostWithRetry(
      `${NVIDIA_BASE_URL}/chat/completions`,
      {
        model: MODEL,
        messages: getMessages(),
        max_tokens: 16384,
        temperature: 1.0,
        top_p: 1.0,
        stream: false,
        tools: TOOLS,
        tool_choice: "auto",
        chat_template_kwargs: { thinking: true },
      },
      { Authorization: `Bearer ${NVIDIA_API_KEY}` },
      NVIDIA_TIMEOUT_MS,
      3,
    );

    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty response from NVIDIA NIM");

    const msg = choice.message;
    const toolCalls = msg?.tool_calls;

    // Surface any reasoning/thinking content in the live feed
    const thinking = msg?.reasoning_content ?? msg?.reasoning ?? "";
    if (thinking) {
      const snippet = thinking.slice(0, 200).replace(/\n+/g, " ").trim();
      await stream.push(`💭 ${snippet}${thinking.length > 200 ? "…" : ""}`);
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msg?.content || thinking || "";
      if (!finalContent) {
        await stream.push("⚠ empty reply — requesting summary");
        history.push({ role: "assistant", content: "" });
        history.push({ role: "user", content: "Please summarize what you just did and provide your response." });
        const sr = await httpsPostWithRetry(
          `${NVIDIA_BASE_URL}/chat/completions`,
          {
            model: MODEL,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-HISTORY_MAX_MSGS)],
            max_tokens: 4096,
            temperature: 1.0,
            top_p: 1.0,
            stream: false,
          },
          { Authorization: `Bearer ${NVIDIA_API_KEY}` },
          NVIDIA_TIMEOUT_MS, 2,
        );
        const sm = sr?.choices?.[0]?.message;
        finalContent = sm?.content || sm?.reasoning_content || sm?.reasoning || "";
        history.push({ role: "assistant", content: finalContent });
      } else {
        history.push({ role: "assistant", content: finalContent });
      }
      break;
    }

    history.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

      const keyArg = fnArgs.command || fnArgs.path || fnArgs.note_path || fnArgs.url || fnArgs.query || "";
      await stream.push(`🔧 ${fnName}${keyArg ? `(${String(keyArg).slice(0, 50)})` : ""}`);

      const result = await execTool(fnName, fnArgs);
      const resultStr = JSON.stringify(result);
      console.log(`  ← Tool result: ${resultStr.slice(0, 200)}`);

      const out = result.stdout ?? result.content ?? result.error ?? resultStr;
      const outClean = String(out).replace(/\n+/g, " ").trim();
      await stream.push(`   ↳ ${outClean.slice(0, 100)}${outClean.length > 100 ? "…" : ""}`);

      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: resultStr });
    }

    if (round === MAX_TOOL_ROUNDS) {
      await stream.push("⚠ round limit — forcing summary");
      history.push({ role: "user", content: "You've reached the tool call limit. Please summarize everything you've done and provide your final answer now." });
      const fr = await httpsPostWithRetry(
        `${NVIDIA_BASE_URL}/chat/completions`,
        {
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-HISTORY_MAX_MSGS)],
          max_tokens: 8192,
          temperature: 1.0,
          top_p: 1.0,
          stream: false,
        },
        { Authorization: `Bearer ${NVIDIA_API_KEY}` },
        NVIDIA_TIMEOUT_MS, 2,
      );
      const fm = fr?.choices?.[0]?.message;
      finalContent = fm?.content || fm?.reasoning_content || fm?.reasoning || "";
      history.push({ role: "assistant", content: finalContent });
    }
  }

  if (!finalContent) {
    finalContent = "⚠️ Task completed but no summary was generated.";
    history.push({ role: "assistant", content: finalContent });
  }

  await stream.push("─".repeat(30));
  await stream.push("✅ done");
  await stream.finish();

  await saveSession(chatId, history);
  return finalContent.trim();
}

// ── Main polling loop ─────────────────────────────────────────────────────────

let offset = 0;
let pollBackoff = 0;
let pollErrCount = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function poll() {
  try {
    const data = await httpsGet(`${TG_BASE}/getUpdates?timeout=20&offset=${offset}`, 25000);
    if (!data?.ok || !Array.isArray(data.result)) return;

    pollErrCount = 0;
    pollBackoff = 0;

    for (const update of data.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const username = msg.from?.username || msg.from?.first_name || "user";

      console.log(`[${new Date().toISOString()}] @${username} (${chatId}): ${text}`);

      if (text === "/start") {
        await sendMessage(chatId,
          `✅ *Solis* online!\n\nModel: \`${MODEL}\`\nTools: shell, file, obsidian vault, http\nStreaming: live tool feed enabled\nHistory: last ${HISTORY_MAX_MSGS} messages\n\n/reset — clear history\n/memory — show vault notes\n/model — show current model`,
        );
        continue;
      }

      if (text === "/reset") {
        histories.delete(chatId);
        const f = sessionFile(chatId);
        if (existsSync(f)) writeFileSync(f, "[]", "utf8");
        pushSession(chatId, "[]").catch(() => {});
        await sendMessage(chatId, "🗑️ Session cleared.");
        continue;
      }

      if (text === "/memory") {
        const result = await execTool("obsidian_list", {});
        const list = result.entries?.join("\n") || "(empty)";
        await sendMessage(chatId, `📒 *Vault:*\n\`\`\`\n${list}\n\`\`\``);
        continue;
      }

      if (text === "/model") {
        await sendMessage(chatId, `🤖 Model: \`${MODEL}\`\nMax tool rounds: ${MAX_TOOL_ROUNDS}\nHistory: ${HISTORY_MAX_MSGS} msgs`);
        continue;
      }

      const stopTyping = startTyping(chatId);
      try {
        const reply = await runAgent(chatId, text);
        stopTyping();
        await sendMessage(chatId, reply);
        console.log(`  ✓ Replied to @${username}`);
      } catch (err) {
        stopTyping();
        console.error(`  ✗ Agent error: ${err.message}`);
        let userMsg;
        if (err.code === "RATE_LIMITED" || /rate_limited/i.test(err.message)) {
          userMsg = "⏳ Rate limited — wait a minute and retry.";
        } else if (/ETIMEDOUT|timed out|ECONNRESET/i.test(err.message)) {
          userMsg = "⏱ NIM timed out. Try a shorter request.";
        } else {
          userMsg = `❌ ${err.message}`;
        }
        await sendMessage(chatId, userMsg).catch(() => {});
      }
    }
  } catch (err) {
    pollErrCount++;
    pollBackoff = Math.min(30000, 2000 * Math.pow(2, pollErrCount - 1));
    console.error(`Poll error (${pollErrCount}): ${err.message} — retry in ${pollBackoff / 1000}s`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SESSIONS_PATH, { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Skills"), { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Daily"), { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Facts"), { recursive: true });

  console.log("🤖 Solis (TermuxClawAgent) starting…");
  console.log(`   GitHub sync: ${process.env.GITHUB_TOKEN ? "enabled (" + (process.env.GITHUB_STORAGE_REPO ?? "Everaldtah/termuxclawagent-files") + ")" : "disabled (set GITHUB_TOKEN to enable)"}`);

  // Two-way vault sync on startup
  if (process.env.GITHUB_TOKEN) {
    console.log("  🔄 Syncing vault with GitHub…");
    syncVault(VAULT_PATH).catch(err => console.warn(`  ⚠ Vault sync: ${err.message}`));
  }
  console.log(`   Model    : ${MODEL}`);
  console.log(`   Vault    : ${VAULT_PATH}`);
  console.log(`   Sessions : ${SESSIONS_PATH}`);
  console.log(`   Max rounds: ${MAX_TOOL_ROUNDS}`);
  console.log(`   History  : ${HISTORY_MAX_MSGS} msgs`);

  let me;
  for (let i = 0; ; i++) {
    try {
      me = await httpsGet(`${TG_BASE}/getMe`);
      if (me?.ok) break;
    } catch {}
    const wait = Math.min(30000, 3000 * Math.pow(2, i));
    console.log(`   Telegram not reachable — retry in ${wait / 1000}s`);
    await sleep(wait);
  }
  console.log(`   Bot      : @${me.result.username}`);
  console.log("\n✅ Listening…\n");

  while (true) {
    await poll();
    if (pollBackoff > 0) await sleep(pollBackoff);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
