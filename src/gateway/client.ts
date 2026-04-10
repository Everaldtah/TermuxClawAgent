/**
 * GatewayClient - LLM API client for TermuxAgent
 * Token-optimized, supports multiple providers
 */

import { Logger } from "../utils/logger.js";

export interface CompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
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
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: ToolCall[];
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

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min — NIM reasoning models can be slow
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2_000;

// Transient network errors worth retrying
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
  // Wrap raw ETIMEDOUT etc. with a friendlier message
  const msg = (lastErr as Error)?.message ?? String(lastErr);
  throw new Error(`Agent network error after ${MAX_RETRIES} retries: ${msg}`);
}

// ─── GatewayClient ────────────────────────────────────────────────────────────

/**
 * Gateway client for LLM API communication
 */
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
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      ollama: "http://localhost:11434/v1",
      lmstudio: "http://localhost:1234/v1",
      openrouter: "https://openrouter.ai/api/v1",
      groq: "https://api.groq.com/openai/v1",
      gemini: "https://generativelanguage.googleapis.com/v1",
      nvidia: "https://integrate.api.nvidia.com/v1",
      kimi: "https://api.moonshot.cn/v1",
      minimax: "https://api.minimax.chat/v1",
    };
    return urls[provider] || urls.openai;
  }

  /**
   * Return auth headers. OAuth access tokens take precedence over API keys.
   */
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

  /**
   * Refresh OAuth access token if expired or close to expiry.
   */
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
      if (!res.ok) {
        this.logger.warn(`OAuth refresh failed (${res.status}) — keeping existing token`);
        return;
      }
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
    const provider = this.detectProvider(request.model);
    if (provider === "anthropic") return this.completeAnthropic(request);
    return this.completeOpenAI(request);
  }

  public async *completeStream(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const provider = this.detectProvider(request.model);
    if (provider === "anthropic") {
      yield* this.streamAnthropic(request);
    } else {
      yield* this.streamOpenAI(request);
    }
  }

  // ─── OpenAI-compatible ───────────────────────────────────────────────────────

  private async completeOpenAI(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const maxTok = request.max_tokens ?? 4096;

    const body: any = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      // Send both — NVIDIA NIM uses max_completion_tokens; others use max_tokens.
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
      this.logger.error(`No choices in response from ${this.config.name}: ${JSON.stringify(data)}`);
      throw new Error(`Empty response from ${this.config.name}: no choices returned`);
    }

    const msg = choice.message ?? {};

    // Handle content in three forms seen across NIM / OpenAI-compat providers:
    // 1. Plain string (standard)
    // 2. Array of content blocks [{type:"text",text:"..."}]
    // 3. null — reasoning models (Kimi K2, DeepSeek-R1) put text in reasoning_content
    let content: string;
    if (Array.isArray(msg.content)) {
      content = (msg.content as any[])
        .filter(b => b.type === "text")
        .map(b => b.text ?? "")
        .join("");
    } else {
      content = msg.content ?? "";
    }

    if (!content && msg.reasoning_content) {
      content = msg.reasoning_content as string;
    }

    if (!content && choice.finish_reason !== "tool_calls") {
      this.logger.error(
        `Empty content from ${this.config.name} (finish_reason=${choice.finish_reason}). ` +
        `Raw: ${JSON.stringify(data)}`,
      );
    }

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
      max_tokens: request.max_tokens ?? 4096,
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
            // Yield standard content or reasoning_content fallback
            const text: string = delta?.content ?? delta?.reasoning_content ?? "";
            if (text) yield text;
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ─── Anthropic ───────────────────────────────────────────────────────────────

  private async completeAnthropic(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/messages`;
    const systemMessage = request.messages.find(m => m.role === "system");
    const otherMessages = request.messages.filter(m => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
    };
    if (systemMessage) body.system = systemMessage.content;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers || {}),
    };
    if (this.config.oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      headers["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
    } else {
      headers["x-api-key"] = this.config.apiKey;
    }

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      this.timeoutMs,
      this.logger,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    return {
      content: data.content?.[0]?.text || "",
      model: data.model,
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  private async *streamAnthropic(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/messages`;
    const systemMessage = request.messages.find(m => m.role === "system");
    const otherMessages = request.messages.filter(m => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
      stream: true,
    };
    if (systemMessage) body.system = systemMessage.content;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers || {}),
    };
    if (this.config.oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      headers["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
    } else {
      headers["x-api-key"] = this.config.apiKey;
    }

    const response = await fetchWithRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
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
              yield parsed.delta?.text || "";
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private detectProvider(model: string): string {
    const explicit = this.config.name;
    if (["nvidia", "kimi", "minimax", "groq", "openrouter", "lmstudio", "ollama"].includes(explicit)) {
      return "openai";
    }
    if (model.startsWith("claude-") || explicit === "anthropic") return "anthropic";
    if (model.startsWith("gemini-") || explicit === "gemini") return "gemini";
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
        model: this.config.defaultModel || "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      });
      return true;
    } catch {
      return false;
    }
  }
}
