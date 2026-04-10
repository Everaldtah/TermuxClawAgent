/**
 * Orchestration Tools - OpenClaw-inspired agent orchestration for TermuxAgent
 * Native Termux: plan tracking, cron scheduling, sub-agent spawning, web tools
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "./registry.js";

const execFileAsync = promisify(execFile);
const DATA_DIR = join(homedir(), ".termux-agent");

// ─── Plan Tool ────────────────────────────────────────────────────────────────

const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
type PlanStatus = (typeof PLAN_STATUSES)[number];
interface PlanStep { step: string; status: PlanStatus; }

let activePlan: PlanStep[] = [];

export function getUpdatePlanTool(): ToolDefinition {
  return {
    name: "update_plan",
    description: `Maintain a structured plan for multi-step tasks. Call this at the start of complex tasks and update step statuses as you progress. At most one step may be "in_progress" at a time.`,
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Optional note about what changed." },
        plan: {
          type: "array",
          description: "Ordered list of plan steps.",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "Short description of the step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Step status." },
            },
            required: ["step", "status"],
          },
          minItems: 1,
        },
      },
      required: ["plan"],
    },
    enabled: true,
    handler: async (args: { explanation?: string; plan: PlanStep[] }) => {
      const inProgress = args.plan.filter(s => s.status === "in_progress");
      if (inProgress.length > 1) throw new Error("At most one step may be in_progress");
      for (const s of args.plan) {
        if (!PLAN_STATUSES.includes(s.status)) throw new Error(`Invalid status: ${s.status}`);
      }
      activePlan = args.plan;
      const lines = args.plan.map(s => {
        const icon = s.status === "completed" ? "✅" : s.status === "in_progress" ? "⏳" : "⬜";
        return `${icon} ${s.step}`;
      });
      return { updated: true, plan: lines.join("\n"), note: args.explanation ?? "" };
    },
  };
}

export function getShowPlanTool(): ToolDefinition {
  return {
    name: "show_plan",
    description: "Show the current active plan and step statuses.",
    parameters: { type: "object", properties: {} },
    enabled: true,
    handler: async () => {
      if (activePlan.length === 0) return { plan: "No active plan." };
      const lines = activePlan.map(s => {
        const icon = s.status === "completed" ? "✅" : s.status === "in_progress" ? "⏳" : "⬜";
        return `${icon} ${s.step}`;
      });
      return { plan: lines.join("\n") };
    },
  };
}

// ─── Task Management ──────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  created: number;
  updated: number;
  result?: string;
}

const TASKS_PATH = join(DATA_DIR, "tasks.json");

async function loadTasks(): Promise<Task[]> {
  try { return JSON.parse(await readFile(TASKS_PATH, "utf8")); } catch { return []; }
}
async function saveTasks(tasks: Task[]): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

export function getTaskTools(): ToolDefinition[] {
  return [
    {
      name: "task_create",
      description: "Create a new tracked task. Returns the task ID.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title." },
          description: { type: "string", description: "Optional task details." },
        },
        required: ["title"],
      },
      enabled: true,
      handler: async (args: { title: string; description?: string }) => {
        const tasks = await loadTasks();
        const task: Task = {
          id: `task-${Date.now()}`,
          title: args.title,
          description: args.description,
          status: "pending",
          created: Date.now(),
          updated: Date.now(),
        };
        tasks.push(task);
        await saveTasks(tasks);
        return { id: task.id, title: task.title, status: task.status };
      },
    },
    {
      name: "task_update",
      description: "Update a task's status or result.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID." },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
          result: { type: "string", description: "Optional result or notes." },
        },
        required: ["id"],
      },
      enabled: true,
      handler: async (args: { id: string; status?: Task["status"]; result?: string }) => {
        const tasks = await loadTasks();
        const task = tasks.find(t => t.id === args.id);
        if (!task) throw new Error(`Task not found: ${args.id}`);
        if (args.status) task.status = args.status;
        if (args.result !== undefined) task.result = args.result;
        task.updated = Date.now();
        await saveTasks(tasks);
        return { id: task.id, status: task.status };
      },
    },
    {
      name: "task_list",
      description: "List all tasks, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "all"] },
        },
      },
      enabled: true,
      handler: async (args: { status?: string }) => {
        const tasks = await loadTasks();
        const filtered = (!args.status || args.status === "all")
          ? tasks
          : tasks.filter(t => t.status === args.status);
        return filtered.map(t => ({ id: t.id, title: t.title, status: t.status, updated: new Date(t.updated).toISOString() }));
      },
    },
  ];
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────────

interface CronJob {
  id: string;
  name: string;
  schedule: string;  // cron expression or "every Xm/Xh/Xd"
  message: string;   // message to inject into agent
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

const CRON_PATH = join(DATA_DIR, "cron.json");
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

async function loadCron(): Promise<CronJob[]> {
  try { return JSON.parse(await readFile(CRON_PATH, "utf8")); } catch { return []; }
}
async function saveCron(jobs: CronJob[]): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CRON_PATH, JSON.stringify(jobs, null, 2));
}

function parseIntervalMs(schedule: string): number | null {
  const m = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "m" ? n * 60000 : unit === "h" ? n * 3600000 : n * 86400000;
}

export function getCronTools(onTrigger?: (job: CronJob) => void): ToolDefinition[] {
  return [
    {
      name: "cron_add",
      description: `Schedule a recurring agent task. Schedule format: "every 30m", "every 2h", "every 1d". The message will be auto-injected into the agent on each trigger.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Job name." },
          schedule: { type: "string", description: 'Schedule, e.g. "every 30m" or "every 2h".' },
          message: { type: "string", description: "Message to send to the agent on each trigger." },
        },
        required: ["name", "schedule", "message"],
      },
      enabled: true,
      handler: async (args: { name: string; schedule: string; message: string }) => {
        const ms = parseIntervalMs(args.schedule);
        if (!ms) throw new Error('Schedule must be like "every 30m", "every 2h", "every 1d"');
        const jobs = await loadCron();
        const job: CronJob = {
          id: `cron-${Date.now()}`,
          name: args.name,
          schedule: args.schedule,
          message: args.message,
          enabled: true,
          nextRun: Date.now() + ms,
        };
        jobs.push(job);
        await saveCron(jobs);

        if (onTrigger) {
          const timer = setInterval(async () => {
            job.lastRun = Date.now();
            job.nextRun = Date.now() + ms;
            const all = await loadCron();
            const idx = all.findIndex(j => j.id === job.id);
            if (idx >= 0) { all[idx] = job; await saveCron(all); }
            onTrigger(job);
          }, ms);
          activeTimers.set(job.id, timer);
        }

        return { id: job.id, name: job.name, schedule: job.schedule, nextRun: new Date(job.nextRun!).toISOString() };
      },
    },
    {
      name: "cron_list",
      description: "List all scheduled cron jobs.",
      parameters: { type: "object", properties: {} },
      enabled: true,
      handler: async () => {
        const jobs = await loadCron();
        return jobs.map(j => ({
          id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled,
          lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
          nextRun: j.nextRun ? new Date(j.nextRun).toISOString() : null,
        }));
      },
    },
    {
      name: "cron_remove",
      description: "Remove a scheduled cron job by ID.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID." } },
        required: ["id"],
      },
      enabled: true,
      handler: async (args: { id: string }) => {
        const jobs = await loadCron();
        const idx = jobs.findIndex(j => j.id === args.id);
        if (idx < 0) throw new Error(`Job not found: ${args.id}`);
        jobs.splice(idx, 1);
        await saveCron(jobs);
        if (activeTimers.has(args.id)) {
          clearInterval(activeTimers.get(args.id)!);
          activeTimers.delete(args.id);
        }
        return { removed: args.id };
      },
    },
  ];
}

// ─── Web Fetch (OpenClaw-style with readable extraction) ──────────────────────

const MAX_FETCH_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

function extractTextFromHtml(html: string): string {
  // Strip scripts, styles, tags; decode entities
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/gi, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `${"#".repeat(+l)} ${extractTextFromHtml(t)}\n\n`)
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => `[${extractTextFromHtml(t)}](${u})`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${extractTextFromHtml(t)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `_${extractTextFromHtml(t)}_`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t}\``)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\`\`\`\n${extractTextFromHtml(t)}\n\`\`\`\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${extractTextFromHtml(t)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `${extractTextFromHtml(t)}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function getWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description: "Fetch a URL and extract readable content as markdown or plain text. Strips scripts/ads/nav for clean output.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP/HTTPS URL to fetch." },
        extract_mode: { type: "string", enum: ["markdown", "text"], description: 'Content extraction mode (default: "markdown").' },
        max_chars: { type: "number", description: `Max characters to return (default: ${MAX_FETCH_CHARS}).` },
      },
      required: ["url"],
    },
    enabled: true,
    handler: async (args: { url: string; extract_mode?: "markdown" | "text"; max_chars?: number }) => {
      const mode = args.extract_mode ?? "markdown";
      const maxChars = args.max_chars ?? MAX_FETCH_CHARS;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(args.url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Safari/537.36" },
        });
        clearTimeout(timer);
        const html = await res.text();
        const content = mode === "markdown" ? htmlToMarkdown(html) : extractTextFromHtml(html);
        const truncated = content.length > maxChars;
        return {
          url: args.url,
          status: res.status,
          mode,
          content: content.slice(0, maxChars),
          truncated,
          chars: Math.min(content.length, maxChars),
        };
      } catch (err: any) {
        clearTimeout(timer);
        throw new Error(`Fetch failed: ${err.message}`);
      }
    },
  };
}

// ─── Web Search (DuckDuckGo Instant Answer — no API key needed) ───────────────

export function getWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets. No API key required.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: { type: "number", description: "Max results to return (default: 5)." },
      },
      required: ["query"],
    },
    enabled: true,
    handler: async (args: { query: string; max_results?: number }) => {
      const maxResults = args.max_results ?? 5;
      const encoded = encodeURIComponent(args.query);

      // DuckDuckGo Instant Answer API (JSON, no key)
      const ddgUrl = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(ddgUrl, { signal: controller.signal, headers: { "User-Agent": "TermuxAgent/1.0" } });
        clearTimeout(timer);
        const data: any = await res.json();

        const results: { title: string; url: string; snippet: string }[] = [];

        // Abstract (top answer)
        if (data.AbstractText) {
          results.push({ title: data.Heading ?? "Answer", url: data.AbstractURL ?? "", snippet: data.AbstractText });
        }

        // Related topics
        for (const topic of (data.RelatedTopics ?? [])) {
          if (results.length >= maxResults) break;
          if (topic.Text && topic.FirstURL) {
            results.push({ title: topic.Text.split(" - ")[0] ?? "", url: topic.FirstURL, snippet: topic.Text });
          } else if (topic.Topics) {
            for (const sub of topic.Topics) {
              if (results.length >= maxResults) break;
              if (sub.Text && sub.FirstURL) {
                results.push({ title: sub.Text.split(" - ")[0] ?? "", url: sub.FirstURL, snippet: sub.Text });
              }
            }
          }
        }

        if (results.length === 0 && data.Answer) {
          results.push({ title: "Direct Answer", url: "", snippet: data.Answer });
        }

        return { query: args.query, results: results.slice(0, maxResults), source: "duckduckgo" };
      } catch (err: any) {
        clearTimeout(timer);
        throw new Error(`Search failed: ${err.message}`);
      }
    },
  };
}

// ─── Sub-agent Spawner ────────────────────────────────────────────────────────

export function getSpawnAgentTool(): ToolDefinition {
  return {
    name: "spawn_agent",
    description: "Spawn a sub-agent process to handle a task independently. The sub-agent runs the same termux-agent CLI with a given message and returns its response. Useful for parallelising work or delegating sub-tasks.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Task message for the sub-agent." },
        model: { type: "string", description: "Model override for the sub-agent (default: same as parent)." },
        provider: { type: "string", description: "Provider override (default: same as parent)." },
        timeout_seconds: { type: "number", description: "Max time to wait for sub-agent (default: 120)." },
      },
      required: ["message"],
    },
    enabled: true,
    handler: async (args: { message: string; model?: string; provider?: string; timeout_seconds?: number }) => {
      const timeout = (args.timeout_seconds ?? 120) * 1000;
      const cliArgs = ["ask", args.message];
      if (args.model) cliArgs.push("--model", args.model);
      if (args.provider) cliArgs.push("--provider", args.provider);
      cliArgs.push("--no-stream");

      // Find agent entry point
      const agentPath = join(homedir(), "TermuxClawAgent", "termux-agent.mjs");
      const nodeArgs = [agentPath, ...cliArgs];

      try {
        const { stdout, stderr } = await execFileAsync("node", nodeArgs, {
          timeout,
          encoding: "utf8",
          env: process.env,
        });
        return { response: stdout.trim(), stderr: stderr.trim() || undefined };
      } catch (err: any) {
        throw new Error(`Sub-agent failed: ${err.message}`);
      }
    },
  };
}

// ─── Memory Tools (Obsidian RAG vault) ───────────────────────────────────────

import { ObsidianMemory } from "../memory/obsidian-memory.js";

const VAULT_KINDS = ["fact", "episode", "skill", "note", "research", "project", "user", "system"] as const;

export function getMemoryTools(vaultPath?: string): ToolDefinition[] {
  const vault = vaultPath ?? join(homedir(), ".termux-agent", "vault");
  const mem = new ObsidianMemory(vault);

  return [
    {
      name: "memory_store",
      description: `Store information into the persistent Obsidian RAG vault.
Vault: ${vault}/RAG-Memory/
Folder mapping:
  fact      → Knowledge/    (facts, user info, permanent knowledge)
  episode   → Sessions/     (conversation summaries, events)
  skill     → Skills/       (how to do things, procedures)
  note      → Logs/         (actions taken, events logged)
  research  → Research/     (analysis, findings, summaries)
  project   → Projects/     (ongoing project state)
  user      → UserProfile/  (facts about the user)
  system    → System/       (agent config, rules)
After storing important memories, call vault_sync to persist to GitHub.`,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Memory title (becomes the filename)." },
          content: { type: "string", description: "Memory content in markdown." },
          kind: {
            type: "string",
            enum: VAULT_KINDS,
            description: "Memory category. Use 'fact' for knowledge, 'user' for user info, 'episode' for session summaries, 'skill' for procedures.",
          },
        },
        required: ["title", "content"],
      },
      enabled: true,
      handler: async (args: { title: string; content: string; kind?: any }) => {
        const path = await mem.store(args.title, args.content, args.kind ?? "note");
        return { stored: true, title: args.title, kind: args.kind ?? "note", path };
      },
    },
    {
      name: "memory_append",
      description: "Append new content to an existing memory note (creates it if missing).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          kind: { type: "string", enum: VAULT_KINDS },
        },
        required: ["title", "content"],
      },
      enabled: true,
      handler: async (args: { title: string; content: string; kind?: any }) => {
        await mem.append(args.title, args.content, args.kind ?? "note");
        return { appended: true, title: args.title };
      },
    },
    {
      name: "memory_recall",
      description: `Search the Obsidian RAG vault for relevant memories. Searches across all folders (Knowledge, Sessions, Skills, Logs, Research, Projects, UserProfile, System). Use this at the start of conversations to recall context about the user and prior work.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — keywords or phrases." },
          top_k: { type: "number", description: "Max results to return (default: 6)." },
        },
        required: ["query"],
      },
      enabled: true,
      handler: async (args: { query: string; top_k?: number }) => {
        const hits = await mem.recall(args.query, args.top_k ?? 6);
        return { results: hits, count: hits.length };
      },
    },
    {
      name: "memory_read",
      description: "Read the full content of a specific memory note by title and kind.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: VAULT_KINDS },
        },
        required: ["title", "kind"],
      },
      enabled: true,
      handler: async (args: { title: string; kind: any }) => {
        const content = await mem.read(args.title, args.kind);
        if (!content) return { found: false };
        return { found: true, content };
      },
    },
    {
      name: "memory_list",
      description: "List all stored memories in the vault, optionally filtered by kind.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: VAULT_KINDS, description: "Filter by memory kind (omit for all)." },
        },
      },
      enabled: true,
      handler: async (args: { kind?: any }) => {
        const files = await mem.list(args.kind);
        return { files, count: files.length };
      },
    },
    {
      name: "vault_sync",
      description: `Sync the Obsidian vault to GitHub using ~/vault-sync.sh. Run this after storing important memories to persist them across sessions and devices. Script: ~/vault-sync.sh`,
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional commit message (default: auto-generated timestamp)." },
        },
      },
      enabled: true,
      handler: async (args: { message?: string }) => {
        const syncScript = join(homedir(), "vault-sync.sh");
        if (!existsSync(syncScript)) {
          return { synced: false, error: `Sync script not found at ${syncScript}. Run the vault setup first.` };
        }
        try {
          const { stdout, stderr } = await execFileAsync("bash", [syncScript], {
            encoding: "utf8",
            timeout: 60_000,
            env: { ...process.env, COMMIT_MSG: args.message ?? "" },
          });
          return { synced: true, output: stdout.trim(), stderr: stderr.trim() || undefined };
        } catch (err: any) {
          return { synced: false, error: (err as Error).message, output: err.stdout ?? "" };
        }
      },
    },
  ];
}

// ─── Collect all orchestration tools ──────────────────────────────────────────

export function getOrchestrationTools(opts?: {
  vaultPath?: string;
  onCronTrigger?: (job: CronJob) => void;
}): ToolDefinition[] {
  return [
    getUpdatePlanTool(),
    getShowPlanTool(),
    ...getTaskTools(),
    ...getCronTools(opts?.onCronTrigger),
    getWebFetchTool(),
    getWebSearchTool(),
    getSpawnAgentTool(),
    ...getMemoryTools(opts?.vaultPath),
  ];
}
