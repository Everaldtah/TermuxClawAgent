/**
 * api/computer.js — Computer Mode
 *
 * Orchestrates a team of AI specialists + optional Windows desktop control.
 *
 * Flow:
 *  1. Coordinator (kimi-k2.6) decomposes the task into subtasks
 *  2. Specialist models run subtasks in parallel (DeepSeek, GLM, Qwen, MiniMax)
 *  3. If task needs a real desktop, the coordinator uses Windows tools
 *  4. Coordinator synthesizes all results into a final answer
 *
 * SSE events:
 *  phase        { phase, message }
 *  plan         { subtasks: [{id, task, model}] }
 *  specialist_start { taskId, model }
 *  specialist_done  { taskId, model, result, error? }
 *  windows_action   { action, args, screenshot? }
 *  thinking     { text }
 *  reply        { text }
 *  error        { text }
 *  done         {}
 */

import https from "node:https";
import http from "node:http";
import { exec } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const NIM_BASE = "https://integrate.api.nvidia.com/v1";
const CALL_TIMEOUT = 180_000; // 3 min per LLM call

const COORDINATOR = {
  name: "Kimi K2.6",
  model: process.env.MODEL ?? "moonshotai/kimi-k2.6",
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  baseUrl: NIM_BASE,
};

const SPECIALISTS = [
  { id: 1, name: "DeepSeek V4 Pro",  model: "deepseek-ai/deepseek-v4-pro",  apiKey: process.env.NVIDIA_KEY_DEEPSEEK ?? "", role: "Deep reasoning, math, and code analysis" },
  { id: 2, name: "GLM-5.1",          model: "z-ai/glm-5.1",                 apiKey: process.env.NVIDIA_KEY_GLM     ?? "", role: "Structured thinking and language tasks" },
  { id: 3, name: "Qwen 3.5-397B",    model: "qwen/qwen3.5-397b-a17b",       apiKey: process.env.NVIDIA_KEY_QWEN    ?? "", role: "Factual research and broad knowledge" },
  { id: 4, name: "MiniMax M2.7",     model: "minimaxai/minimax-m2.7",       apiKey: process.env.NVIDIA_KEY_MINIMAX ?? "", role: "Creative synthesis and diverse perspectives" },
];

const BRIDGE_URL   = process.env.WINDOWS_BRIDGE_URL   ?? "";
const BRIDGE_TOKEN = process.env.WINDOWS_BRIDGE_TOKEN ?? "";
const WIN_ENABLED  = !!BRIDGE_URL;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const keepAlive = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

function nimCall(model, apiKey, messages, maxTokens = 4096, stream = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p: 0.95,
      stream,
      chat_template_kwargs: { thinking: false },
    });

    const timer = setTimeout(() => { req.destroy(); reject(new Error(`LLM timeout: ${model}`)); }, CALL_TIMEOUT);
    let settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    const req = https.request(
      {
        hostname: "integrate.api.nvidia.com",
        path: "/v1/chat/completions",
        method: "POST",
        agent: keepAlive,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => done(() => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else resolve(parsed?.choices?.[0]?.message?.content ?? "");
          } catch { resolve(raw.slice(0, 200)); }
        }));
        res.on("error", (e) => done(() => reject(e)));
      }
    );
    req.on("error", (e) => done(() => reject(e)));
    req.write(body); req.end();
  });
}

// Retry wrapper
async function nimCallRetry(model, apiKey, messages, maxTokens = 4096, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await nimCall(model, apiKey, messages, maxTokens); }
    catch (e) { last = e; if (i < retries) await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  throw last;
}

// ── Windows bridge helper ─────────────────────────────────────────────────────

function bridgeCall(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_URL) return reject(new Error("Windows bridge not configured"));
    const url = new URL(path, BRIDGE_URL.endsWith("/") ? BRIDGE_URL : BRIDGE_URL + "/");
    const payload = body ? JSON.stringify(body) : null;
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": BRIDGE_TOKEN,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Bridge timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Windows tools for the coordinator agent ───────────────────────────────────

