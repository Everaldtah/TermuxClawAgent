/**
 * ObsidianMemory - Graph memory backed by Obsidian vault or plain markdown
 * Termux-native: falls back to direct file I/O when obsidian-cli is absent
 */

import { readFile, writeFile, readdir, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type MemoryKind = "fact" | "episode" | "skill" | "note";

export interface MemoryRecall {
  title: string;
  content: string;
  score: number;
  kind: MemoryKind;
}

export class ObsidianMemory {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async store(title: string, content: string, kind: MemoryKind = "note"): Promise<void> {
    const dir = join(this.vaultPath, kind + "s");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const file = join(dir, `${title.replace(/[^a-z0-9-_ ]/gi, "_")}.md`);
    const body = `---\nkind: ${kind}\ncreated: ${new Date().toISOString()}\n---\n\n# ${title}\n\n${content}\n`;
    await writeFile(file, body, "utf8");
  }

  async append(title: string, content: string, kind: MemoryKind = "note"): Promise<void> {
    const dir = join(this.vaultPath, kind + "s");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const file = join(dir, `${title.replace(/[^a-z0-9-_ ]/gi, "_")}.md`);
    await appendFile(file, `\n${content}\n`, "utf8");
  }

  async recall(query: string, topK = 5): Promise<MemoryRecall[]> {
    const results: MemoryRecall[] = [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    for (const kind of ["facts", "episodes", "skills", "notes"] as const) {
      const dir = join(this.vaultPath, kind);
      if (!existsSync(dir)) continue;
      const files = await readdir(dir).catch(() => []);

      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const text = await readFile(join(dir, f), "utf8").catch(() => "");
        const lower = text.toLowerCase();
        const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
        if (score > 0) {
          results.push({
            title: f.replace(".md", ""),
            content: text.slice(0, 500),
            score,
            kind: kind.slice(0, -1) as MemoryKind,
          });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async list(kind?: MemoryKind): Promise<string[]> {
    const dirs = kind ? [kind + "s"] : ["facts", "episodes", "skills", "notes"];
    const all: string[] = [];
    for (const d of dirs) {
      const dir = join(this.vaultPath, d);
      const files = await readdir(dir).catch(() => []);
      all.push(...files.filter(f => f.endsWith(".md")).map(f => `${d}/${f}`));
    }
    return all;
  }
}
