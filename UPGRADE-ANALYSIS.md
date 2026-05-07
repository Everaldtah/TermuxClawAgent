# TermuxClawAgent — Full Upgrade Analysis

> Branch: `claude/analyze-module-upgrades-X2qKs`  
> Analyzed: 2026-05-07  
> Scope: reasoning power, model use, skills/tools

---

## 0. Executive Summary

| Priority | Module | Issue | Impact |
|----------|--------|-------|--------|
| 🔴 CRITICAL | `telegram-agent-bridge.mjs` | API keys hardcoded in source | Security breach |
| 🔴 CRITICAL | `src/gateway/client.ts` | Anthropic tool_calls not parsed | Tools silently broken on Claude |
| 🔴 CRITICAL | `src/gateway/client.ts` | Gemini path routes to OpenAI handler | Gemini calls fail |
| 🔴 CRITICAL | `src/runtime.ts` | `executeStream()` skips the tool loop | Streaming = no tools |
| 🟠 HIGH | `src/gateway/client.ts` | `anthropic-version: 2023-06-01` (ancient) | Missing Claude 4.x features |
| 🟠 HIGH | All | `max_tokens: 4096` default | Cuts off long reasoning chains |
| 🟠 HIGH | All | No extended thinking / reasoning budget | Weak multi-step reasoning |
| 🟠 HIGH | `src/memory/obsidian-memory.ts` | Pure keyword RAG (no TF-IDF/BM25) | Poor memory recall quality |
| 🟡 MEDIUM | `telegram-agent-bridge.mjs` | `MAX_TOOL_ROUNDS: 8` vs `runtime.ts: 20` | Agent gives up too early |
| 🟡 MEDIUM | All | No prompt caching | High cost on mobile |
| 🟡 MEDIUM | `src/tools/orchestration.ts` | `web_search` DDG-only, no fallback | Weak research capability |
| 🟡 MEDIUM | `src/runtime.ts` | `context.enableSummarization` set but never runs | Dead config |
| 🟢 LOW | `src/config/manager.ts` | Default model `gpt-4o-mini` | Should be Claude Sonnet |
| 🟢 LOW | `src/tools/android.ts` | Missing 6 Termux:API tools | Limited device control |

---

## 1. 🔴 Critical Fixes

### 1.1 Hardcoded API Keys — `telegram-agent-bridge.mjs:19-20`

```js
// CURRENT (dangerous)
const TELEGRAM_TOKEN = "8661280273:AAF...";
const NVIDIA_API_KEY = "nvapi-QOi...";
```

Both tokens are committed to git history. Anyone with repo access can use them.

**Fix:** Replace with environment variables, add a `.env` loader:

```js
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? (() => { throw new Error("TELEGRAM_TOKEN not set"); })();
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ?? (() => { throw new Error("NVIDIA_API_KEY not set"); })();
```

Add `.env` to `.gitignore` and provide `.env.example`. Rotate both tokens immediately.

---

### 1.2 Anthropic Tool Calls Never Parsed — `src/gateway/client.ts:407-415`

The `completeAnthropic()` method never extracts `tool_calls` from the response:

```ts
// CURRENT — tool_calls field always undefined for Claude
return {
  content: data.content?.[0]?.text || "",
  model: data.model,
  usage: { ... },
  // ← tool_calls MISSING
};
```

Claude's API returns tool use in `content` blocks of type `"tool_use"`, not a separate `tool_calls` array. The code must map them:

```ts
// FIX
const toolUseBlocks = (data.content ?? []).filter((b: any) => b.type === "tool_use");
const toolCalls = toolUseBlocks.map((b: any) => ({
  id: b.id,
  type: "function" as const,
  function: { name: b.name, arguments: JSON.stringify(b.input) },
}));
const textContent = (data.content ?? [])
  .filter((b: any) => b.type === "text")
  .map((b: any) => b.text).join("");

return {
  content: textContent,
  model: data.model,
  usage: { ... },
  tool_calls: toolCalls.length ? toolCalls : undefined,
};
```