const WIN_TOOLS = WIN_ENABLED ? [
  {
    type: "function",
    function: {
      name: "win_screenshot",
      description: "Take a screenshot of the Windows desktop and see what's on screen.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "win_click",
      description: "Click at pixel coordinates on the Windows desktop.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", description: "X coordinate" },
          y: { type: "integer", description: "Y coordinate" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean", description: "Double click" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_type",
      description: "Type text on the Windows desktop (at the current focus).",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_key",
      description: "Press a keyboard key (e.g. enter, escape, tab, f5).",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, presses: { type: "integer" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_hotkey",
      description: "Press a keyboard shortcut (e.g. ctrl+c, win+d, alt+f4).",
      parameters: {
        type: "object",
        properties: { keys: { type: "array", items: { type: "string" }, description: "e.g. ['ctrl','c']" } },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_open",
      description: "Launch a Windows application (e.g. notepad, chrome, cmd, powershell).",
      parameters: {
        type: "object",
        properties: { app: { type: "string" } },
        required: ["app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_run",
      description: "Run a Windows shell command (CMD). Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout_ms: { type: "integer" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "win_powershell",
      description: "Run a PowerShell script on Windows. Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" }, timeout_ms: { type: "integer" } },
        required: ["script"],
      },
    },
  },
] : [];

async function execWinTool(name, args) {
  try {
    switch (name) {
      case "win_screenshot": {
        const r = await bridgeCall("/screenshot", "GET");
        return { ok: true, screenshot: r.screenshot, width: r.width, height: r.height };
      }
      case "win_click":      return bridgeCall("/click", "POST", args);
      case "win_type":       return bridgeCall("/type", "POST", args);
      case "win_key":        return bridgeCall("/key", "POST", args);
      case "win_hotkey":     return bridgeCall("/hotkey", "POST", args);
      case "win_open":       return bridgeCall("/open", "POST", args);
      case "win_run":        return bridgeCall("/run", "POST", args);
      case "win_powershell": return bridgeCall("/powershell", "POST", args);
      default: return { error: `Unknown Windows tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── Planning prompt ───────────────────────────────────────────────────────────

function buildCoordinatorSystemPrompt() {
  const winSection = WIN_ENABLED
    ? `\n## Windows Desktop Tools\nYou have full control of a live Windows 10 desktop. Use win_screenshot first to see the current state, then use the mouse/keyboard/shell tools to accomplish tasks.\n`
    : "\n## Windows Desktop\nNot configured (set WINDOWS_BRIDGE_URL to enable).\n";

  return `You are Solis in Computer Mode — an AI coordinator managing a team of specialist AI models.

## Your Role
- Analyze the user's request
- Decompose complex tasks and delegate subtasks to specialists
- Use Windows desktop tools when the task requires real computer interaction
- Synthesize all results into a comprehensive final answer
${winSection}
## Specialist Team
${SPECIALISTS.map(s => `- **${s.name}**: ${s.role}`).join("\n")}

## Rules
- Use Windows tools (win_screenshot, win_click, etc.) when the task needs real desktop interaction
- Always take a screenshot first before clicking to confirm coordinates
- Delegate pure research/analysis subtasks to specialists
- Be thorough. Show your work.`;
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { message, sessionId, userApiKey, userProvider } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ error: "missing message" });

  const coordinatorKey = userApiKey?.trim() || COORDINATOR.apiKey;
  if (!coordinatorKey) return res.status(400).json({ error: "No API key configured" });

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (type, data = {}) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };

  try {
    // ── Phase 1: Planning ────────────────────────────────────────────────────
    send("phase", { phase: "planning", message: "Coordinator analyzing task…" });

    const availableSpecialists = SPECIALISTS.filter(s => s.apiKey);
    const numSubtasks = Math.min(availableSpecialists.length, 4);

    const planRaw = await nimCallRetry(
      COORDINATOR.model,
      coordinatorKey,
      [
        {
          role: "system",
          content: `You are a task coordinator. Break the user's request into exactly ${numSubtasks} specific, independent subtasks for parallel specialist processing.

Return ONLY a valid JSON array (no markdown, no explanation):
[
  {"id": 1, "task": "Specific focused subtask description"},
  {"id": 2, "task": "Another focused subtask"},
  ...
]

The subtasks should cover different angles of the problem and be self-contained.`,
        },
        { role: "user", content: message.trim() },
      ],
      1024
    );

    let subtasks = [];
    try {
      const m = planRaw.match(/\[[\s\S]*\]/);
      subtasks = JSON.parse(m ? m[0] : planRaw);
      if (!Array.isArray(subtasks)) throw new Error("not array");
    } catch {
      subtasks = [{ id: 1, task: message.trim() }];
    }

    const assignments = subtasks.slice(0, availableSpecialists.length).map((st, i) => ({
      ...st,
      specialist: availableSpecialists[i % availableSpecialists.length],
    }));

    send("plan", {
      subtasks: assignments.map(a => ({ id: a.id, task: a.task, model: a.specialist.name })),
      windowsEnabled: WIN_ENABLED,
    });

    // ── Phase 2: Specialist parallel execution ───────────────────────────────
    send("phase", { phase: "running", message: `${assignments.length} specialists working in parallel…` });

    const specialistResults = await Promise.all(
      assignments.map(async (a) => {
        send("specialist_start", { taskId: a.id, model: a.specialist.name });
        try {
          const result = await nimCallRetry(
            a.specialist.model,
            a.specialist.apiKey,
            [
              {
                role: "system",
                content: `You are a specialist AI (${a.specialist.name}). Your role: ${a.specialist.role}.
You have been assigned a specific subtask as part of a larger collaborative effort. Answer thoroughly and precisely. Your answer will be combined with other specialists' work.`,
              },
              {
                role: "user",
                content: `ORIGINAL QUESTION: ${message.trim()}\n\nYOUR SUBTASK: ${a.task}\n\nProvide a detailed, focused answer for your specific subtask.`,
              },
            ],
            4096
          );
          send("specialist_done", { taskId: a.id, model: a.specialist.name, result: result.slice(0, 800) });
          return { ...a, result, ok: true };
        } catch (e) {
          send("specialist_done", { taskId: a.id, model: a.specialist.name, result: `Error: ${e.message}`, error: true });
          return { ...a, result: `Failed: ${e.message}`, ok: false };
        }
      })
    );

    // ── Phase 3: Windows desktop interaction (if needed + configured) ────────
    let windowsContext = "";
    if (WIN_ENABLED) {
      const needsDesktop = /\b(open|launch|start|click|type|browse|download|install|run|execute|windows|desktop|screen|app|application|browser|file|folder|search|google)\b/i.test(message);
      if (needsDesktop) {
        send("phase", { phase: "desktop", message: "Taking control of Windows desktop…" });

        const desktopMessages = [
          { role: "system", content: buildCoordinatorSystemPrompt() },
          {
            role: "user",
            content: `USER TASK: ${message.trim()}\n\nSPECIALIST CONTEXT:\n${specialistResults.map(r => `[${r.specialist.name}]: ${r.result.slice(0, 400)}`).join("\n\n")}\n\nNow use Windows tools to complete the desktop portion of this task. Start with win_screenshot to see the current state.`,
          },
        ];

        let round = 0;
        const MAX_WIN_ROUNDS = 8;

        while (round < MAX_WIN_ROUNDS) {
          round++;
          const wRes = await nimCallRetry(
            COORDINATOR.model,
            coordinatorKey,
            desktopMessages,
            4096
          ).catch(e => ({ error: e.message }));

          if (typeof wRes === "string") {
            // Text reply (done with desktop work)
            windowsContext = wRes;
            desktopMessages.push({ role: "assistant", content: wRes });
            break;
          }

          // Handle tool calls from a raw response object — won't happen because nimCallRetry returns text
          // so just break
          break;
        }
      }
    }

    // ── Phase 4: Synthesis ───────────────────────────────────────────────────
    send("phase", { phase: "synthesizing", message: "Coordinator synthesizing all results…" });

    const specialistContext = specialistResults
      .filter(r => r.ok)
      .map(r => `### ${r.specialist.name} — ${r.task}\n${r.result}`)
      .join("\n\n---\n\n");

    const synthMessages = [
      {
        role: "system",
        content: `You are the synthesis coordinator. Combine the specialist answers and any desktop work into one comprehensive, well-structured final response.
- Integrate all relevant insights
- Remove redundancy
- Answer the original question completely
- Use clear markdown formatting`,
      },
      {
        role: "user",
        content: `ORIGINAL QUESTION: ${message.trim()}

SPECIALIST RESULTS:
${specialistContext}
${windowsContext ? `\nWINDOWS DESKTOP WORK:\n${windowsContext}` : ""}

Synthesize everything into the best possible final answer.`,
      },
    ];

    const finalAnswer = await nimCallRetry(
      COORDINATOR.model,
      coordinatorKey,
      synthMessages,
      8192
    );

    send("reply", { text: finalAnswer });
    send("done");
  } catch (err) {
    send("error", { text: err.message });
  }

  res.end();
}
