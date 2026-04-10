/**
 * ObsidianMemory - RAG-backed persistent memory using Obsidian vault
 * Maps to the SoligAgentMemory vault structure under RAG-Memory/
 *
 * Folder mapping (relative to vaultPath/RAG-Memory/):
 *   fact      → Knowledge/
 *   episode   → Sessions/
 *   skill     → Skills/
 *   note      → Logs/
 *   research  → Research/
 *   project   → Projects/
 *   user      → UserProfile/
 *   system    → System/
 */

import { readFile, writeFile, readdir, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type MemoryKind = "fact" | "episode" | "skill" | "note" | "research" | "project" | "user" | "system";

export interface MemoryRecall {
  title: string;
  content: string;
  score: number;
  kind: MemoryKind;
  path: string;
}

// Maps MemoryKind → subfolder under RAG-Memory/
const KIND_DIR: Record<MemoryKind, string> = {
  fact:     "Knowledge",
  episode:  "Sessions",
  skill:    "Skills",
  note:     "Logs",
  research: "Research",
  project:  "Projects",
  user:     "UserProfile",
  system:   "System",
};

function safeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9 _\-]/g, "_").trim();
}

export class ObsidianMemory {
  private vaultPath: string;
  /** Base path for RAG memory — vaultPath/RAG-Memory */
  private ragBase: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.ragBase = join(vaultPath, "RAG-Memory");
  }

  private dirFor(kind: MemoryKind): string {
    return join(this.ragBase, KIND_DIR[kind]);
  }

  private async ensureDir(kind: MemoryKind): Promise<string> {
    const dir = this.dirFor(kind);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Write a new memory note. Overwrites if same title exists. */
  async store(title: string, content: string, kind: MemoryKind = "note"): Promise<string> {
    const dir = await this.ensureDir(kind);
    const filename = safeFilename(title) + ".md";
    const filepath = join(dir, filename);
    const now = new Date().toISOString();
    const body = `---\ntype: ${kind}\ndate: ${now.split("T")[0]}\ncreated: ${now}\nsource: solis-agent\ntags: [memory, ${kind}]\n---\n\n# ${title}\n\n${content}\n`;
    await writeFile(filepath, body, "utf8");
    return filepath;
  }

  /** Append to an existing note (creates if missing). */
  async append(title: string, content: string, kind: MemoryKind = "note"): Promise<void> {
    const dir = await this.ensureDir(kind);
    const filepath = join(dir, safeFilename(title) + ".md");
    const ts = new Date().toISOString();
    if (!existsSync(filepath)) {
      await this.store(title, content, kind);
    } else {
      await appendFile(filepath, `\n---\n*Updated: ${ts}*\n\n${content}\n`, "utf8");
    }
  }

  /**
   * Keyword-based recall across all RAG-Memory subfolders.
   * Scores by term frequency — no external deps, Termux-native.
   */
  async recall(query: string, topK = 6): Promise<MemoryRecall[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return [];

    const results: MemoryRecall[] = [];

    for (const [kind, dir] of Object.entries(KIND_DIR) as [MemoryKind, string][]) {
      const fullDir = join(this.ragBase, dir);
      if (!existsSync(fullDir)) continue;

      const files = await readdir(fullDir).catch(() => [] as string[]);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filepath = join(fullDir, file);
        const text = await readFile(filepath, "utf8").catch(() => "");
        if (!text) continue;

        const lower = text.toLowerCase();
        const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
        if (score === 0) continue;

        // Strip YAML frontmatter for the snippet
        const bodyStart = text.indexOf("---", 3);
        const snippet = (bodyStart > 0 ? text.slice(bodyStart + 3) : text).trim().slice(0, 600);

        results.push({
          title: file.replace(".md", ""),
          content: snippet,
          score,
          kind,
          path: filepath,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** List all memory files, optionally filtered by kind. */
  async list(kind?: MemoryKind): Promise<{ file: string; kind: MemoryKind; path: string }[]> {
    const kinds = kind ? [kind] : (Object.keys(KIND_DIR) as MemoryKind[]);
    const all: { file: string; kind: MemoryKind; path: string }[] = [];

    for (const k of kinds) {
      const dir = join(this.ragBase, KIND_DIR[k]);
      if (!existsSync(dir)) continue;
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (f.endsWith(".md")) {
          all.push({ file: f.replace(".md", ""), kind: k, path: join(dir, f) });
        }
      }
    }
    return all;
  }

  /** Read a specific memory file by title + kind. */
  async read(title: string, kind: MemoryKind): Promise<string | null> {
    const filepath = join(this.dirFor(kind), safeFilename(title) + ".md");
    if (!existsSync(filepath)) return null;
    return readFile(filepath, "utf8").catch(() => null);
  }

  /** Path info for external use (sync scripts etc.) */
  get paths() {
    return {
      vault: this.vaultPath,
      ragBase: this.ragBase,
      syncScript: join(homedir(), "vault-sync.sh"),
      writeScript: join(homedir(), "solis-write-memory.sh"),
    };
  }
}