Also, the Anthropic request body needs `tools` and `tool_choice` added when tools are present.

---

### 1.3 Gemini Provider Broken — `src/gateway/client.ts:496-504`

`detectProvider()` correctly returns `"gemini"` for Gemini models, but `complete()` only branches on `"anthropic"` — everything else falls to `completeOpenAI()`:

```ts
// CURRENT — Gemini silently uses OpenAI path
public async complete(request: CompletionRequest): Promise<CompletionResponse> {
  const provider = this.detectProvider(request.model);
  if (provider === "anthropic") return this.completeAnthropic(request);
  return this.completeOpenAI(request);  // ← Gemini lands here with wrong URL/format
}
```

Gemini uses a completely different API format (`generateContent`, not `chat/completions`). Either:
- **Option A**: Add `completeGemini()` and `streamGemini()` methods  
- **Option B**: Route Gemini through OpenRouter (already supported) to avoid maintaining a separate adapter

---

### 1.4 Streaming Skips Tool Loop — `src/runtime.ts:297-319`

`executeStream()` makes a single LLM call and yields text chunks, but never checks for `tool_calls` in the response. This means any model that wants to call a tool during a streaming session just gets its raw tool-call JSON streamed to the user as text.

**Fix:** Run the full agentic tool loop (non-streaming) for all intermediate rounds, then stream only the final answer:

```ts
public async *executeStream(userInput: string): AsyncGenerator<string, void, unknown> {
  // Run tool rounds non-streaming first
  this.addMessage({ role: "user", content: userInput });
  // ... tool loop identical to execute() ...
  // Then stream the final answer
  const streamRequest = { ...request, stream: true, tools: undefined };
  for await (const chunk of this.gateway.completeStream(streamRequest)) {
    yield chunk;
  }
}
```

---

## 2. 🟠 Model & Reasoning Upgrades

### 2.1 Update Anthropic API Version — `src/gateway/client.ts:387`

```ts
// CURRENT
"anthropic-version": "2023-06-01"

// REQUIRED for Claude 4.x, extended thinking, prompt caching
"anthropic-version": "2024-10-22"
```

The `2023-06-01` version predates tool use, extended thinking, prompt caching betas, and Claude 3.5+. Everything Claude 4.x needs the newer version.

---

### 2.2 Add Extended Thinking (Reasoning Budget) — `src/gateway/client.ts`

Claude Opus 4.7 and Sonnet 4.6 support extended thinking — the model allocates tokens to an internal reasoning scratchpad before answering. This dramatically improves multi-step logic, math, and planning.

**Add to `CompletionRequest`:**

```ts
export interface CompletionRequest {
  // ... existing fields ...
  thinking?: { type: "enabled"; budget_tokens: number };
}
```

**Pass to Anthropic API when set:**

```ts
if (request.thinking) {
  body.thinking = request.thinking;
  body.temperature = 1; // required when thinking is enabled
}
```

**Recommended defaults:**
- Complex tasks / agent mode: `budget_tokens: 10000`  
- Quick Q&A: omit (no thinking overhead)

Add a `thinkingBudget` option to `AgentConfig.model` and surface it in the CLI.

---

### 2.3 Upgrade Default Model — `src/config/manager.ts:119-122`

```ts
// CURRENT
default: "gpt-4o-mini",  // underpowered for agent use
maxTokens: 4096,          // cuts off reasoning chains

// RECOMMENDED
default: "claude-sonnet-4-6",  // best cost/intelligence balance
maxTokens: 32768,               // allow full reasoning output
```

**Model recommendations by use case:**

