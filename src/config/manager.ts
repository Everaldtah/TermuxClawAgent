/**
 * ConfigManager - Configuration management for TermuxAgent
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../utils/logger.js";

export const CONFIG_DIR = join(homedir(), ".termux-agent");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const MEMORY_PATH = join(CONFIG_DIR, "memory");

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

export interface LocalModelConfig {
  name: string;
  runtime: "ollama" | "lmstudio";
  model: string;
  baseUrl?: string;
  contextWindow?: number;
}

export interface ObsidianConfig {
  enabled: boolean;
  vaultPath: string;
  vaultName?: string;
  useCli?: boolean;
}

export interface AgentConfig {
  version: string;
  provider: {
    default: string;
    openai?:      ProviderConfig;
    anthropic?:   ProviderConfig;
    ollama?:      ProviderConfig;
    openrouter?:  ProviderConfig;
    nvidia?:      ProviderConfig;
    kimi?:        ProviderConfig;
    minimax?:     ProviderConfig;
    groq?:        ProviderConfig;
    gemini?:      ProviderConfig;
    deepseek?:    ProviderConfig;
    mistral?:     ProviderConfig;
    xai?:         ProviderConfig;
    together?:    ProviderConfig;
    [key: string]: ProviderConfig | string | undefined;
  };
  model: {
    default: string;
    temperature: number;
    maxTokens: number;
    topP?: number;
    /** Token budget for extended thinking (Anthropic Claude 3.5+ / 4.x). 0 = off. */
    thinkingBudget?: number;
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
  version: "1.2.0",
  provider: {
    default: "anthropic",
    anthropic: {
      name: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      defaultModel: "claude-sonnet-4-6",
    },
    openai: {
      name: "openai",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
    },
    deepseek: {
      name: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-reasoner",
    },
    mistral: {
      name: "mistral",
      apiKey: process.env.MISTRAL_API_KEY ?? "",
      baseUrl: "https://api.mistral.ai/v1",
      defaultModel: "mistral-large-latest",
    },
    xai: {
      name: "xai",
      apiKey: process.env.XAI_API_KEY ?? "",
      baseUrl: "https://api.x.ai/v1",
      defaultModel: "grok-3",
    },
    groq: {
      name: "groq",
      apiKey: process.env.GROQ_API_KEY ?? "",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "llama-3.3-70b-versatile",
    },
    openrouter: {
      name: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-sonnet-4-6",
    },
    nvidia: {
      name: "nvidia",
      apiKey: process.env.NVIDIA_API_KEY ?? "",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      defaultModel: "moonshotai/kimi-k2.5",
    },
  },
  model: {
    default: "claude-sonnet-4-6",
    temperature: 0.7,
    maxTokens: 32768,
    topP: 1.0,
    thinkingBudget: 0,
  },
  context: {
    maxMessages: 60,
    maxTokens: 40000,
    enableSummarization: true,
  },
  memory: {
    enabled: true,
    path: MEMORY_PATH,
    maxSize: 100 * 1024 * 1024,
  },
  tools: {
    enabled: ["shell", "read_file", "write_file", "run_code", "web_fetch", "web_search"],
    timeout: 30000,
  },
  ui: {
    theme: "auto",
    showTokens: true,
    compactMode: true,
  },
  localModels: [],
  obsidian: {
    enabled: false,
    vaultPath: join(homedir(), "storage", "shared", "Obsidian", "AgentVault"),
    useCli: true,
  },
  android: { enabled: true },
};

export class ConfigManager {
  private config: AgentConfig;
  private logger: Logger;
  private loaded: boolean = false;

  constructor() {
    this.config = structuredClone(DEFAULT_CONFIG);
    this.logger = new Logger("Config");
  }

  public async init(): Promise<void> {
    try {
      await mkdir(CONFIG_DIR, { recursive: true });
      await mkdir(MEMORY_PATH, { recursive: true });
      if (!existsSync(CONFIG_PATH)) {
        await this.save();
        this.logger.info(`Created config at ${CONFIG_PATH}`);
      }
    } catch (err: unknown) {
      this.logger.error(`Failed to init config: ${(err as Error).message}`);
      throw err;
    }
  }

  public async load(): Promise<AgentConfig> {
    try {
      if (!existsSync(CONFIG_PATH)) {
        this.logger.warn("Config not found, using defaults");
        await this.init();
        return this.config;
      }
      const data = await readFile(CONFIG_PATH, "utf8");
      const loaded = JSON.parse(data);
      this.config = this.deepMerge(DEFAULT_CONFIG, loaded);
      this.loaded = true;
      this.logger.debug("Config loaded successfully");
      return this.config;
    } catch (err: unknown) {
      this.logger.error(`Failed to load config: ${(err as Error).message}`);
      return this.config;
    }
  }

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

  public get<T>(key: string): T | undefined {
    const parts = key.split(".");
    let value: any = this.config;
    for (const part of parts) {
      if (value === null || value === undefined) return undefined;
      value = value[part];
    }
    return value as T;
  }

  public async set(key: string, value: any): Promise<void> {
    const parts = key.split(".");
    let target: any = this.config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in target)) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = this.parseValue(value);
    await this.save();
  }

  public getAll(): AgentConfig {
    return { ...this.config };
  }

  public getProviderConfig(providerName?: string): ProviderConfig {
    const name = providerName || this.config.provider.default;
    const raw = (this.config.provider as Record<string, ProviderConfig | string | undefined>)[name];
    const provider: ProviderConfig | undefined = typeof raw === "object" ? raw : undefined;
    if (!provider) throw new Error(`Provider '${name}' not configured`);
    return provider;
  }

  public async setProvider(name: string, config: ProviderConfig): Promise<void> {
    (this.config.provider as Record<string, ProviderConfig>)[name] = config;
    await this.save();
  }

  public async addLocalModel(model: LocalModelConfig): Promise<void> {
    const defaults: Record<LocalModelConfig["runtime"], string> = {
      ollama: "http://localhost:11434/v1",
      lmstudio: "http://localhost:1234/v1",
    };
    const entry: LocalModelConfig = { ...model, baseUrl: model.baseUrl || defaults[model.runtime] };
    this.config.localModels = this.config.localModels || [];
    const idx = this.config.localModels.findIndex(m => m.name === entry.name);
    if (idx >= 0) this.config.localModels[idx] = entry;
    else this.config.localModels.push(entry);
    await this.save();
  }

  public getLocalModels(): LocalModelConfig[] { return this.config.localModels || []; }
  public getLocalModel(name: string): LocalModelConfig | undefined {
    return (this.config.localModels || []).find(m => m.name === name);
  }
  public isLoaded(): boolean { return this.loaded; }

  private parseValue(value: string): any {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    try { return JSON.parse(value); } catch { return value; }
  }

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

  public validate(): string[] {
    const errors: string[] = [];
    const defaultProvider = this.config.provider.default;
    const providerConfig = (this.config.provider as Record<string, ProviderConfig | string | undefined>)[defaultProvider ?? ""];
    const providerObj = typeof providerConfig === "object" ? providerConfig : undefined;
    if (!providerObj?.apiKey && !providerObj?.oauth?.accessToken) {
      errors.push(`API key not set for provider: ${defaultProvider}`);
    }
    return errors;
  }
}
