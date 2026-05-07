/**
 * AgentRuntime - Core runtime for TermuxAgent
 * Token-optimized execution environment with:
 *   - Full agentic tool loop (non-streaming and streaming)
 *   - Parallel tool execution within each round
 *   - Context summarization when conversations grow long
 *   - Obsidian RAG pre-injection before each user turn
 *   - Extended thinking budget support (Anthropic Claude 4.x)
 */

import { ConfigManager } from "./config/manager.js";
import { GatewayClient, CompletionRequest } from "./gateway/client.js";
import { MemoryStore } from "./memory/store.js";
import { ToolRegistry, ToolCall } from "./tools/registry.js";
import { Logger } from "./utils/logger.js";
import { TokenOptimizer } from "./utils/token-optimizer.js";
import { ObsidianMemory } from "./memory/obsidian-memory.js";

export interface RuntimeOptions {
  config: ConfigManager;
  gateway: GatewayClient;
  memory?: MemoryStore | null;
  tools?: ToolRegistry | null;
  obsidianMemory?: ObsidianMemory | null;
  model: string;
  systemPrompt?: string;
  /** Token budget for extended thinking (Anthropic Claude 3.5+ / 4.x). 0 = disabled. */
  thinkingBudget?: number;
  sessionId?: string;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  /** Required for Anthropic tool_result mapping. */
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface AgentContext {
  messages: Message[];
  model: string;
  temperature: number;
  maxTokens: number;
  tools?: any[];
}

const MAX_TOOL_ROUNDS = 20;

export class AgentRuntime {
  public config: ConfigManager;
  public gateway: GatewayClient;
  public memory: MemoryStore | null;
  public tools: ToolRegistry | null;
  public obsidianMemory: ObsidianMemory | null;
  public model: string;
  public sessionId: string;

  private logger: Logger;
  private systemPrompt: string;
  private context: AgentContext;
  private thinkingBudget: number;

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.gateway = options.gateway;
    this.memory = options.memory ?? null;
    this.tools = options.tools ?? null;
    this.obsidianMemory = options.obsidianMemory ?? null;
    this.model = options.model;
    this.sessionId = options.sessionId ?? `session-${Date.now()}`;
    this.thinkingBudget = options.thinkingBudget ?? (this.config.get<number>("model.thinkingBudget") ?? 0);
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.logger = new Logger("Runtime");

    this.context = {
      messages: [],
      model: this.model,
      temperature: this.config.get("model.temperature") ?? 0.7,
      maxTokens: this.config.get("model.maxTokens") ?? 32768,
    };

    this.initializeContext();
  }

  private getDefaultSystemPrompt(): string {
    return `You are Solis, a powerful AI agent running natively on Android via Termux.
You have persistent memory backed by an Obsidian vault and full orchestration capabilities.

═══════════════════════════════════════
OBSIDIAN RAG VAULT — PERSISTENT MEMORY
═══════════════════════════════════════
Vault: /storage/emulated/0/Documents/SoligAgentMemory
RAG base: /storage/emulated/0/Documents/SoligAgentMemory/RAG-Memory/

Folder structure and when to use each:
  Knowledge/    → facts, accumulated knowledge, permanent info   (kind: "fact")
  Sessions/     → conversation summaries, session transcripts     (kind: "episode")
  Skills/       → procedures, how-to guides, workflows            (kind: "skill")
  Logs/         → actions taken, events, system logs              (kind: "note")
  Research/     → analysis, findings, topic summaries             (kind: "research")
  Projects/     → ongoing project state and progress              (kind: "project")
  UserProfile/  → facts about the user (name, prefs, context)     (kind: "user")
  System/       → agent config, rules, protocols                  (kind: "system")

MEMORY WORKFLOW (always follow this):
1. At session start → call memory_recall with the user's topic to load prior context
2. When you learn something important → memory_store it in the right folder
3. At session end or after key facts → call vault_sync to push to GitHub
4. Never hallucinate past conversations — always recall first

═══════════════════════════════════════
ORCHESTRATION TOOLS
═══════════════════════════════════════
- update_plan / show_plan   — multi-step task planning (pending/in_progress/completed)
- task_create/update/list   — persistent task tracking
- cron_add/list/remove      — schedule recurring agent tasks ("every 30m", "every 2h")
- spawn_agent               — delegate sub-tasks to a child agent process

WEB TOOLS:
- web_fetch    — fetch any URL → clean markdown or text
- web_search   — DuckDuckGo + HTML fallback search (no API key needed)
- http_request — full HTTP calls (GET/POST/PUT/PATCH/DELETE with custom headers)

MEMORY TOOLS:
- memory_recall   — search vault for relevant memories (use at session start)
- memory_store    — persist new knowledge, user facts, skills
- memory_append   — add to an existing memory note
- memory_read     — read a specific note in full
- memory_list     — list all memory files
- vault_sync      — commit + push vault to GitHub

ANDROID/TERMUX:
- Full Android control via Termux:API (SMS, calls, camera, GPS, TTS, notifications…)
- shell, read_file, write_file, run_code, search_files, termux_info
- android_dialog  — interactive UI dialogs
- image_analyze   — analyze photos with vision AI
- pdf_read        — extract text from PDFs

═══════════════════════════════════════
RULES
═══════════════════════════════════════
- ALWAYS recall memory before answering questions about the user or prior sessions
- ALWAYS store new user facts to UserProfile/ and new knowledge to Knowledge/
- ALWAYS sync vault after storing important information
- For multi-step tasks: start with update_plan, work through steps, update as you go
- Be concise and efficient — you run on a mobile device`;
  }