| Use Case | Recommended Model | Why |
|----------|------------------|-----|
| Default / general | `claude-sonnet-4-6` | Best reasoning/cost ratio |
| Complex reasoning | `claude-opus-4-7` | Deepest thinking, extended reasoning |
| Fast responses | `claude-haiku-4-5-20251001` | Lowest latency on mobile |
| Local / offline | `ollama:llama3.2` | No API cost |
| Telegram bridge | `moonshotai/kimi-k2.5` (current) → also try `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron has stronger tool use |

---

### 2.4 Add Prompt Caching — `src/gateway/client.ts`

Anthropic prompt caching caches the system prompt and tools list, reducing costs by up to 90% on repeated calls. On a mobile device where every token costs battery and money, this is critical.

**Add `cache_control` to long system messages and tool schemas:**

```ts
// In completeAnthropic():
if (systemMessage) {
  body.system = [
    { type: "text", text: systemMessage.content, cache_control: { type: "ephemeral" } }
  ];
}
if (request.tools?.length) {
  // Mark tools list for caching — it's always the same per session
  body.tools = request.tools.map((t, i) =>
    i === request.tools!.length - 1
      ? { ...t, cache_control: { type: "ephemeral" } }
      : t
  );
}
```

Also add `"anthropic-beta": "prompt-caching-2024-07-31"` to headers.

---

### 2.5 Increase Tool Rounds in Telegram Bridge — `telegram-agent-bridge.mjs:23`

```js
// CURRENT
const MAX_TOOL_ROUNDS = 8;

