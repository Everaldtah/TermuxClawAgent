/**
 * MemoryStore - Persistent conversation memory for TermuxAgent
 * File-based JSON storage, Termux-native
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface MemoryEntry {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  session?: string;
}

export interface MemoryQuery {
  limit?: number;
  session?: string;
  role?: string;
}

export class MemoryStore {
  private path: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(storagePath?: string) {
    this.path = storagePath ?? join(homedir(), ".termux-agent", "memory.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await readFile(this.path, "utf8");
      this.entries = JSON.parse(data);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  async save(message: { role: string; content: string; session?: string; sessionId?: string }): Promise<void> {
    await this.load();
    const entry: MemoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: message.role,
      content: message.content,
      timestamp: Date.now(),
      session: message.session ?? message.sessionId,
    };
    this.entries.push(entry);
    // Keep last 500 entries
    if (this.entries.length > 500) this.entries = this.entries.slice(-500);
    await this.persist();
  }

  async query(opts: MemoryQuery = {}): Promise<MemoryEntry[]> {
    await this.load();
    let result = this.entries;
    if (opts.role) result = result.filter(e => e.role === opts.role);
    if (opts.session) result = result.filter(e => e.session === opts.session);
    return result.slice(-(opts.limit ?? 50));
  }

  clear(): void {
    this.entries = [];
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2));
  }
}