  private initializeContext(): void {
    if (this.systemPrompt) {
      this.context.messages.push({ role: "system", content: this.systemPrompt });
    }
  }

  /**
   * Pre-load vault context (user profile + recent session) into system messages.
   */
  public async initVaultContext(): Promise<void> {
    if (!this.obsidianMemory) return;
    try {
      const userFacts = await this.obsidianMemory.read("USER-FACTS", "user");
      if (userFacts) {
        const snippet = userFacts.replace(/^---[\s\S]*?---\n/m, "").trim().slice(0, 2000);
        this.context.messages.push({
          role: "system",
          content: `[Vault: UserProfile/USER-FACTS.md]\n${snippet}`,
        });
      }
      const sessions = await this.obsidianMemory.list("episode");
      if (sessions.length > 0) {
        const latest = sessions[sessions.length - 1];
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(latest.path, "utf8").catch(() => "");
        if (content) {
          const snippet = content.replace(/^---[\s\S]*?---\n/m, "").trim().slice(0, 1200);
          this.context.messages.push({
            role: "system",
            content: `[Vault: last session — ${latest.file}]\n${snippet}`,
          });
        }
      }
      this.logger.info("Vault context loaded into session");
    } catch (err: any) {
      this.logger.debug(`Vault init skipped: ${(err as Error).message}`);
    }
  }

  public addMessage(message: Message): void {
    this.context.messages.push(message);
    if (this.memory && message.role !== "system") {
      this.memory.save({ ...message, sessionId: this.sessionId });
    }
    this.trimContext();
  }

  /**
   * Trim context to stay within message cap and token budget.
   * Runs context summarization when summarization is enabled and context is large.
   */
  private trimContext(): void {
    const maxMessages = this.config.get<number>("context.maxMessages") ?? 60;
    const maxTokens = this.config.get<number>("context.maxTokens") ?? 40000;

    const system = this.context.messages.filter(m => m.role === "system");
    const other = this.context.messages.filter(m => m.role !== "system");

    if (other.length > maxMessages) {
      const keep = maxMessages - Math.floor(maxMessages * 0.2);
      this.context.messages = [...system, ...other.slice(-keep)];
    }

    const before = TokenOptimizer.estimateMessages(this.context.messages);
    if (before > maxTokens) {
      this.context.messages = TokenOptimizer.trim(this.context.messages, { maxTokens });
      this.logger.debug(
        `Context trimmed ${before}→${TokenOptimizer.estimateMessages(this.context.messages)} tokens`,
      );
    }
  }