// RECOMMENDED — matches runtime.ts
const MAX_TOOL_ROUNDS = 20;
```

The TypeScript runtime allows 20 rounds; the Telegram bridge gives up after 8. Complex tasks (write code, research + summarize, multi-file work) regularly need 10–15 rounds.

---

### 2.6 Add Missing Providers to Gateway

**Add to `getDefaultBaseUrl()` in `src/gateway/client.ts`:**

```ts
deepseek:  "https://api.deepseek.com/v1",   // DeepSeek R1/V3 — top reasoning model
mistral:   "https://api.mistral.ai/v1",      // Mistral Large/Small
xai:       "https://api.x.ai/v1",            // Grok 3
together:  "https://api.together.xyz/v1",    // Together AI (cheap open models)
```

**Add to `AgentConfig.provider`:**

```ts
deepseek?: ProviderConfig;  // DeepSeek R1 is one of the best reasoning models at low cost
mistral?:  ProviderConfig;
xai?:      ProviderConfig;
```

DeepSeek R1 in particular should be a first-class provider — it rivals Claude Opus at a fraction of the cost and runs via their API or locally via Ollama.

---

## 3. 🟡 Memory & RAG Upgrades

### 3.1 Better RAG Scoring — `src/memory/obsidian-memory.ts:113`

Current recall scores by raw term count. This over-weights long documents and ignores term rarity.

```ts
// CURRENT — raw count, biased toward long files
const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
```

**Upgrade to BM25-style scoring:**

```ts
function bm25Score(termFreqs: number[], docLen: number, avgDocLen: number, k1 = 1.5, b = 0.75): number {
  return termFreqs.reduce((s, tf) => {
    const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
    return s + norm;
  }, 0);
}
```

This normalises by document length and improves recall precision with no external dependencies.

---

### 3.2 Increase Memory Snippet Size

| Location | Current | Recommended | File |
|----------|---------|-------------|------|
| RAG recall snippet | 600 chars | 1200 chars | `obsidian-memory.ts:117` |
| RAG context per hit | 220 chars | 450 chars | `token-optimizer.ts:103` |
| User profile preload | 800 chars | 2000 chars | `runtime.ts:155` |
| Last session preload | 600 chars | 1200 chars | `runtime.ts:168` |
| Tool output max | 800 chars | 2000 chars | `token-optimizer.ts:23` |

Snippets at 220–600 chars are often too short to convey the context of a memory note. At `maxTokens: 32768`, the model can easily absorb 3–4x more.

---

### 3.3 Implement Context Summarization — `src/runtime.ts`

`AgentConfig.context.enableSummarization` is `true` by default but `trimContext()` never runs a summarization pass — it only drops messages. This means long sessions lose older context silently.

**Implement a summarization sweep:**

```ts
private async summarizeOldContext(): Promise<void> {
  if (!this.config.get("context.enableSummarization")) return;
  const messages = this.context.messages.filter(m => m.role !== "system");
  if (messages.length < 20) return;

  const toSummarize = messages.slice(0, -10); // keep last 10 intact
  const summaryRequest: CompletionRequest = {
    model: this.context.model,
    messages: [
      { role: "system", content: "Summarize the following conversation concisely, preserving all key facts, decisions, and action items. Output only the summary." },
      { role: "user", content: toSummarize.map(m => `${m.role}: ${m.content}`).join("\n\n") },
    ],
    max_tokens: 1024,
  };
  const summary = await this.gateway.complete(summaryRequest);
  const systemMsgs = this.context.messages.filter(m => m.role === "system");
  const recentMsgs = this.context.messages.filter(m => m.role !== "system").slice(-10);
  this.context.messages = [
    ...systemMsgs,
    { role: "system", content: `[Conversation summary]\n${summary.content}` },
    ...recentMsgs,
  ];
}
```

Call this from `trimContext()` when message count exceeds threshold.

---

### 3.4 Memory Deduplication

When the agent stores the same fact multiple times (e.g., user name across sessions), the vault grows with duplicates that dilute recall scores. Add a deduplication check:

```ts
async store(title: string, content: string, kind: MemoryKind = "note"): Promise<string> {
  const existing = await this.read(title, kind);
  if (existing) {
    // Append instead of overwrite so history is preserved
    return this.append(title, content, kind).then(() => join(this.dirFor(kind), safeFilename(title) + ".md"));
  }
  // ... existing store logic
}
```

---

## 4. 🟡 Skills / Tool Upgrades

### 4.1 Web Search — Real SERP Fallback — `src/tools/orchestration.ts:378`

DuckDuckGo Instant Answer API only returns top-level answers and related topics. For research queries it often returns nothing useful.

**Add a real SERP scraping fallback:**

```ts
// After DDG instant answer returns 0 results:
if (results.length === 0) {
  // Fetch DDG HTML search results page and extract links
  const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) ..." }
  });
  const html = await htmlRes.text();
  // Extract result titles/URLs/snippets from HTML
  // (parse .result__a and .result__snippet elements)
}
```

Also consider adding **Brave Search API** (free tier: 2000 queries/month) as a higher-quality alternative.

---

### 4.2 Add `http_post` / `http_request` Tool

The Telegram bridge has `http_get` but the TypeScript registry's `fetch` tool only does GET/POST without headers, auth, or body control. Add a general HTTP request tool:

```ts
{
  name: "http_request",
  description: "Make an HTTP request with full control over method, headers, and body.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      headers: { type: "object" },
      body: { type: "string" },
      json: { type: "object", description: "JSON body (sets Content-Type automatically)" },
    },
    required: ["url"],
  },
}
```

---

### 4.3 Add `android_dialog` Tool — `src/tools/android.ts`

`termux-dialog` lets the agent show interactive UI dialogs on the Android screen (text input, confirmation, date picker, radio buttons, checkboxes). This enables the agent to ask the user for input without going through Telegram.

```ts
t("android_dialog", "Show an interactive dialog on the Android screen.",
  {
    type: "object",
    properties: {
      widget: { type: "string", enum: ["text", "confirm", "date", "radio", "checkbox", "spinner"] },
      title: { type: "string" },
      hint: { type: "string" },
      values: { type: "string", description: "Comma-separated values for radio/checkbox/spinner" },
    },
    required: ["widget"],
  },
  async (a) => run("termux-dialog", [a.widget,
    ...(a.title ? ["-t", a.title] : []),
    ...(a.hint  ? ["-i", a.hint]  : []),
    ...(a.values? ["-v", a.values]: []),
  ])),
