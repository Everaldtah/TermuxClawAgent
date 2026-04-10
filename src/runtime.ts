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
    return `You are TermuxClawAgent, a powerful AI agent running natively on Android via Termux.
You have full orchestration capabilities inspired by OpenClaw:

**Orchestration tools:**
- update_plan / show_plan — plan multi-step tasks with step-by-step tracking
- task_create / task_update / task_list — create and track background tasks
- cron_add / cron_list / cron_remove — schedule recurring agent tasks
- spawn_agent — delegate sub-tasks to a child agent process

**Web tools:**
- web_fetch — fetch any URL and extract clean markdown or text
- web_search — search the web via DuckDuckGo (no API key needed)

**Memory tools:**
- memory_store — persist facts, episodes, skills, and notes
- memory_recall — semantic search over stored memories
- memory_list — list stored memories

**Android/Termux tools:**
- Full Android control via Termux:API (SMS, calls, camera, GPS, notifications, TTS, etc.)
- Shell execution, file I/O, Python/JS code execution

For multi-step tasks, always start with update_plan to set your steps, then work through them systematically, updating status as you go. Use tools freely — you can call multiple tools per turn in sequence.

Be concise, efficient, and thorough. You run on a mobile device so optimize for clarity over verbosity.`;
  }

  private initializeContext(): void {
    if (this.systemPrompt) {
      this.context.messages.push({
        role: "system",
        content: this.systemPrompt
      });
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
