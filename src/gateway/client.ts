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

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
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
      openrouter: "https://openrouter.ai/api/v1",
      groq: "https://api.groq.com/openai/v1",
      gemini: "https://generativelanguage.googleapis.com/v1"
    };
    return urls[provider] || urls.openai;
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
    
    const body: any = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
      stream: false
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    const choice = data.choices[0];

    return {
      content: choice.message?.content || "",
      model: data.model,
      usage: data.usage,
      tool_calls: choice.message?.tool_calls
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
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`
      },
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
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01"
      },
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
    if (model.startsWith("claude-")) return "anthropic";
    if (model.startsWith("gemini-")) return "gemini";
    if (model.includes("llama") || model.includes("mixtral")) {
      // Could be Ollama or OpenRouter
      return this.config.name === "ollama" ? "ollama" : "openai";
    }
    return "openai"; // Default to OpenAI-compatible
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

      const data = await response.json();
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
