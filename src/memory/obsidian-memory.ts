/**
 * ObsidianMemory - RAG-backed persistent memory using Obsidian vault
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
 *
 * Recall uses BM25-style scoring (normalised by document length) which
 * gives much better precision than raw term-count for large vaults.
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

/**
 * BM25 relevance scoring.
 * k1=1.5, b=0.75 are standard defaults.
 */
function bm25Score(
  terms: string[],
  text: string,
  docLen: number,
  avgDocLen: number,
  k1 = 1.5,
  b = 0.75,
): number {
  if (docLen === 0 || avgDocLen === 0) return 0;
  let score = 0;
  for (const term of terms) {
    const tf = (text.split(term).length - 1);
    if (tf === 0) continue;
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)));
    score += norm;
  }
  return score;
}

export class ObsidianMemory {
  private vaultPath: string;
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

  /**
   * Write a memory note. If a note with the same title+kind already exists,
   * appends new content instead of overwriting (deduplication).
   */
  async store(title: string, content: string, kind: MemoryKind = "note"): Promise<string> {
    const dir = await this.ensureDir(kind);
    const filepath = join(dir, safeFilename(title) + ".md");

    if (existsSync(filepath)) {
      // Dedup: don't overwrite — append so history is preserved
      await this.append(title, content, kind);
      return filepath;
    }

    const now = new Date().toISOString();
    const body =
      `---\ntype: ${kind}\ndate: ${now.split("T")[0]}\ncreated: ${now}\nsource: solis-agent\ntags: [memory, ${kind}]\n---\n\n# ${title}\n\n${content}\n`;
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
   * BM25-scored recall across all RAG-Memory subfolders.
   * Scores are normalised by document length so short notes aren't penalised.
   */
  async recall(query: string, topK = 6): Promise<MemoryRecall[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return [];

    // First pass: collect all docs and compute average length
    interface DocEntry {
      kind: MemoryKind;
      filepath: string;
      file: string;
      text: string;
      lower: string;
    }
    const docs: DocEntry[] = [];

    for (const [kind, dir] of Object.entries(KIND_DIR) as [MemoryKind, string][]) {
      const fullDir = join(this.ragBase, dir);
      if (!existsSync(fullDir)) continue;
      const files = await readdir(fullDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filepath = join(fullDir, file);
        const text = await readFile(filepath, "utf8").catch(() => "");
        if (!text) continue;
        docs.push({ kind, filepath, file, text, lower: text.toLowerCase() });
      }
    }

    if (docs.length === 0) return [];
    const avgLen = docs.reduce((s, d) => s + d.lower.length, 0) / docs.length;

    // Second pass: BM25 score each doc
    const results: MemoryRecall[] = [];
    for (const doc of docs) {
      const score = bm25Score(terms, doc.lower, doc.lower.length, avgLen);
      if (score === 0) continue;

      const bodyStart = doc.text.indexOf("---", 3);
      const snippet = (bodyStart > 0 ? doc.text.slice(bodyStart + 3) : doc.text)
        .trim()
        .slice(0, 1200);

      results.push({
        title: doc.file.replace(".md", ""),
        content: snippet,
        score,
        kind: doc.kind,
        path: doc.filepath,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async list(kind?: MemoryKind): Promise<{ file: string; kind: MemoryKind; path: string }[]> {
    const kinds = kind ? [kind] : (Object.keys(KIND_DIR) as MemoryKind[]);
    const all: { file: string; kind: MemoryKind; path: string }[] = [];
    for (const k of kinds) {
      const dir = join(this.ragBase, KIND_DIR[k]);
      if (!existsSync(dir)) continue;
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (f.endsWith(".md")) all.push({ file: f.replace(".md", ""), kind: k, path: join(dir, f) });
      }
    }
    return all;
  }

  async read(title: string, kind: MemoryKind): Promise<string | null> {
    const filepath = join(this.dirFor(kind), safeFilename(title) + ".md");
    if (!existsSync(filepath)) return null;
    return readFile(filepath, "utf8").catch(() => null);
  }

  get paths() {
    return {
      vault: this.vaultPath,
      ragBase: this.ragBase,
      syncScript: join(homedir(), "vault-sync.sh"),
      writeScript: join(homedir(), "solis-write-memory.sh"),
    };
  }
}