```

---

### 4.4 Add Missing Termux:API Tools — `src/tools/android.ts`

| Tool | Termux Command | Use Case |
|------|---------------|----------|
| `android_microphone` | `termux-microphone-record` | Voice memo recording |
| `android_telephony_info` | `termux-telephony-deviceinfo` | Carrier, IMEI, network type |
| `android_cell_info` | `termux-telephony-cellinfo` | Cell tower data |
| `android_media_scan` | `termux-media-scan` | Refresh media library |
| `android_torch` | `termux-torch` | Toggle flashlight |
| `android_usb_info` | (via `lsusb`) | USB device detection |

---

### 4.5 Add `image_analyze` Tool

The agent can take photos with `android_camera_photo` but cannot interpret them — there's no vision call tool. Add:

```ts
{
  name: "image_analyze",
  description: "Analyze an image file using a vision-capable LLM. Returns a description of the image contents.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to image file (jpg/png/webp)" },
      question: { type: "string", description: "What to look for or ask about the image." },
    },
    required: ["path"],
  },
  handler: async (args) => {
    // base64-encode the image, send to vision endpoint
    const imgB64 = readFileSync(args.path).toString("base64");
    const ext = args.path.split(".").pop()?.toLowerCase();
    const mime = ext === "png" ? "image/png" : "image/jpeg";
    // Call via gateway with image_url content block (OpenAI / Claude vision format)
  }
}
```

Works with Claude claude-sonnet-4-6 (native vision) and GPT-4o.

---

### 4.6 Add `pdf_read` Tool

Many documents the agent fetches or receives are PDFs. Add a lightweight reader using `pdftotext` (available via `pkg install poppler` in Termux):

```ts
{
  name: "pdf_read",
  description: "Extract text from a PDF file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      pages: { type: "string", description: "Page range, e.g. '1-5' (omit for all)" },
    },
    required: ["path"],
  },
  handler: async (a) => {
    const args = [a.path, "-"];
    if (a.pages) args.unshift("-f", a.pages.split("-")[0], "-l", a.pages.split("-")[1] ?? a.pages.split("-")[0]);
    const { stdout } = await execFileAsync("pdftotext", args, { encoding: "utf8" });
    return { text: stdout.slice(0, 20000), truncated: stdout.length > 20000 };
  }
}
```

---

### 4.7 Parallel Tool Execution — `src/runtime.ts:270-278`

Currently tool calls in the same round are executed sequentially:

```ts
// CURRENT — sequential, slow
for (const call of response.tool_calls) {
  const result = await this.tools.execute(call);
  ...
}
```

When the model requests multiple tools in one round (e.g., `web_fetch` + `memory_recall`), they block each other. Run them in parallel:

```ts
// FIX — parallel execution
const results = await Promise.all(
  response.tool_calls.map(async (call) => {
    this.logger.info(`Tool call [${round + 1}]: ${call.function.name}`);
    try {
      const result = await this.tools.execute(call);
      return { call, result, error: null };
    } catch (err: any) {
      return { call, result: null, error: err.message };
    }
  })
);
for (const { call, result, error } of results) {
  const content = error ? JSON.stringify({ error }) : JSON.stringify(result!.output);
  this.addMessage({ role: "tool", content, name: call.function.name });
}
```

---

### 4.8 Upgrade `cron_add` to Support Real Cron Expressions — `src/tools/orchestration.ts:202`

Currently only `"every Xm/Xh/Xd"` is supported. Add standard 5-field cron parsing (`"0 9 * * 1"` = every Monday at 9am) using a small parser (no deps needed):

```ts
// Add alongside parseIntervalMs():
function parseCronMs(schedule: string): number | null {
  // Use node-cron or a tiny inline parser for "0 9 * * 1" format
  // Return ms until next trigger, or null if not a cron expression
}
```

---

## 5. 🟢 Low-Priority / Quality of Life

### 5.1 Token Budget Display in CLI — `src/chat/session.ts:232`

When `showTokens` is on, the display shows message count and elapsed time but not token count:

```ts
// CURRENT
console.log(`[${context.messages.length} msgs | ${elapsed}ms]`);

