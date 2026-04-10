/**
 * ConfigManager - Configuration management for TermuxAgent
 * Token-optimized, file-based configuration
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../utils/logger.js";

export const CONFIG_DIR = join(homedir(), ".termux-agent");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const MEMORY_PATH = join(CONFIG_DIR, "memory");

/**
 * OAuth credentials for providers that support user-authorized flows
 * (e.g. Anthropic Console OAuth, Google/Gemini OAuth). When present,
 * the gateway prefers `accessToken` over `apiKey` and will refresh
 * via `tokenUrl` + `refreshToken` before expiry.
 */
export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenUrl?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** Optional OAuth credentials; take precedence over apiKey when present. */
  oauth?: OAuthConfig;
  /** Extra headers (e.g. NVIDIA NIM org id, MiniMax GroupId). */
  headers?: Record<string, string>;
}

/**
 * A locally-hosted model registered via Ollama or LM Studio running
 * inside Termux. The agent speaks to both over their OpenAI-compatible
 * HTTP APIs — no API key required.
 */
export interface LocalModelConfig {
  name: string;                          // friendly id used by the agent
  runtime: "ollama" | "lmstudio";        // which local backend
  model: string;                         // model id as known to the backend
  baseUrl?: string;                      // default: ollama=11434, lmstudio=1234
  contextWindow?: number;
}

export interface ObsidianConfig {
  enabled: boolean;
  vaultPath: string;                     // absolute path to the vault
  vaultName?: string;
  useCli?: boolean;                      // try obsidian-cli if available
}

export interface AgentConfig {
  version: string;
  provider: {
    default: string;
    openai?: ProviderConfig;
    anthropic?: ProviderConfig;
    ollama?: ProviderConfig;
    openrouter?: ProviderConfig;
    nvidia?: ProviderConfig;
    kimi?: ProviderConfig;      // Moonshot Kimi
    minimax?: ProviderConfig;
    groq?: ProviderConfig;
    gemini?: ProviderConfig;
    [key: string]: ProviderConfig | string | undefined;
  };
  model: {
    default: string;
    temperature: number;
    maxTokens: number;
    topP?: number;
  };
  context: {
    maxMessages: number;
    maxTokens: number;
    enableSummarization: boolean;
  };
  memory: {
    enabled: boolean;
    path: string;
    maxSize: number;
  };
  tools: {
    enabled: string[];
    timeout: number;
  };
  ui: {
    theme: "auto" | "dark" | "light";
    showTokens: boolean;
    compactMode: boolean;
  };
  localModels?: LocalModelConfig[];
  obsidian?: ObsidianConfig;
  android?: { enabled: boolean };
}

const DEFAULT_CONFIG: AgentConfig = {
  version: "1.0.0",
  provider: {
    default: "openai",
    openai: {
      name: "openai",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini"
    }
  },
  model: {
    default: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1.0
  },
  context: {
    maxMessages: 50,
    maxTokens: 8000,
    enableSummarization: true
  },
  memory: {
    enabled: true,
    path: MEMORY_PATH,
    maxSize: 100 * 1024 * 1024 // 100MB
  },
  tools: {
    enabled: ["shell", "file", "code"],
    timeout: 30000
  },
  ui: {
    theme: "auto",
    showTokens: false,
    compactMode: true
  },
  localModels: [
    // Example entries — users override via `tagent config set`.
    // { name: "llama3-local", runtime: "ollama",   model: "llama3", baseUrl: "http://localhost:11434/v1" },
    // { name: "qwen-lmstudio", runtime: "lmstudio", model: "qwen2.5-7b-instruct", baseUrl: "http://localhost:1234/v1" }
  ],
  obsidian: {
    enabled: false,
    vaultPath: join(homedir(), "storage", "shared", "Obsidian", "AgentVault"),
    useCli: true
  },
  android: { enabled: true }
};

/**
 * Configuration manager with file persistence
 */
