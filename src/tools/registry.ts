/**
 * ToolRegistry - Tool execution system for TermuxAgent
 * Token-optimized, built-in tools for Android/Termux
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  callId: string;
  name: string;
  output: any;
  error?: string;
  duration: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  enabled: boolean;
  handler: (args: any) => Promise<any>;
}

/**
 * Tool registry with built-in Termux/Android tools
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition>;
  private logger: Logger;
  private timeout: number;

  constructor(enabledTools?: string[], timeout: number = 30000) {
    this.tools = new Map();
    this.logger = new Logger("Tools");
    this.timeout = timeout;
    this.registerBuiltInTools();
    
    if (enabledTools) {
      this.setEnabledTools(enabledTools);
    }
  }

  /**
   * Register all built-in tools
   */
  private registerBuiltInTools(): void {
    // Shell command execution
    this.register({
      name: "shell",
      description: "Execute a shell command in Termux. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute"
          },
          cwd: {
            type: "string",
            description: "Working directory (default: current)"
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)"
          }
        },
        required: ["command"]
      },
      enabled: true,
      handler: this.handleShell.bind(this)
    });

    // File operations
    this.register({
      name: "read_file",
      description: "Read contents of a file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file"
          },
          limit: {
            type: "number",
            description: "Max lines to read (default: 100)"
          }
        },
        required: ["path"]
      },
      enabled: true,
      handler: this.handleReadFile.bind(this)
    });

    this.register({
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file"
          },
          content: {
            type: "string",
            description: "Content to write"
          },
          append: {
            type: "boolean",
            description: "Append instead of overwrite"
          }
        },
        required: ["path", "content"]
      },
      enabled: true,
      handler: this.handleWriteFile.bind(this)
    });

    // Directory listing
    this.register({
      name: "list_directory",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path (default: current)"
          }
        }
      },
      enabled: true,
      handler: this.handleListDirectory.bind(this)
    });

    // Code execution (Python/Node)
    this.register({
      name: "run_code",
      description: "Execute Python or Node.js code",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["python", "javascript"],
            description: "Programming language"
          },
          code: {
            type: "string",
            description: "Code to execute"
          }
        },
        required: ["language", "code"]
      },
      enabled: true,
      handler: this.handleRunCode.bind(this)
    });

    // Termux-specific tools
    this.register({
      name: "termux_info",
      description: "Get Termux environment information",
      parameters: {
        type: "object",
        properties: {}
      },
      enabled: true,
      handler: this.handleTermuxInfo.bind(this)
    });

    // Web fetch (if curl available)
    this.register({
      name: "fetch",
      description: "Fetch content from a URL",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to fetch"
          },
          method: {
            type: "string",
            enum: ["GET", "POST"],
            default: "GET"
          }
        },
        required: ["url"]
      },
      enabled: true,
      handler: this.handleFetch.bind(this)
    });

    // Search in files
    this.register({
      name: "search_files",
      description: "Search for text in files using grep",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern"
          },
          path: {
            type: "string",
            description: "Directory or file to search"
          }
        },
        required: ["pattern", "path"]
      },
      enabled: true,
      handler: this.handleSearchFiles.bind(this)
    });
  }

  /**
   * Register a tool
   */
  public register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered tool: ${tool.name}`);
  }

  /**
   * Execute a tool call
   */
  public async execute(call: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();
    const tool = this.tools.get(call.function.name);

    if (!tool) {
      return {
        callId: call.id,
        name: call.function.name,
        output: null,
        error: `Tool not found: ${call.function.name}`,
        duration: Date.now() - startTime
      };
    }

    if (!tool.enabled) {
      return {
        callId: call.id,
        name: call.function.name,
        output: null,
        error: `Tool disabled: ${call.function.name}`,
        duration: Date.now() - startTime
      };
    }

    try {
      const args = JSON.parse(call.function.arguments);
      const output = await tool.handler(args);
      
      return {
        callId: call.id,
        name: call.function.name,
        output,
        duration: Date.now() - startTime
      };
    } catch (err) {
      return {
        callId: call.id,
        name: call.function.name,
        output: null,
        error: err.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Get tool schemas for LLM
   */
  public getToolSchemas(): any[] {
    return Array.from(this.tools.values())
      .filter(t => t.enabled)
      .map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
  }

  /**
   * List all tools
   */
  public list(): Array<{ name: string; description: string; enabled: boolean }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      enabled: t.enabled
    }));
  }

  /**
   * Enable a tool
   */
  public async enable(name: string): Promise<void> {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = true;
      this.logger.info(`Enabled tool: ${name}`);
    }
  }

  /**
   * Disable a tool
   */
  public async disable(name: string): Promise<void> {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = false;
      this.logger.info(`Disabled tool: ${name}`);
    }
  }

  /**
   * Check if any tools are enabled
   */
  public hasEnabledTools(): boolean {
    return Array.from(this.tools.values()).some(t => t.enabled);
  }

  /**
   * Set enabled tools list
   */
  public setEnabledTools(names: string[]): void {
    for (const tool of this.tools.values()) {
      tool.enabled = names.includes(tool.name);
    }
  }

  // Tool handlers

  private async handleShell(args: { command: string; cwd?: string; timeout?: number }): Promise<any> {
    const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
    const timeout = args.timeout || this.timeout;

    // Security: block dangerous commands
    const dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero", "> /dev/sda"];
    if (dangerous.some(d => args.command.includes(d))) {
      throw new Error("Dangerous command blocked");
    }

    const { stdout, stderr } = await execFileAsync(
      "sh",
      ["-c", args.command],
      { cwd, timeout, encoding: "utf8" }
    );

    return { stdout, stderr };
  }

  private async handleReadFile(args: { path: string; limit?: number }): Promise<any> {
    const filepath = resolve(args.path);
    const limit = args.limit || 100;

    // Security: prevent reading sensitive files
    const sensitive = ["/etc/shadow", "/etc/passwd", ".ssh/id_rsa"];
    if (sensitive.some(s => filepath.includes(s))) {
      throw new Error("Access to sensitive file blocked");
    }

    const content = await readFile(filepath, "utf8");
    const lines = content.split("\n");
    
    return {
      content: lines.slice(0, limit).join("\n"),
      truncated: lines.length > limit,
      totalLines: lines.length
    };
  }

  private async handleWriteFile(args: { path: string; content: string; append?: boolean }): Promise<any> {
    const filepath = resolve(args.path);
    const dir = filepath.substring(0, filepath.lastIndexOf("/"));
    
    await mkdir(dir, { recursive: true });
    
    if (args.append) {
      await writeFile(filepath, args.content, { flag: "a" });
    } else {
      await writeFile(filepath, args.content);
    }

    return { path: filepath, bytes: args.content.length };
  }

  private async handleListDirectory(args: { path?: string }): Promise<any> {
    const dir = args.path ? resolve(args.path) : process.cwd();
    const { readdir, stat } = await import("node:fs/promises");
    
    const entries = await readdir(dir, { withFileTypes: true });
    
    return entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
      size: e.isFile() ? stat(join(dir, e.name)).then(s => s.size).catch(() => 0) : null
    }));
  }

  private async handleRunCode(args: { language: string; code: string }): Promise<any> {
    const timeout = this.timeout;
    
    if (args.language === "python") {
      const { stdout, stderr } = await execFileAsync(
        "python3",
        ["-c", args.code],
        { timeout, encoding: "utf8" }
      );
      return { stdout, stderr };
    } else if (args.language === "javascript") {
      const { stdout, stderr } = await execFileAsync(
        "node",
        ["-e", args.code],
        { timeout, encoding: "utf8" }
      );
      return { stdout, stderr };
    }
    
    throw new Error(`Unsupported language: ${args.language}`);
  }

  private async handleTermuxInfo(): Promise<any> {
    const info: any = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: process.cwd(),
      home: homedir()
    };

    // Try to get Termux-specific info
    try {
      const { stdout } = await execFileAsync("termux-info", [], { encoding: "utf8" });
      info.termux = stdout;
    } catch {
      info.termux = "Not available";
    }

    return info;
  }

  private async handleFetch(args: { url: string; method?: string }): Promise<any> {
    const response = await fetch(args.url, {
      method: args.method || "GET"
    });

    const content = await response.text();
    
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      content: content.slice(0, 10000), // Limit content size
      truncated: content.length > 10000
    };
  }

  private async handleSearchFiles(args: { pattern: string; path: string }): Promise<any> {
    const { stdout } = await execFileAsync(
      "grep",
      ["-r", "-n", "--include=*.{txt,md,js,ts,py,json}", args.pattern, args.path],
      { encoding: "utf8", timeout: this.timeout }
    ).catch(err => ({ stdout: err.stdout || "" }));

    const matches = stdout.split("\n").filter(Boolean).slice(0, 50);
    
    return {
      matches,
      count: matches.length,
      pattern: args.pattern
    };
  }
}