// RECOMMENDED
const tokenEst = TokenOptimizer.estimateMessages(context.messages);
console.log(`[${context.messages.length} msgs | ~${tokenEst} tokens | ${elapsed}ms]`);
```

---

### 5.2 Telegram Bridge: Show Thinking Summary

The bridge enables Kimi-K2.5 thinking mode (`chat_template_kwargs: { thinking: true }`) but discards the thinking content. Surface a collapsed version in the live stream:

```js
// After model responds with reasoning:
const thinking = msg?.reasoning_content ?? msg?.reasoning ?? "";
if (thinking) {
  const snippet = thinking.slice(0, 200).replace(/\n/g, " ");
  await stream.push(`💭 ${snippet}…`);
}
```

---

### 5.3 `MemoryStore` — Add Semantic Session ID — `src/memory/store.ts`

`MemoryEntry.session` field exists but is never set. Populate it from a session ID passed from `AgentRuntime` so queries like `memory.query({ session: currentId })` actually work.

---

### 5.4 TypeScript Strict Mode — `tsconfig.json`

```json
{
  "compilerOptions": {
    "strict": true,        // enables strictNullChecks, noImplicitAny, etc.
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Several runtime crashes (e.g., `data.choices?.[0]` returning undefined) would be caught at compile time.

---

### 5.5 Remove `keytar` Optional Dependency — `package.json:46`

`keytar` is a native addon for macOS/Linux keychain. It doesn't build on Termux/Android and is never referenced in the codebase. Remove it to eliminate the build warning:

```json
// DELETE from package.json
"optionalDependencies": {
  "keytar": "^7.9.0"
}
```

---

## 6. Recommended Implementation Order

```
Phase 1 — Security & Correctness (do immediately)
  1. Move API keys to env vars (telegram-agent-bridge.mjs)
  2. Fix Anthropic tool_calls parsing (gateway/client.ts)
  3. Fix executeStream tool loop (runtime.ts)
  4. Fix Gemini routing or remove/delegate to OpenRouter

Phase 2 — Reasoning Power
  5. Update anthropic-version to 2024-10-22
  6. Add extended thinking support (budget_tokens)
  7. Add prompt caching for Anthropic
  8. Upgrade default model to claude-sonnet-4-6, maxTokens to 32768
  9. Increase MAX_TOOL_ROUNDS in telegram bridge to 20
  10. Implement context summarization

Phase 3 — Memory Quality
  11. BM25 scoring in ObsidianMemory.recall()
  12. Increase snippet sizes across all recall paths
  13. Add memory deduplication
  14. Populate session IDs in MemoryStore

Phase 4 — Skills & Tools
  15. web_search SERP fallback
  16. http_request tool (POST/PUT/PATCH/DELETE + headers)
  17. android_dialog tool
  18. Missing Termux:API tools (mic, torch, telephony, media scan)
  19. image_analyze vision tool
  20. pdf_read tool
  21. Parallel tool execution in runtime.ts

Phase 5 — Quality
  22. Real cron expressions in cron_add
  23. TypeScript strict mode
  24. Token display in CLI
  25. Remove keytar dependency
  26. Add DeepSeek / Mistral / xAI providers
```

---

## 7. Quick Wins (< 30 min each)

These changes have outsized impact for minimal effort:

1. **`telegram-agent-bridge.mjs:23`** — Change `MAX_TOOL_ROUNDS = 8` → `20`
2. **`src/gateway/client.ts:387`** — Change `anthropic-version` to `"2024-10-22"`
3. **`src/config/manager.ts:121`** — Change `maxTokens: 4096` → `32768`
4. **`src/utils/token-optimizer.ts:23`** — Change `TOOL_OUTPUT_MAX = 800` → `2000`
5. **`src/memory/obsidian-memory.ts:117`** — Change snippet `.slice(0, 600)` → `.slice(0, 1200)`
6. **`src/utils/token-optimizer.ts:103`** — Change RAG snippet `.slice(0, 220)` → `.slice(0, 450)`
7. **`telegram-agent-bridge.mjs:19-20`** — Env vars for API keys
8. **`src/config/manager.ts:119`** — Change default model to `"claude-sonnet-4-6"`
