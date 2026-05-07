/**
 * GatewayClient - LLM API client for TermuxAgent
 * Supports: OpenAI, Anthropic (with tool use + extended thinking + prompt caching),
 *           Gemini (via OpenAI-compat endpoint), Ollama, LM Studio, OpenRouter,
 *           Groq, NVIDIA NIM, Kimi, MiniMax, DeepSeek, Mistral, xAI, Together AI
 */

import { Logger } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  /** Enable extended thinking (Anthropic Claude 3.5+ / 4.x only). */
  thinking?: { type: "enabled"; budget_tokens: number };
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  tool_calls?: ToolCall[];
  /** Raw thinking/reasoning text when extended thinking is enabled. */
  thinking?: string;
}

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenUrl?: string;
  expiresAt?: number;
  scope?: string;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  oauth?: OAuthConfig;
  headers?: Record<string, string>;
}

// ─── Resilient fetch: timeout + retry with exponential backoff ────────────────

const DEFAULT_TIMEOUT_MS = 180_000; // 3 min
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2_000;

const RETRYABLE_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND",
  "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  const code: string = (err as any)?.cause?.code ?? (err as any)?.code ?? "";
  return (
    RETRYABLE_CODES.has(code) ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("fetch failed") ||
    msg.includes("timed out")
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs / 1000}s`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  logger: Logger,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (err: unknown) {
      lastErr = err;
      const isLast = attempt === MAX_RETRIES;
      if (!isRetryable(err) || isLast) break;
      const delay = RETRY_BASE_MS * 2 ** attempt;
      logger.warn(
        `Network error (${(err as Error).message}), retrying in ${delay / 1000}s… [${attempt + 1}/${MAX_RETRIES}]`,
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  const msg = (lastErr as Error)?.message ?? String(lastErr);
  throw new Error(`Agent network error after ${MAX_RETRIES} retries: ${msg}`);
}

// ─── Anthropic message format conversion ──────────────────────────────────────

/**
 * Convert OpenAI-style tool definitions → Anthropic format.
 */
function toAnthropicTools(tools: any[]): any[] {
  return tools.map(t => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description ?? "",
    input_schema: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * Convert the internal OpenAI-style message array → Anthropic messages array.
 * Handles: text, tool_use (assistant), tool_result (user), and consecutive merging.
 */
function toAnthropicMessages(messages: CompletionMessage[]): any[] {
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const last = out[out.length - 1];
      if (last?.role === "user") {
        // Merge consecutive user messages (e.g. multiple tool results)
        if (!Array.isArray(last.content)) last.content = [{ type: "text", text: last.content }];
        last.content.push({ type: "text", text: m.content });
      } else {
        out.push({ role: "user", content: m.content });
      }
      continue;
    }

    if (m.role === "tool") {
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? `toolu_${m.name}`,
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last?.role === "user") {
        // Append to existing user message as another content block
        if (!Array.isArray(last.content)) last.content = [{ type: "text", text: last.content }];
        last.content.push(toolResultBlock);
      } else {
        out.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        out.push({ role: "assistant", content });
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    }
  }

  return out;
}

// ─── GatewayClient ────────────────────────────────────────────────────────────

export class GatewayClient {
  private config: ProviderConfig;
  private logger: Logger;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: ProviderConfig, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.config = config;
    this.logger = new Logger("Gateway");
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.name);
    this.timeoutMs = timeoutMs;
  }

  private getDefaultBaseUrl(provider: string): string {
    const urls: Record<string, string> = {
      openai:      "https://api.openai.com/v1",
      anthropic:   "https://api.anthropic.com/v1",
      // Gemini: use Google's OpenAI-compatible endpoint — no custom adapter needed
      gemini:      "https://generativelanguage.googleapis.com/v1beta/openai",
      ollama:      "http://localhost:11434/v1",
      lmstudio:    "http://localhost:1234/v1",
      openrouter:  "https://openrouter.ai/api/v1",
      groq:        "https://api.groq.com/openai/v1",
      nvidia:      "https://integrate.api.nvidia.com/v1",
      kimi:        "https://api.moonshot.cn/v1",
      minimax:     "https://api.minimax.chat/v1",
      deepseek:    "https://api.deepseek.com/v1",
      mistral:     "https://api.mistral.ai/v1",
      xai:         "https://api.x.ai/v1",
      together:    "https://api.together.xyz/v1",
    };
    return urls[provider] ?? urls.openai;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.headers) Object.assign(headers, this.config.headers);
    const oauth = this.config.oauth;
    if (oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      headers["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
      return headers;
    }
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private async maybeRefreshOAuth(): Promise<void> {
    const oauth = this.config.oauth;
    if (!oauth?.refreshToken || !oauth.tokenUrl) return;
    const now = Date.now();
    if (oauth.expiresAt && oauth.expiresAt - now > 60_000) return;
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        ...(oauth.clientId ? { client_id: oauth.clientId } : {}),
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
      });
      const res = await fetchWithTimeout(
        oauth.tokenUrl,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        30_000,
      );
      if (!res.ok) { this.logger.warn(`OAuth refresh failed (${res.status})`); return; }
      const data: any = await res.json();
      oauth.accessToken = data.access_token || oauth.accessToken;
      if (data.refresh_token) oauth.refreshToken = data.refresh_token;
      if (data.expires_in) oauth.expiresAt = now + data.expires_in * 1000;
      this.logger.debug("OAuth token refreshed");
    } catch (err: unknown) {
      this.logger.warn(`OAuth refresh error: ${(err as Error).message}`);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  public async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.detectProvider(request.model) === "anthropic") {
      return this.completeAnthropic(request);
    }
    return this.completeOpenAI(request);
  }

  public async *completeStream(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    if (this.detectProvider(request.model) === "anthropic") {
      yield* this.streamAnthropic(request);
    } else {
      yield* this.streamOpenAI(request);
    }
  }

  // ─── OpenAI-compatible ───────────────────────────────────────────────────────

  private async completeOpenAI(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const maxTok = request.max_tokens ?? 32768;

    const body: any = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: maxTok,
      max_completion_tokens: maxTok,
      stream: false,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers: await this.getAuthHeaders(), body: JSON.stringify(body) },
      this.timeoutMs,
      this.logger,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`Empty response from ${this.config.name}: no choices returned`);
    }

    const msg = choice.message ?? {};
    let content: string;
    if (Array.isArray(msg.content)) {
      content = (msg.content as any[]).filter(b => b.type === "text").map(b => b.text ?? "").join("");
    } else {
      content = msg.content ?? "";
    }
    if (!content && msg.reasoning_content) content = msg.reasoning_content as string;

    return {
      content,
      model: data.model ?? request.model,
      usage: data.usage,
      tool_calls: msg.tool_calls,
    };
  }

  private async *streamOpenAI(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 32768,
      stream: true,
    };

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers: await this.getAuthHeaders(), body: JSON.stringify(body) },
      this.timeoutMs,
      this.logger,
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const chunk = trimmed.slice(6);
          if (chunk === "[DONE]") return;
          try {
            const parsed = JSON.parse(chunk);
            const delta = parsed.choices?.[0]?.delta;
            const text: string = delta?.content ?? delta?.reasoning_content ?? "";
            if (text) yield text;
          } catch { /* ignore malformed SSE */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ─── Anthropic ───────────────────────────────────────────────────────────────

  private getAnthropicHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2024-10-22",
      "anthropic-beta": "prompt-caching-2024-07-31",
      ...(this.config.headers || {}),
    };
    if (this.config.oauth?.accessToken) {
      headers["Authorization"] = `Bearer ${this.config.oauth.accessToken}`;
    } else {
      headers["x-api-key"] = this.config.apiKey;
    }
    return headers;
  }

  private buildAnthropicBody(request: CompletionRequest): any {
    const systemMsgs = request.messages.filter(m => m.role === "system");
    const nonSystem = request.messages.filter(m => m.role !== "system");
    const anthropicMessages = toAnthropicMessages(nonSystem);

    // Build system content with prompt caching on the last (longest) block
    const systemText = systemMsgs.map(m => m.content).join("\n\n");
    const systemContent = systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : undefined;

    const body: any = {
      model: request.model,
      messages: anthropicMessages,
      max_tokens: request.max_tokens ?? 32768,
      ...(systemContent ? { system: systemContent } : {}),
    };

    // Extended thinking: temperature must be 1 when thinking is enabled
    if (request.thinking) {
      body.thinking = request.thinking;
      body.temperature = 1;
    } else {
      body.temperature = request.temperature ?? 0.7;
    }

    // Tools: convert from OpenAI format and mark last tool for caching
    if (request.tools?.length) {
      const converted = toAnthropicTools(request.tools);
      converted[converted.length - 1] = {
        ...converted[converted.length - 1],
        cache_control: { type: "ephemeral" },
      };
      body.tools = converted;
      body.tool_choice = { type: "auto" };
    }

    return body;
  }

  private async completeAnthropic(request: CompletionRequest): Promise<CompletionResponse> {
    if (request.oauth) await this.maybeRefreshOAuth();

    const url = `${this.baseUrl}/messages`;
    const body = this.buildAnthropicBody(request);

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers: this.getAnthropicHeaders(), body: JSON.stringify(body) },
      this.timeoutMs,
      this.logger,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const contentBlocks: any[] = data.content ?? [];

    // Extract text, tool_use, and thinking blocks
    let textContent = "";
    let thinkingContent = "";
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === "text") {
        textContent += block.text ?? "";
      } else if (block.type === "thinking") {
        thinkingContent += block.thinking ?? "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const usage = data.usage ?? {};
    return {
      content: textContent,
      model: data.model ?? request.model,
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
      },
      tool_calls: toolCalls.length ? toolCalls : undefined,
      thinking: thinkingContent || undefined,
    };
  }

  private async *streamAnthropic(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    if (request.oauth) await this.maybeRefreshOAuth();

    const url = `${this.baseUrl}/messages`;
    const body = { ...this.buildAnthropicBody(request), stream: true };

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers: this.getAnthropicHeaders(), body: JSON.stringify(body) },
      this.timeoutMs,
      this.logger,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const chunk = trimmed.slice(6);
          try {
            const parsed = JSON.parse(chunk);
            if (parsed.type === "content_block_delta") {
              const delta = parsed.delta;
              // Yield text content; skip thinking blocks during streaming
              if (delta?.type === "text_delta") yield delta.text || "";
            }
          } catch { /* ignore malformed */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private detectProvider(model: string): string {
    const explicit = this.config.name;
    // These all use OpenAI-compatible endpoints
    if ([
      "nvidia", "kimi", "minimax", "groq", "openrouter", "lmstudio",
      "ollama", "deepseek", "mistral", "xai", "together", "gemini",
    ].includes(explicit)) {
      return "openai";
    }
    if (model.startsWith("claude-") || explicit === "anthropic") return "anthropic";
    return "openai";
  }

  public async listModels(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/models`;
      const response = await fetchWithTimeout(
        url,
        { headers: { "Authorization": `Bearer ${this.config.apiKey}` } },
        15_000,
      );
      if (!response.ok) return [];
      const data = await response.json() as Record<string, any>;
      return data.data?.map((m: any) => m.id) || [];
    } catch {
      return [];
    }
  }

  public async validate(): Promise<boolean> {
    try {
      await this.complete({
        model: this.config.defaultModel || "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// Patch: allow passing oauth through request (internal use only)
declare module "./client.js" {
  interface CompletionRequest {
    oauth?: boolean;
  }
}
