/**
 * TermuxAgent - Main exports
 * Token-optimized AI agent for Android/Termux
 */

// Core runtime
export { AgentRuntime, RuntimeOptions, Message, AgentContext } from "./runtime.js";

// Configuration
export { ConfigManager, AgentConfig, ProviderConfig, CONFIG_DIR, CONFIG_PATH } from "./config/manager.js";

// Gateway
export { GatewayClient, CompletionRequest, CompletionResponse, CompletionMessage, ToolCall } from "./gateway/client.js";

// Chat
export { ChatSession, ChatOptions } from "./chat/session.js";

// Memory
export { MemoryStore, MemoryEntry, MemoryQuery } from "./memory/store.js";
export { ObsidianMemory, MemoryKind, MemoryRecall } from "./memory/obsidian-memory.js";

// Tools
export { ToolRegistry, ToolCall, ToolResult, ToolDefinition } from "./tools/registry.js";
export { getAndroidTools } from "./tools/android.js";
export { ObsidianClient, ObsidianOptions, getObsidianTools } from "./tools/obsidian.js";

// Utils
export { Logger, LogLevel, logger } from "./utils/logger.js";
export { TokenOptimizer } from "./utils/token-optimizer.js";

// Version
export const VERSION = "1.0.0";
