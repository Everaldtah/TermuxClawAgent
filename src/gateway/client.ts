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

/**
 * Gateway client for LLM API communication
 */
export class GatewayClient {
  private config: ProviderConfig;
  private logger: Logger;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.logger = new Logger("Gateway");
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(config.name);
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
      // NVIDIA NIM / build.nvidia.com — OpenAI-compatible.
      nvidia: "https://integrate.api.nvidia.com/v1",
      // Moonshot Kimi — OpenAI-compatible.
      kimi: "https://api.moonshot.cn/v1",
      // MiniMax — OpenAI-compatible chat completions endpoint.
      minimax: "https://api.minimax.chat/v1"
    };
    return urls[provider] || urls.openai;
  }

  /**
   * Return the best auth header pair for this provider. OAuth access
   * tokens (when present and unexpired) take precedence over static API
   * keys. Anthropic uses a custom `x-api-key` header instead of bearer.
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Merge any static provider-level headers first (e.g. NVIDIA NIM org,
    // MiniMax GroupId) so callers can add anything providers require.
    if (this.config.headers) Object.assign(headers, this.config.headers);

    // Prefer OAuth if configured and valid.
    const oauth = this.config.oauth;
    if (oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      headers["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
      return headers;
    }

    // Anthropic uses x-api-key (not bearer). Set elsewhere in completeAnthropic,
    // but if someone calls through the OpenAI path with an Anthropic key we
    // still fall through to bearer below.
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * Refresh the OAuth access token if it is expired or about to expire.
   * Uses the standard `refresh_token` grant — works for Anthropic Console
   * OAuth, Google/Gemini OAuth, and any RFC-6749 provider.
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
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {})
      });
      const res = await fetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!res.ok) {
        this.logger.warn(`OAuth refresh failed (${res.status}) — falling back to existing token`);
        return;
      }
      const data: any = await res.json();
      oauth.accessToken = data.access_token || oauth.accessToken;
      if (data.refresh_token) oauth.refreshToken = data.refresh_token;
      if (data.expires_in) oauth.expiresAt = now + data.expires_in * 1000;
      this.logger.debug("OAuth access token refreshed");
    } catch (err: any) {
      this.logger.warn(`OAuth refresh error: ${(err as Error).message}`);
    }
  }

  /**
   * Make a completion request (non-streaming)
   */
  public async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const provider = this.detectProvider(request.model);
    
    switch (provider) {
      case "anthropic":
        return this.completeAnthropic(request);
      case "openai":
      default:
        return this.completeOpenAI(request);
    }
  }

  /**
   * Make a streaming completion request
   */
  public async *completeStream(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const provider = this.detectProvider(request.model);
    
    if (provider === "anthropic") {
      yield* this.streamAnthropic(request);
    } else {
      yield* this.streamOpenAI(request);
    }
  }

  /**
   * OpenAI-compatible API completion
   */
  private async completeOpenAI(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    
    const maxTok = request.max_tokens ?? 4096;
    const body: any = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      // NVIDIA NIM accepts both; send both for compatibility across providers.
      max_tokens: maxTok,
      max_completion_tokens: maxTok,
      stream: false
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: await this.getAuthHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data.choices[0];

    if (!choice) {
      this.logger.error(`NIM/OpenAI response missing choices: ${JSON.stringify(data)}`);
      throw new Error(`Empty response from ${this.config.name}: no choices in response`);
    }

    const msg = choice.message ?? {};

    // Resolve content — handles three cases seen with NVIDIA NIM reasoning models:
    // 1. Plain string (standard)
    // 2. null/empty with text in reasoning_content (Kimi K2, DeepSeek-R1 on NIM)
    // 3. Content as array of blocks [{type:"text",text:"..."}] (some NIM variants)
    let content: string;
    if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text ?? "")
        .join("");
    } else {
      content = msg.content ?? "";
    }

    // Reasoning models (Kimi K2, DeepSeek-R1) put the actual answer in
    // reasoning_content when content is empty. Fall back to it.
    if (!content && msg.reasoning_content) {
      content = msg.reasoning_content;
    }

    if (!content && choice.finish_reason !== "tool_calls") {
      this.logger.error(`Empty content from ${this.config.name}. Full response: ${JSON.stringify(data)}`);
    }

    return {
      content,
      model: data.model ?? request.model,
      usage: data.usage,
      tool_calls: msg.tool_calls
    };
  }

  /**
   * OpenAI-compatible streaming
   */
  private async *streamOpenAI(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/chat/completions`;
    
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
      stream: true
    };

    const response = await fetch(url, {
      method: "POST",
      headers: await this.getAuthHeaders(),
      body: JSON.stringify(body)
    });

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
          
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            // Standard content delta
            const chunk = delta?.content ?? delta?.reasoning_content ?? "";
            if (chunk) yield chunk;
          } catch {
            // Ignore parse errors for malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Anthropic API completion
   */
  private async completeAnthropic(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/messages`;
    
    // Convert messages to Anthropic format
    const systemMessage = request.messages.find(m => m.role === "system");
    const otherMessages = request.messages.filter(m => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    // Anthropic: prefer OAuth bearer when provided (Console OAuth), else x-api-key.
    const anthropicHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers || {})
    };
    if (this.config.oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      anthropicHeaders["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
    } else {
      anthropicHeaders["x-api-key"] = this.config.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body)
    });

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
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      }
    };
  }

  /**
   * Anthropic streaming
   */
  private async *streamAnthropic(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/messages`;
    
    const systemMessage = request.messages.find(m => m.role === "system");
    const otherMessages = request.messages.filter(m => m.role !== "system");

    const body: any = {
      model: request.model,
      messages: otherMessages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
      stream: true
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    // Anthropic: prefer OAuth bearer when provided (Console OAuth), else x-api-key.
    const anthropicHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.config.headers || {})
    };
    if (this.config.oauth?.accessToken) {
      await this.maybeRefreshOAuth();
      anthropicHeaders["Authorization"] = `Bearer ${this.config.oauth!.accessToken}`;
    } else {
      anthropicHeaders["x-api-key"] = this.config.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body)
    });

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
          
          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta") {
              yield parsed.delta?.text || "";
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Detect provider from model name
   */
  private detectProvider(model: string): string {
    // Explicit provider set on the config wins over model-name sniffing —
    // essential for NVIDIA/Kimi/MiniMax whose models have generic names.
    const explicit = this.config.name;
    if (["nvidia", "kimi", "minimax", "groq", "openrouter", "lmstudio", "ollama"].includes(explicit)) {
      return "openai"; // all OpenAI-compatible — use the openai path
    }
    if (model.startsWith("claude-") || explicit === "anthropic") return "anthropic";
    if (model.startsWith("gemini-") || explicit === "gemini") return "gemini";
    if (model.startsWith("moonshot") || model.startsWith("kimi")) return "openai";
    if (model.startsWith("abab") || model.startsWith("MiniMax")) return "openai";
    if (model.includes("llama") || model.includes("mixtral")) return "openai";
    return "openai";
  }

  /**
   * List available models (if supported)
   */
  public async listModels(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/models`;
      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`
        }
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as Record<string, any>;
      return data.data?.map((m: any) => m.id) || [];
    } catch {
      return [];
    }
  }

  /**
   * Validate API key
   */
  public async validate(): Promise<boolean> {
    try {
      await this.complete({
        model: this.config.defaultModel || "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5
      });
      return true;
    } catch {
      return false;
    }
  }
}
