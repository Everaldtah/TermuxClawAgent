/**
 * AgentRuntime - Core runtime for TermuxAgent
 * Token-optimized execution environment
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
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export interface AgentContext {
  messages: Message[];
  model: string;
  temperature: number;
  maxTokens: number;
  tools?: any[];
}

/**
 * Core agent runtime - manages execution flow
 */
export class AgentRuntime {
  public config: ConfigManager;
  public gateway: GatewayClient;
  public memory: MemoryStore | null;
  public tools: ToolRegistry | null;
  public obsidianMemory: ObsidianMemory | null;
  public model: string;
  
  private logger: Logger;
  private systemPrompt: string;
  private context: AgentContext;

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.gateway = options.gateway;
    this.memory = options.memory ?? null;
    this.tools = options.tools ?? null;
    this.obsidianMemory = options.obsidianMemory ?? null;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.logger = new Logger("Runtime");
    
    this.context = {
      messages: [],
      model: this.model,
      temperature: this.config.get("model.temperature") ?? 0.7,
      maxTokens: this.config.get("model.maxTokens") ?? 4096
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

VAULT SKILLS (shell scripts you can run directly):
  ~/vault-sync.sh                          — git pull + commit + push vault to GitHub
  ~/solis-write-memory.sh "title" "body"   — quick shell-based memory write to Memory/

═══════════════════════════════════════
ORCHESTRATION TOOLS
═══════════════════════════════════════
- update_plan / show_plan   — multi-step task planning (pending/in_progress/completed)
- task_create/update/list   — persistent task tracking
- cron_add/list/remove      — schedule recurring agent tasks ("every 30m", "every 2h")
- spawn_agent               — delegate sub-tasks to a child agent process

WEB TOOLS:
- web_fetch    — fetch any URL → clean markdown or text
- web_search   — DuckDuckGo search (no API key needed)

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
   * Called once at agent startup so the model starts each session already knowing
   * who the user is and what was last worked on.
   */
  public async initVaultContext(): Promise<void> {
    if (!this.obsidianMemory) return;
    try {
      // Load user profile always
      const userFacts = await this.obsidianMemory.read("USER-FACTS", "user");
      if (userFacts) {
        const snippet = userFacts.replace(/^---[\s\S]*?---\n/m, "").trim().slice(0, 800);
        this.context.messages.push({
          role: "system",
          content: `[Vault: UserProfile/USER-FACTS.md]\n${snippet}`,
        });
      }
      // Load most recent session note if any
      const sessions = await this.obsidianMemory.list("episode");
      if (sessions.length > 0) {
        const latest = sessions[sessions.length - 1];
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(latest.path, "utf8").catch(() => "");
        if (content) {
          const snippet = content.replace(/^---[\s\S]*?---\n/m, "").trim().slice(0, 600);
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

  /**
   * Add a message to the conversation context
   */
  public addMessage(message: Message): void {
    this.context.messages.push(message);
    this.memory?.save(message);
    this.trimContext();
  }

  /**
   * Trim context to stay within BOTH a message cap and a token budget.
   * Delegates the token-aware work to TokenOptimizer so that tool output
   * (the biggest token sink) is compacted rather than just dropped.
   */
  private trimContext(): void {
    const maxMessages = this.config.get<number>("context.maxMessages") ?? 50;
    const maxTokens = this.config.get<number>("context.maxTokens") ?? 8000;

    // First, a cheap message-count cap (cheap path for short convos).
    const system = this.context.messages.filter(m => m.role === "system");
    const other = this.context.messages.filter(m => m.role !== "system");
    if (other.length > maxMessages) {
      const keep = maxMessages - Math.floor(maxMessages * 0.2);
      this.context.messages = [...system, ...other.slice(-keep)];
    }

    // Then token-aware trim (compacts tool results, drops old middle).
    const before = TokenOptimizer.estimateMessages(this.context.messages);
    if (before > maxTokens) {
      this.context.messages = TokenOptimizer.trim(this.context.messages, { maxTokens });
      this.logger.debug(
        `Context trimmed ${before}→${TokenOptimizer.estimateMessages(this.context.messages)} tokens`
      );
    }
  }

  /**
   * Execute a single turn with the LLM
   */
  public async execute(userInput: string): Promise<string> {
    // Pull relevant memory from the Obsidian vault BEFORE sending — this
    // is the local-RAG path: only the top-k snippets are injected, not
    // full history, which keeps prompt tokens flat as memory grows.
    if (this.obsidianMemory) {
      try {
        const hits = await this.obsidianMemory.recall(userInput, 5);
        const ragHits = hits.map(h => ({ note: h.title, snippet: h.content }));
        const block = TokenOptimizer.buildRagContext(ragHits);
        if (block) this.context.messages.push({ role: "system", content: block });
      } catch (err: any) {
        this.logger.debug(`Obsidian recall skipped: ${err.message}`);
      }
    }

    // Add user message
    this.addMessage({ role: "user", content: userInput });

    // Build request
    const request: CompletionRequest = {
      model: this.context.model,
      messages: this.context.messages,
      temperature: this.context.temperature,
      max_tokens: this.context.maxTokens,
      stream: false
    };

    // Add tools if available
    if (this.tools?.hasEnabledTools()) {
      request.tools = this.tools.getToolSchemas();
    }

    // Agentic loop: keep calling tools until the model stops requesting them
    this.logger.debug(`Calling ${this.context.model}...`);
    const MAX_TOOL_ROUNDS = 20;
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      const response = await this.gateway.complete(request);

      if (!response.tool_calls || response.tool_calls.length === 0 || !this.tools) {
        // Final response — no more tool calls
        this.addMessage({ role: "assistant", content: response.content });
        return response.content;
      }

      // Add assistant turn with tool calls
      this.addMessage({ role: "assistant", content: response.content, tool_calls: response.tool_calls });

      // Execute all tool calls in this round
      for (const call of response.tool_calls) {
        this.logger.info(`Tool call [${round + 1}]: ${call.function.name}`);
        try {
          const result = await this.tools.execute(call);
          this.addMessage({ role: "tool", content: JSON.stringify(result.output), name: call.function.name });
        } catch (err: any) {
          this.addMessage({ role: "tool", content: JSON.stringify({ error: err.message }), name: call.function.name });
        }
      }

      // Rebuild request with updated context for next round
      request.messages = this.context.messages;
      round++;
    }

    // Safety: if we hit max rounds, ask model for final answer
    this.logger.warn("Max tool rounds reached, requesting final answer");
    request.tools = undefined;
    request.messages = this.context.messages;
    const final = await this.gateway.complete(request);
    this.addMessage({ role: "assistant", content: final.content });
    return final.content;
  }

  /**
   * Execute with streaming response
   */
  public async *executeStream(userInput: string): AsyncGenerator<string, void, unknown> {
    this.addMessage({ role: "user", content: userInput });

    const request: CompletionRequest = {
      model: this.context.model,
      messages: this.context.messages,
      temperature: this.context.temperature,
      max_tokens: this.context.maxTokens,
      stream: true
    };

    let fullContent = "";
    
    for await (const chunk of this.gateway.completeStream(request)) {
      fullContent += chunk;
      yield chunk;
    }

    this.addMessage({
      role: "assistant",
      content: fullContent
    });
  }

  /**
   * Get current context for inspection
   */
  public getContext(): AgentContext {
    return { ...this.context };
  }

  /**
   * Clear conversation context (keep system prompt)
   */
  public clearContext(): void {
    const systemMessages = this.context.messages.filter(m => m.role === "system");
    this.context.messages = systemMessages;
    this.memory?.clear?.();
    this.logger.info("Context cleared");
  }

  /**
   * Update runtime configuration
   */
  public updateConfig(updates: Partial<AgentContext>): void {
    Object.assign(this.context, updates);
    this.logger.debug("Runtime config updated");
  }
}
