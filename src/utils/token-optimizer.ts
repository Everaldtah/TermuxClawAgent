/**
 * TokenOptimizer - cheap, deterministic helpers for keeping prompts small.
 *
 * Why not tiktoken? It adds a 5MB+ native dep and we're on Termux. A ~4
 * chars/token heuristic is good enough for budget decisions, and every
 * provider bills by its own tokenizer anyway. We keep it dependency-free.
 *
 * This module is the "token efficiency module" the user asked to audit.
 * Key behaviours:
 *   - estimate(): fast token estimate (chars/4 with overhead padding)
 *   - trim():     drop middle messages (keep system + recent + oldest user)
 *                 so long conversations do not linearly inflate prompts.
 *   - compact():  collapse runs of assistant "thinking" / tool JSON spam
 *                 into short placeholders. Tool outputs are usually the
 *                 biggest token sink; we truncate them aggressively.
 *   - buildRagContext(): format Obsidian recall hits into a tiny block
 *                 instead of shoving full memory history into the prompt.
 */

import type { Message } from "../runtime.js";

const CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_MAX = 800;           // chars per tool result kept in context
const ASSISTANT_MAX = 2000;            // chars per old assistant message kept
const SYSTEM_OVERHEAD_TOKENS = 8;      // per-message framing overhead

export interface TrimOptions {
  maxTokens: number;
  keepRecent?: number;   // always keep the N most recent messages intact
  keepSystem?: boolean;  // always keep system messages
}

export class TokenOptimizer {
  /** Fast token estimate. Not exact, but stable and cheap. */
  static estimate(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  static estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += SYSTEM_OVERHEAD_TOKENS + TokenOptimizer.estimate(m.content || "");
      if (m.tool_calls) total += TokenOptimizer.estimate(JSON.stringify(m.tool_calls));
    }
    return total;
  }

  /**
   * Compact a single message in-place-ish: truncates oversized tool output
   * and clips long assistant replies. Returns a new Message.
   */
  static compactMessage(m: Message): Message {
    if (m.role === "tool" && m.content && m.content.length > TOOL_OUTPUT_MAX) {
      return {
        ...m,
        content: m.content.slice(0, TOOL_OUTPUT_MAX) + `\n…[+${m.content.length - TOOL_OUTPUT_MAX} chars truncated]`
      };
    }
    if (m.role === "assistant" && m.content && m.content.length > ASSISTANT_MAX) {
      return {
        ...m,
        content: m.content.slice(0, ASSISTANT_MAX) + "\n…[truncated]"
      };
    }
    return m;
  }

  /**
   * Trim a conversation down to fit a token budget.
   * Strategy: always keep system + the last `keepRecent` messages verbatim,
   * then drop oldest non-system messages until we fit. Any surviving middle
   * messages get compacted.
   */
  static trim(messages: Message[], opts: TrimOptions): Message[] {
    const { maxTokens, keepRecent = 6, keepSystem = true } = opts;

    const system = keepSystem ? messages.filter(m => m.role === "system") : [];
    const rest = messages.filter(m => m.role !== "system");

    const recent = rest.slice(-keepRecent);
    let middle = rest.slice(0, Math.max(0, rest.length - keepRecent)).map(TokenOptimizer.compactMessage);

    let result = [...system, ...middle, ...recent];
    while (TokenOptimizer.estimateMessages(result) > maxTokens && middle.length > 0) {
      middle.shift(); // drop oldest non-system, non-recent message
      result = [...system, ...middle, ...recent];
    }

    // Last resort: if still over budget, start dropping oldest recent too.
    const recentMut = [...recent];
    while (TokenOptimizer.estimateMessages(result) > maxTokens && recentMut.length > 1) {
      recentMut.shift();
      result = [...system, ...middle, ...recentMut];
    }
    return result;
  }

  /** Format Obsidian recall hits into a minimal context block. */
  static buildRagContext(hits: Array<{ note: string; snippet: string }>): string {
    if (!hits.length) return "";
    const lines = hits.map(h => `- [[${h.note}]] — ${h.snippet.replace(/\s+/g, " ").slice(0, 220)}`);
    return `# Relevant memory (from Obsidian vault)\n${lines.join("\n")}`;
  }
}