export class ConfigManager {
  private config: AgentConfig;
  private logger: Logger;
  private loaded: boolean = false;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.logger = new Logger("Config");
  }

  /**
   * Initialize config directory and file
   */
  public async init(): Promise<void> {
    try {
      // Create config directory
      await mkdir(CONFIG_DIR, { recursive: true });
      await mkdir(MEMORY_PATH, { recursive: true });

      // Write default config if not exists
      if (!existsSync(CONFIG_PATH)) {
        await this.save();
        this.logger.info(`Created config at ${CONFIG_PATH}`);
      }
    } catch (err: unknown) {
      this.logger.error(`Failed to init config: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Load configuration from file
   */
  public async load(): Promise<AgentConfig> {
    try {
      if (!existsSync(CONFIG_PATH)) {
        this.logger.warn("Config not found, using defaults");
        await this.init();
        return this.config;
      }

      const data = await readFile(CONFIG_PATH, "utf8");
      const loaded = JSON.parse(data);
      
      // Merge with defaults for any missing fields
      this.config = this.deepMerge(DEFAULT_CONFIG, loaded);
      this.loaded = true;
      
      this.logger.debug("Config loaded successfully");
      return this.config;
    } catch (err: unknown) {
      this.logger.error(`Failed to load config: ${(err as Error).message}`);
      return this.config;
    }
  }

  /**
   * Save configuration to file
   */
  public async save(): Promise<void> {
    try {
      await mkdir(dirname(CONFIG_PATH), { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(this.config, null, 2), "utf8");
      this.logger.debug("Config saved");
    } catch (err: unknown) {
      this.logger.error(`Failed to save config: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Get a configuration value by key path
   */
  public get<T>(key: string): T | undefined {
    const parts = key.split(".");
    let value: any = this.config;
    
    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[part];
    }
    
    return value as T;
  }

  /**
   * Set a configuration value by key path
   */
  public async set(key: string, value: any): Promise<void> {
    const parts = key.split(".");
    let target: any = this.config;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in target)) {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }
    
    target[parts[parts.length - 1]] = this.parseValue(value);
    await this.save();
  }

  /**
   * Get all configuration
   */
  public getAll(): AgentConfig {
    return { ...this.config };
  }

  /**
   * Get provider configuration
   */
  public getProviderConfig(providerName?: string): ProviderConfig {
    const name = providerName || this.config.provider.default;
    const raw = (this.config.provider as Record<string, ProviderConfig | string | undefined>)[name];
    const provider: ProviderConfig | undefined = typeof raw === "object" ? raw : undefined;

    if (!provider) {
      throw new Error(`Provider '${name}' not configured`);
    }

    return provider;
  }

  /**
   * Add or update a provider
   */
  public async setProvider(name: string, config: ProviderConfig): Promise<void> {
    (this.config.provider as Record<string, ProviderConfig>)[name] = config;
    await this.save();
  }

  /**
   * Register (or update) a locally-hosted model. These are reachable
   * inside Termux via Ollama (`pkg install ollama`) or LM Studio's CLI
   * (`lms server start`). Both expose an OpenAI-compatible endpoint so
   * the existing GatewayClient can talk to them with no changes.
   */
  public async addLocalModel(model: LocalModelConfig): Promise<void> {
    const defaults: Record<LocalModelConfig["runtime"], string> = {
      ollama: "http://localhost:11434/v1",
      lmstudio: "http://localhost:1234/v1"
    };
    const entry: LocalModelConfig = {
      ...model,
      baseUrl: model.baseUrl || defaults[model.runtime]
    };
    this.config.localModels = this.config.localModels || [];
    const idx = this.config.localModels.findIndex(m => m.name === entry.name);
    if (idx >= 0) this.config.localModels[idx] = entry;
    else this.config.localModels.push(entry);
    await this.save();
  }

  public getLocalModels(): LocalModelConfig[] {
    return this.config.localModels || [];
  }

  public getLocalModel(name: string): LocalModelConfig | undefined {
    return (this.config.localModels || []).find(m => m.name === name);
  }

  /**
   * Check if config is loaded
   */
  public isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Parse string value to appropriate type
   */
  private parseValue(value: string): any {
    // Try boolean
    if (value === "true") return true;
    if (value === "false") return false;
    
    // Try number
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    
    // Try JSON
    try {
      return JSON.parse(value);
    } catch {
      // Return as string
      return value;
    }
  }

  /**
   * Deep merge objects
   */
  private deepMerge<T extends Record<string, any>>(target: T, source: any): T {
    const result: any = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  /**
   * Validate configuration
   */
  public validate(): string[] {
    const errors: string[] = [];
    
    // Check required fields
    const defaultProvider = this.config.provider.default;
    const providerConfig = (this.config.provider as Record<string, ProviderConfig | string | undefined>)[defaultProvider ?? ""];
    const providerObj = typeof providerConfig === "object" ? providerConfig : undefined;

    if (!providerObj?.apiKey) {
      errors.push(`API key not set for provider: ${defaultProvider}`);
    }
    
    return errors;
  }
}