  /**
   * Summarize older messages when the conversation grows very long.
   * Called explicitly — not on every turn — to avoid excessive API calls.
   */
  public async summarizeContext(): Promise<void> {
    if (!this.config.get("context.enableSummarization")) return;
    const nonSystem = this.context.messages.filter(m => m.role !== "system");
    if (nonSystem.length < 24) return;

    const toSummarize = nonSystem.slice(0, -12);
    this.logger.info(`Summarizing ${toSummarize.length} old messages…`);

    try {
      const summaryReq: CompletionRequest = {
        model: this.context.model,
        messages: [
          {
            role: "system",
            content: "Summarize the following conversation concisely, preserving all key facts, decisions, file paths, code, and action items. Output the summary only — no preamble.",
          },
          {
            role: "user",
            content: toSummarize
              .map(m => `${m.role}: ${m.content?.slice(0, 800) ?? ""}`)
              .join("\n\n"),
          },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      };
      const summary = await this.gateway.complete(summaryReq);

      const systemMsgs = this.context.messages.filter(m => m.role === "system");
      const recentMsgs = nonSystem.slice(-12);
      this.context.messages = [
        ...systemMsgs,
        { role: "system", content: `[Conversation summary — ${new Date().toISOString()}]\n${summary.content}` },
        ...recentMsgs,
      ];
      this.logger.info("Context summarized");
    } catch (err: any) {
      this.logger.warn(`Summarization failed: ${err.message}`);
    }
  }

  private buildRequest(stream: boolean): CompletionRequest {
    const request: CompletionRequest = {
      model: this.context.model,
      messages: this.context.messages,
      temperature: this.context.temperature,
      max_tokens: this.context.maxTokens,
      stream,
    };
    if (this.tools?.hasEnabledTools()) {
      request.tools = this.tools.getToolSchemas();
    }
    if (this.thinkingBudget > 0) {
      request.thinking = { type: "enabled", budget_tokens: this.thinkingBudget };
    }
    return request;
  }

  private async injectRagContext(userInput: string): Promise<void> {
    if (!this.obsidianMemory) return;
    try {
      const hits = await this.obsidianMemory.recall(userInput, 6);
      const block = TokenOptimizer.buildRagContext(
        hits.map(h => ({ note: h.title, snippet: h.content })),
      );
      if (block) this.context.messages.push({ role: "system", content: block });
    } catch (err: any) {
      this.logger.debug(`Obsidian recall skipped: ${err.message}`);
    }
  }

  /**
   * Execute a single turn — full agentic tool loop, returns final text response.
   */
  public async execute(userInput: string): Promise<string> {
    await this.injectRagContext(userInput);
    this.addMessage({ role: "user", content: userInput });

    // Trigger summarization if context is growing large
    const nonSystem = this.context.messages.filter(m => m.role !== "system");
    if (nonSystem.length > 40) {
      await this.summarizeContext();
    }

    const request = this.buildRequest(false);
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      this.logger.debug(`Calling ${this.context.model} (round ${round + 1})…`);
      const response = await this.gateway.complete(request);

      if (!response.tool_calls?.length || !this.tools) {
        this.addMessage({ role: "assistant", content: response.content });
        if (response.thinking) {
          this.logger.debug(`Thinking: ${response.thinking.slice(0, 120)}…`);
        }
        return response.content;
      }

      // Add assistant turn with tool calls
      this.addMessage({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // Execute all tool calls in this round IN PARALLEL
      const toolResults = await Promise.all(
        response.tool_calls.map(async (call) => {
          this.logger.info(`Tool [${round + 1}]: ${call.function.name}`);
          try {
            const result = await this.tools!.execute(call);
            return { call, content: JSON.stringify(result.output), error: false };
          } catch (err: any) {
            return { call, content: JSON.stringify({ error: err.message }), error: true };
          }
        }),
      );

      for (const { call, content } of toolResults) {
        this.addMessage({
          role: "tool",
          content,
          name: call.function.name,
          tool_call_id: call.id,
        });
      }

      request.messages = this.context.messages;
      round++;
    }

    // Safety: max rounds reached — ask for a final answer without tools
    this.logger.warn("Max tool rounds reached, requesting final answer");
    const finalReq = { ...request, tools: undefined, stream: false as const };
    finalReq.messages = this.context.messages;
    const final = await this.gateway.complete(finalReq);
    this.addMessage({ role: "assistant", content: final.content });
    return final.content;
  }

  /**
   * Streaming execute — runs the full tool loop non-streaming for tool rounds,
   * then streams the final answer to keep the UI responsive.
   */
  public async *executeStream(userInput: string): AsyncGenerator<string, void, unknown> {
    await this.injectRagContext(userInput);
    this.addMessage({ role: "user", content: userInput });

    const nonSystem = this.context.messages.filter(m => m.role !== "system");
    if (nonSystem.length > 40) await this.summarizeContext();

    // Run tool rounds non-streaming
    const request = this.buildRequest(false);
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      const response = await this.gateway.complete(request);

      if (!response.tool_calls?.length || !this.tools) {
        // Final response — stream it
        this.addMessage({ role: "assistant", content: response.content });
        // Yield the already-received content character by character for smooth UX,
        // or just yield it all at once if the content is short.
        yield response.content;
        return;
      }

      this.addMessage({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      const toolResults = await Promise.all(
        response.tool_calls.map(async (call) => {
          this.logger.info(`Tool [${round + 1}]: ${call.function.name}`);
          try {
            const result = await this.tools!.execute(call);
            return { call, content: JSON.stringify(result.output) };
          } catch (err: any) {
            return { call, content: JSON.stringify({ error: err.message }) };
          }
        }),
      );

      for (const { call, content } of toolResults) {
        this.addMessage({ role: "tool", content, name: call.function.name, tool_call_id: call.id });
      }

      request.messages = this.context.messages;
      round++;
    }

    // Max rounds: stream final answer
    const streamRequest = this.buildRequest(true);
    streamRequest.tools = undefined;
    streamRequest.messages = this.context.messages;

    let fullContent = "";
    for await (const chunk of this.gateway.completeStream(streamRequest)) {
      fullContent += chunk;
      yield chunk;
    }
    this.addMessage({ role: "assistant", content: fullContent });
  }

  public getContext(): AgentContext {
    return { ...this.context };
  }

  public clearContext(): void {
    const systemMessages = this.context.messages.filter(m => m.role === "system");
    this.context.messages = systemMessages;
    this.memory?.clear?.();
    this.logger.info("Context cleared");
  }

  public updateConfig(updates: Partial<AgentContext>): void {
    Object.assign(this.context, updates);
    this.logger.debug("Runtime config updated");
  }
}
