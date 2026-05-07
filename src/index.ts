/**
 * TermuxClawAgent - Main exports
 * OpenClaw-powered AI agent for Android/Termux
 */

// Core runtime
export { AgentRuntime } from "./runtime.js";
export type { RuntimeOptions, Message, AgentContext } from "./runtime.js";

// Configuration
export { ConfigManager, CONFIG_DIR, CONFIG_PATH } from "./config/manager.js";
export type { AgentConfig, ProviderConfig } from "./config/manager.js";

// Gateway
export { GatewayClient } from "./gateway/client.js";
export type { CompletionRequest, CompletionResponse, CompletionMessage, ToolCall } from "./gateway/client.js";

// Chat
export { ChatSession } from "./chat/session.js";
export type { ChatOptions } from "./chat/session.js";

// Memory
export { MemoryStore } from "./memory/store.js";
export type { MemoryEntry, MemoryQuery } from "./memory/store.js";
export { ObsidianMemory } from "./memory/obsidian-memory.js";
export type { MemoryKind, MemoryRecall } from "./memory/obsidian-memory.js";

// Tools
export { ToolRegistry } from "./tools/registry.js";
export type { ToolDefinition, ToolResult } from "./tools/registry.js";
export { getAndroidTools } from "./tools/android.js";
export { getObsidianTools } from "./tools/obsidian.js";
export type { ObsidianOptions } from "./tools/obsidian.js";
export {
  getOrchestrationTools,
  getUpdatePlanTool,
  getShowPlanTool,
  getTaskTools,
  getCronTools,
  getWebFetchTool,
  getWebSearchTool,
  getHttpRequestTool,
  getSpawnAgentTool,
  getMemoryTools,
} from "./tools/orchestration.js";

// Utils
export { Logger } from "./utils/logger.js";
export type { LogLevel } from "./utils/logger.js";
export { TokenOptimizer } from "./utils/token-optimizer.js";

// Version
export const VERSION = "1.2.0";
