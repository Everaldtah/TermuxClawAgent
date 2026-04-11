#!/usr/bin/env node
/**
 * Telegram ↔ TermuxClawAgent Bridge
 * - Real OpenAI-style function/tool calling (executed on-device)
 * - Persistent session memory (saved to disk between restarts)
 * - Continuous typing indicator while thinking
 */

import https from "node:https";
import { execSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

// Keep-alive agent: prevents Android from killing long-lived NIM connections
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

const TELEGRAM_TOKEN = "8661280273:AAFsi3Sf5FIpyofrExkN1j-vj1hoxmJvBlo";
const NVIDIA_API_KEY = "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";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = "moonshotai/kimi-k2.5";
const NVIDIA_TIMEOUT_MS = 300_000; // 5 min — Kimi-K2.5 thinking mode can be slow
const MAX_TOOL_ROUNDS = 8;        // prevent infinite loops
const VAULT_PATH = "/storage/emulated/0/Documents/SoligAgentMemory";
const SESSIONS_PATH = join(homedir(), ".termux-agent", "sessions");

const TG_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Solis, an advanced AI agent running on Android via Termux. You are powered by Moonshot Kimi K2.5 via NVIDIA NIM.

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
          timeout_ms: { type: "integer", description: "Timeout in ms (default 30000)" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (supports ~ for home)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file (creates or overwrites).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: home)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obsidian_read",
      description: "Read a note from the Obsidian memory vault.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "Path relative to vault root, e.g. Memory/Facts/user.md" }
        },
        required: ["note_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obsidian_write",
      description: "Write (create or overwrite) a note in the vault.",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "Path relative to vault root" },
          content: { type: "string", description: "Markdown content" }
        },
        required: ["note_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obsidian_append",
      description: "Append content to an existing vault note (creates if missing).",
      parameters: {
        type: "object",
        properties: {
          note_path: { type: "string", description: "Path relative to vault root" },
          content: { type: "string", description: "Content to append" }
        },
        required: ["note_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obsidian_list",
      description: "List notes and folders in the vault.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Sub-path within vault (default: root)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obsidian_search",
      description: "Full-text search across all vault notes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term or phrase" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "Make an HTTP GET request and return the response body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "vault_sync",
      description: "Manually commit and push all pending vault changes to GitHub. Called automatically after obsidian_write/append, but can be triggered explicitly to force an immediate sync.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

// ── Vault → GitHub auto-sync ──────────────────────────────────────────────────

let _syncTimer = null;
const _pendingFiles = new Set();

function vaultSync(notePath) {
  // Collect files written in the same agent round, push once after 3s quiet period
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
        // Only commit if there's actually something staged
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
              stdout: stdout?.slice(0, 3000) || "",
              stderr: stderr?.slice(0, 1000) || "",
              exit_code: err?.code ?? 0
            });
          });
        });
      }

      case "file_read": {
        const p = expandPath(args.path);
        if (!existsSync(p)) return { error: `File not found: ${p}` };
        const content = readFileSync(p, "utf8");
        return { content: content.slice(0, 8000) };
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
          const isDir = statSync(full).isDirectory();
          return isDir ? name + "/" : name;
        });
        return { path: p, entries };
      }

      case "obsidian_read": {
        const p = join(VAULT_PATH, args.note_path);
        if (!existsSync(p)) return { error: `Note not found: ${args.note_path}` };
        const content = readFileSync(p, "utf8");
        return { content: content.slice(0, 8000) };
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
            r.on("end", () => res({ status: r.statusCode, body: body.slice(0, 5000) }));
          }).on("error", e => res({ error: e.message }));
        });
      }

      case "vault_sync": {
        const result = await vaultSync();
        return result;
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

function loadSession(chatId) {
  const f = sessionFile(chatId);
  if (existsSync(f)) {
    try {
      const data = JSON.parse(readFileSync(f, "utf8"));
      console.log(`  📂 Loaded ${data.length} messages for chat ${chatId}`);
      return data;
    } catch { return []; }
  }
  return [];
}

function saveSession(chatId, messages) {
  // Keep last 60 messages on disk (skip system messages)
  const toSave = messages.filter(m => m.role !== "system").slice(-60);
  writeFileSync(sessionFile(chatId), JSON.stringify(toSave, null, 2), "utf8");
}

// In-memory cache of histories
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) {
    histories.set(chatId, loadSession(chatId));
  }
  return histories.get(chatId);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsPost(url, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    // Use a wall-clock timer (not just socket idle) to guarantee the request
    // ends. On Android the OS-level TCP timeout can fire as ETIMEDOUT before
    // Node's socket timeout event — the wall-clock timer catches that too.
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
      // Socket idle timeout matches the wall-clock budget. Removed the 60s cap
      // that was causing ETIMEDOUT before the retry logic could fire on Android.
      timeout: timeoutMs,
      agent: keepAliveAgent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers
      }
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
        // Treat HTTP errors as rejections so the retry layer can handle them
        if (statusCode === 429) {
          const retryAfter = res.headers["retry-after"];
          const err = new Error(`rate_limited${retryAfter ? `:${retryAfter}` : ""}`);
          err.code = "RATE_LIMITED";
          err.retryAfter = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
          return reject(err);
        }
        if (statusCode >= 500) {
          return reject(new Error(`NIM server error ${statusCode}: ${typeof parsed === "string" ? parsed.slice(0,200) : JSON.stringify(parsed).slice(0,200)}`));
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
    req.on("timeout", () => {
      req.destroy(new Error("Socket idle timeout"));
    });
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

// Retryable error codes from Android TCP layer
const RETRYABLE = new Set(["ETIMEDOUT","ECONNRESET","ECONNREFUSED","ENOTFOUND","EAI_AGAIN","EPIPE","RATE_LIMITED"]);
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
      // Honour Retry-After for 429, else exponential back-off (2s, 4s, 8s)
      const delay = err.retryAfter ?? (2000 * Math.pow(2, attempt));
      console.warn(`  ⚠ NIM error (${err.message}), retry ${attempt + 1}/${maxRetries} in ${delay/1000}s…`);
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
      chat_id: chatId, text: chunk, parse_mode: "Markdown"
    }).catch(() => null);
    if (!res?.ok) {
      res = await httpsPost(`${TG_BASE}/sendMessage`, { chat_id: chatId, text: chunk }).catch(() => null);
    }
    if (!res?.ok) console.error("sendMessage failed:", res?.description);
  }
}

