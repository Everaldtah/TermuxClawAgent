/**
 * Obsidian integration - reads and writes an Obsidian vault from the agent.
 *
 * Uses the `obsidian-cli` (https://github.com/Yakitrak/obsidian-cli) if present,
 * otherwise falls back to direct markdown file I/O against the configured vault
 * path. Either way the agent can list/read/write notes, follow wikilinks, and
 * append daily-activity entries to a graph-shaped markdown memory.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { Logger } from "../utils/logger.js";
import type { ToolDefinition } from "./registry.js";

const execFileAsync = promisify(execFile);
const logger = new Logger("Obsidian");

export interface ObsidianOptions {
  vaultPath: string;
  vaultName?: string;
  useCli?: boolean;
}

export class ObsidianClient {
  public vaultPath: string;
  public vaultName: string;
  private useCli: boolean;
  private cliAvailable: boolean | null = null;

  constructor(opts: ObsidianOptions) {
    this.vaultPath = resolve(opts.vaultPath);
    this.vaultName = opts.vaultName || this.vaultPath.split(/[\\/]/).pop() || "vault";
    this.useCli = opts.useCli ?? true;
  }

  async ensureVault(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true });
  }

  private async hasCli(): Promise<boolean> {
    if (this.cliAvailable !== null) return this.cliAvailable;
    if (!this.useCli) return (this.cliAvailable = false);
    try {
      await execFileAsync("obsidian-cli", ["--version"], { timeout: 3000 });
      this.cliAvailable = true;
    } catch {
      this.cliAvailable = false;
    }
    return this.cliAvailable;
  }

  private notePath(name: string): string {
    const safe = name.endsWith(".md") ? name : `${name}.md`;
    return join(this.vaultPath, safe);
  }

  async readNote(name: string): Promise<string> {
    const p = this.notePath(name);
    if (!existsSync(p)) throw new Error(`Note not found: ${name}`);
    return readFile(p, "utf8");
  }

  async writeNote(name: string, content: string): Promise<string> {
    const p = this.notePath(name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");

    // Best-effort: notify Obsidian via CLI so the vault refreshes.
    if (await this.hasCli()) {
      try {
        await execFileAsync("obsidian-cli", ["open", "-v", this.vaultName, name], { timeout: 3000 });
      } catch (err: any) {
        logger.debug(`obsidian-cli open skipped: ${err.message}`);
      }
    }
    return p;
  }

  async appendNote(name: string, content: string): Promise<string> {
    const p = this.notePath(name);
    await mkdir(dirname(p), { recursive: true });
    const existing = existsSync(p) ? await readFile(p, "utf8") : "";
    const joined = existing ? `${existing.trimEnd()}\n\n${content}\n` : `${content}\n`;
    await writeFile(p, joined, "utf8");
    return p;
  }

  async listNotes(subdir?: string): Promise<string[]> {
    const base = subdir ? join(this.vaultPath, subdir) : this.vaultPath;
    if (!existsSync(base)) return [];
    const out: string[] = [];
    const walk = async (dir: string, prefix = ""): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(full, rel);
        else if (e.name.endsWith(".md")) out.push(rel);
      }
    };
    await walk(base);
    return out;
  }

  async search(query: string, limit = 25): Promise<Array<{ note: string; line: number; text: string }>> {
    const notes = await this.listNotes();
    const q = query.toLowerCase();
    const results: Array<{ note: string; line: number; text: string }> = [];
    for (const n of notes) {
      const content = await readFile(join(this.vaultPath, n), "utf8").catch(() => "");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ note: n, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }
}

export function getObsidianTools(client: ObsidianClient): ToolDefinition[] {
  const t = (name: string, description: string, parameters: any, handler: (a: any) => Promise<any>): ToolDefinition => ({
    name, description, parameters, enabled: true, handler
  });

  return [
    t("obsidian_read", "Read a note from the Obsidian vault.",
      { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async (a) => ({ content: await client.readNote(a.name) })),

    t("obsidian_write", "Create or overwrite a note in the Obsidian vault.",
      { type: "object", properties: {
        name: { type: "string" }, content: { type: "string" }
      }, required: ["name", "content"] },
      async (a) => ({ path: await client.writeNote(a.name, a.content) })),

    t("obsidian_append", "Append markdown to a note in the vault.",
      { type: "object", properties: {
        name: { type: "string" }, content: { type: "string" }
      }, required: ["name", "content"] },
      async (a) => ({ path: await client.appendNote(a.name, a.content) })),

    t("obsidian_list", "List notes in the vault (optionally under a subfolder).",
      { type: "object", properties: { subdir: { type: "string" } } },
      async (a) => ({ notes: await client.listNotes(a.subdir) })),

    t("obsidian_search", "Full-text search across the Obsidian vault.",
      { type: "object", properties: {
        query: { type: "string" }, limit: { type: "number" }
      }, required: ["query"] },
      async (a) => ({ results: await client.search(a.query, a.limit) })),
  ];
}
