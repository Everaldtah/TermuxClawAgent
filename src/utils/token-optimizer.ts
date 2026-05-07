/**
 * TokenOptimizer - cheap, deterministic helpers for keeping prompts small.
 *
 * Uses a ~4 chars/token heuristic — no external deps, Termux-native.
 * Raised limits across the board to match modern 32k+ context windows while
 * still protecting against runaway token consumption on mobile.
 */

import type { Message } from "../runtime.js";

const CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_MAX = 2000;          // chars per tool result kept in context
const ASSISTANT_MAX = 4000;            // chars per old assistant message kept
const SYSTEM_OVERHEAD_TOKENS = 8;      // per-message framing overhead
const RAG_SNIPPET_MAX = 450;           // chars per RAG hit in the context block

export interface TrimOptions {
  maxTokens: number;
  keepRecent?: number;
  keepSystem?: boolean;
}

export class TokenOptimizer {
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

  static compactMessage(m: Message): Message {
    if (m.role === "tool" && m.content && m.content.length > TOOL_OUTPUT_MAX) {
      return {
        ...m,
        content: m.content.slice(0, TOOL_OUTPUT_MAX) +
          `\n…[+${m.content.length - TOOL_OUTPUT_MAX} chars truncated]`,
      };
    }
    if (m.role === "assistant" && m.content && m.content.length > ASSISTANT_MAX) {
      return { ...m, content: m.content.slice(0, ASSISTANT_MAX) + "\n…[truncated]" };
    }
    return m;
  }

  /**
   * Trim a conversation to fit a token budget.
   * Strategy: always keep system + the last `keepRecent` messages verbatim,
   * compact middle messages, then drop oldest middle until budget fits.
   */
  static trim(messages: Message[], opts: TrimOptions): Message[] {
    const { maxTokens, keepRecent = 10, keepSystem = true } = opts;

    const system = keepSystem ? messages.filter(m => m.role === "system") : [];
    const rest = messages.filter(m => m.role !== "system");

    const recent = rest.slice(-keepRecent);
    let middle = rest.slice(0, Math.max(0, rest.length - keepRecent)).map(TokenOptimizer.compactMessage);

    let result = [...system, ...middle, ...recent];
    while (TokenOptimizer.estimateMessages(result) > maxTokens && middle.length > 0) {
      middle.shift();
      result = [...system, ...middle, ...recent];
    }

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
    const lines = hits.map(h =>
      `- [[${h.note}]] — ${h.snippet.replace(/\s+/g, " ").slice(0, RAG_SNIPPET_MAX)}`,
    );
    return `# Relevant memory (from Obsidian vault)\n${lines.join("\n")}`;
  }
}