async function sendStatusMessage(chatId, text) {
  const res = await httpsPost(`${TG_BASE}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "Markdown"
  }).catch(() => null);
  return res?.result?.message_id ?? null;
}

async function editStatusMessage(chatId, messageId, text) {
  if (!messageId) return;
  await httpsPost(`${TG_BASE}/editMessageText`, {
    chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown"
  }).catch(() => {});
}

async function deleteMessage(chatId, messageId) {
  if (!messageId) return;
  await httpsPost(`${TG_BASE}/deleteMessage`, {
    chat_id: chatId, message_id: messageId
  }).catch(() => {});
}

function startTyping(chatId) {
  const send = () => httpsPost(`${TG_BASE}/sendChatAction`,
    { chat_id: chatId, action: "typing" }).catch(() => {});
  send();
  const iv = setInterval(send, 4000);
  return () => clearInterval(iv);
}

// ── NVIDIA NIM agentic loop ───────────────────────────────────────────────────

// ── Live stream helper ────────────────────────────────────────────────────────
// Keeps one Telegram message updated with a scrolling log of tool activity.
// Throttled to 1 edit/s to stay under Telegram rate limits.

function makeStreamer(chatId) {
  let msgId = null;
  let lines = [];
  let lastEdit = 0;
  let pending = false;

  const render = () => {
    const body = lines.slice(-18).join("\n");   // show last 18 lines
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
      await editStatusMessage(chatId, msgId, render());
    } else {
      const r = await httpsPost(`${TG_BASE}/sendMessage`, {
        chat_id: chatId, text: render(), parse_mode: "Markdown"
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
  const history = getHistory(chatId);
  history.push({ role: "user", content: userText });

  const getMessages = () => [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-40)
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
    await stream.push(`▶ [R${round}] calling model...`);

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
        chat_template_kwargs: { thinking: true }
      },
      { Authorization: `Bearer ${NVIDIA_API_KEY}` },
      NVIDIA_TIMEOUT_MS,
      3
    );

    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    const choice = res?.choices?.[0];
    if (!choice) throw new Error("Empty response from NVIDIA NIM");

    const msg = choice.message;
    const toolCalls = msg?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msg?.content || msg?.reasoning_content || msg?.reasoning || "";
      if (!finalContent) {
        await stream.push(`⚠ empty reply — requesting summary`);
        history.push({ role: "assistant", content: "" });
        history.push({ role: "user", content: "Please summarize what you just did and provide your response." });
        const sr = await httpsPostWithRetry(
          `${NVIDIA_BASE_URL}/chat/completions`,
          { model: MODEL, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-40)], max_tokens: 4096, temperature: 1.0, top_p: 1.0, stream: false },
          { Authorization: `Bearer ${NVIDIA_API_KEY}` },
          NVIDIA_TIMEOUT_MS, 2
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

      // Show what's being called with key argument
      const keyArg = fnArgs.command || fnArgs.path || fnArgs.note_path || fnArgs.url || fnArgs.query || "";
      await stream.push(`🔧 ${fnName}${keyArg ? `(${keyArg.slice(0, 50)})` : ""}`);

      const result = await execTool(fnName, fnArgs);
      const resultStr = JSON.stringify(result);
      console.log(`  ← Tool result: ${resultStr.slice(0, 200)}`);

      // Show meaningful output: prefer stdout for shell, content for files
      const out = result.stdout ?? result.content ?? result.error ?? resultStr;
      const outClean = String(out).replace(/\n+/g, " ").trim();
      await stream.push(`   ↳ ${outClean.slice(0, 100)}${outClean.length > 100 ? "…" : ""}`);

      history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: resultStr });
    }

    if (round === MAX_TOOL_ROUNDS) {
      await stream.push(`⚠ round limit — forcing summary`);
      history.push({ role: "user", content: "You've reached the tool call limit. Please summarize everything you've done and provide your final answer now." });
      const fr = await httpsPostWithRetry(
        `${NVIDIA_BASE_URL}/chat/completions`,
        { model: MODEL, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-40)], max_tokens: 8192, temperature: 1.0, top_p: 1.0, stream: false },
        { Authorization: `Bearer ${NVIDIA_API_KEY}` },
        NVIDIA_TIMEOUT_MS, 2
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
  await stream.push(`✅ done`);
  await stream.finish();

  saveSession(chatId, history);
  return finalContent.trim();
}

// ── Main polling loop ─────────────────────────────────────────────────────────

let offset = 0;
let pollBackoff = 0;       // ms to wait between polls on network failure
let pollErrCount = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function poll() {
  try {
    const data = await httpsGet(`${TG_BASE}/getUpdates?timeout=20&offset=${offset}`, 25000);
    if (!data?.ok || !Array.isArray(data.result)) return;

    // Successful poll — reset backoff
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
          `✅ *Solis* online!\n\nModel: \`${MODEL}\`\nTools: shell, file, obsidian vault, http\nStreaming: live tool feed enabled\n\n/reset — clear history\n/memory — show vault notes`
        );
        continue;
      }

      if (text === "/reset") {
        histories.delete(chatId);
        const f = sessionFile(chatId);
        if (existsSync(f)) writeFileSync(f, "[]", "utf8");
        await sendMessage(chatId, "🗑️ Session cleared.");
        continue;
      }

      if (text === "/memory") {
        const result = await execTool("obsidian_list", {});
        const list = result.entries?.join("\n") || "(empty)";
        await sendMessage(chatId, `📒 *Vault:*\n\`\`\`\n${list}\n\`\`\``);
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
          userMsg = `⏳ Rate limited — wait a minute and retry.`;
        } else if (/ETIMEDOUT|timed out|ECONNRESET/i.test(err.message)) {
          userMsg = `⏱ NIM timed out. Try a shorter request.`;
        } else {
          userMsg = `❌ ${err.message}`;
        }
        await sendMessage(chatId, userMsg).catch(() => {});
      }
    }
  } catch (err) {
    pollErrCount++;
    // Exponential back-off: 2s → 4s → 8s → 16s → 30s cap
    pollBackoff = Math.min(30000, 2000 * Math.pow(2, pollErrCount - 1));
    console.error(`Poll error (${pollErrCount}): ${err.message} — retry in ${pollBackoff/1000}s`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SESSIONS_PATH, { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Skills"), { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Daily"), { recursive: true });
  mkdirSync(join(VAULT_PATH, "Memory", "Facts"), { recursive: true });

  console.log("🤖 Solis (TermuxClawAgent) starting...");
  console.log(`   Model    : ${MODEL}`);
  console.log(`   Vault    : ${VAULT_PATH}`);
  console.log(`   Sessions : ${SESSIONS_PATH}`);

  // Retry getMe until network is up (handles cold boot before WiFi connects)
  let me;
  for (let i = 0; ; i++) {
    try {
      me = await httpsGet(`${TG_BASE}/getMe`);
      if (me?.ok) break;
    } catch {}
    const wait = Math.min(30000, 3000 * Math.pow(2, i));
    console.log(`   Telegram not reachable — retry in ${wait/1000}s`);
    await sleep(wait);
  }
  console.log(`   Bot      : @${me.result.username}`);
  console.log("\n✅ Listening...\n");

  while (true) {
    await poll();
    if (pollBackoff > 0) await sleep(pollBackoff);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
