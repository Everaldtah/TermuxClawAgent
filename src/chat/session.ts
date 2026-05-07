/**
 * ChatSession - Interactive chat interface for TermuxAgent
 * Token-optimized for mobile terminals
 */

import { createInterface, Interface } from "node:readline";
import { stdin, stdout } from "node:process";
import { AgentRuntime } from "../runtime.js";
import { Logger } from "../utils/logger.js";
import { TokenOptimizer } from "../utils/token-optimizer.js";

export interface ChatOptions {
  multiline?: boolean;
  showTokens?: boolean;
  compact?: boolean;
}

/**
 * Interactive chat session handler
 */
export class ChatSession {
  private runtime: AgentRuntime;
  private logger: Logger;
  private rl: Interface | null = null;
  private options: ChatOptions;
  private history: string[] = [];
  private isRunning: boolean = false;

  constructor(runtime: AgentRuntime, options: ChatOptions = {}) {
    this.runtime = runtime;
    this.logger = new Logger("Chat");
    this.options = {
      multiline: false,
      showTokens: runtime.config.get("ui.showTokens") ?? false,
      compact: runtime.config.get("ui.compactMode") ?? true,
      ...options
    };
  }

  /**
   * Start the interactive chat session
   */
  public async start(initialMessage?: string): Promise<void> {
    this.isRunning = true;
    
    // Setup readline interface
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      prompt: this.getPrompt(),
      history: this.history,
      historySize: 100
    });

    // Handle special commands
    this.rl.on("line", (input) => this.handleInput(input));
    this.rl.on("close", () => this.exit());

    // Show welcome message
    this.showWelcome();

    // Process initial message if provided
    if (initialMessage) {
      await this.processMessage(initialMessage);
    }

    // Start prompt loop
    this.rl.prompt();

    // Wait for session to end
    await this.waitForEnd();
  }

  /**
   * Show welcome message
   */
  private showWelcome(): void {
    if (this.options.compact) {
      console.log("Type /help for commands, /quit to exit\n");
    } else {
      console.log("╔════════════════════════════════════╗");
      console.log("║     Chat Session Started           ║");
      console.log("╠════════════════════════════════════╣");
      console.log("║  Commands:                         ║");
      console.log("║    /help    - Show help            ║");
      console.log("║    /quit    - Exit session         ║");
      console.log("║    /clear   - Clear context        ║");
      console.log("║    /model   - Show current model   ║");
      console.log("║    /tokens  - Toggle token display ║");
      console.log("╚════════════════════════════════════╝\n");
    }
  }

  /**
   * Get the prompt string
   */
  private getPrompt(): string {
    const model = this.runtime.model.split("/").pop()?.slice(0, 15) || "agent";
    return `\x1b[36m[${model}]\x1b[0m > `;
  }

  /**
   * Handle user input
   */
  private async handleInput(input: string): Promise<void> {
    const trimmed = input.trim();
    
    if (!trimmed) {
      this.rl?.prompt();
      return;
    }

    // Save to history
    this.history.push(trimmed);

    // Check for commands
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
    } else {
      await this.processMessage(trimmed);
    }

    if (this.isRunning) {
      this.rl?.prompt();
    }
  }

  /**
   * Handle slash commands
   */
  private async handleCommand(cmd: string): Promise<void> {
    const [command, ...args] = cmd.slice(1).split(" ");

    switch (command) {
      case "quit":
      case "exit":
      case "q":
        this.exit();
        break;

      case "help":
      case "h":
        this.showHelp();
        break;

      case "clear":
      case "c":
        this.runtime.clearContext();
        console.log("🗑️  Context cleared");
        break;

      case "model":
      case "m":
        console.log(`Current model: ${this.runtime.model}`);
        break;

      case "tokens":
      case "t":
        this.options.showTokens = !this.options.showTokens;
        console.log(`Token display: ${this.options.showTokens ? "on" : "off"}`);
        break;

      case "save":
        if (args.length > 0) {
          await this.saveConversation(args.join(" "));
        } else {
          console.log("Usage: /save <filename>");
        }
        break;

      case "load":
        if (args.length > 0) {
          await this.loadConversation(args.join(" "));
        } else {
          console.log("Usage: /load <filename>");
        }
        break;

      default:
        console.log(`Unknown command: /${command}. Type /help for available commands.`);
    }
  }

  /**
   * Show help message
   */
  private showHelp(): void {
    console.log(`
Available commands:
  /help, /h       - Show this help
  /quit, /q       - Exit session
  /clear, /c      - Clear conversation context
  /model, /m      - Show current model
  /tokens, /t     - Toggle token usage display
  /save <file>    - Save conversation to file
  /load <file>    - Load conversation from file

Shortcuts:
  Ctrl+C          - Exit session
  Ctrl+L          - Clear screen
  Up/Down         - Navigate history
`);
  }

  /**
   * Process a user message
   */
  private async processMessage(message: string): Promise<void> {
    try {
      console.log(); // New line before response
      
      // Show thinking indicator
      if (!this.options.compact) {
        process.stdout.write("🤔 Thinking...\r");
      }

      const startTime = Date.now();
      
      // Execute through runtime
      const response = await this.runtime.execute(message);
      
      // Clear thinking indicator
      if (!this.options.compact) {
        process.stdout.write("              \r");
      }

      // Print response
      console.log(`\x1b[32m${response}\x1b[0m\n`);

      // Show token usage if enabled
      if (this.options.showTokens) {
        const context = this.runtime.getContext();
        const elapsed = Date.now() - startTime;
        const tokenEst = TokenOptimizer.estimateMessages(context.messages);
        console.log(`\x1b[90m[${context.messages.length} msgs | ~${tokenEst.toLocaleString()} tokens | ${elapsed}ms]\x1b[0m\n`);
      }

    } catch (err: unknown) {
      console.error(`\x1b[31mError: ${(err as Error).message}\x1b[0m\n`);
      this.logger.error(`Message processing failed: ${(err as Error).message}`);
    }
  }

  /**
   * Save conversation to file
   */
  private async saveConversation(filename: string): Promise<void> {
    try {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      
      const context = this.runtime.getContext();
      const data = JSON.stringify(context.messages, null, 2);
      
      const filepath = join(homedir(), ".termux-agent", `${filename}.json`);
      await writeFile(filepath, data, "utf8");
      
      console.log(`💾 Saved to ${filepath}`);
    } catch (err: unknown) {
      console.log(`❌ Save failed: ${(err as Error).message}`);
    }
  }

  /**
   * Load conversation from file
   */
  private async loadConversation(filename: string): Promise<void> {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      
      const filepath = join(homedir(), ".termux-agent", `${filename}.json`);
      const data = await readFile(filepath, "utf8");
      const messages = JSON.parse(data);
      
      // Update runtime context
      this.runtime.clearContext();
      messages.forEach((m: any) => this.runtime.addMessage(m));
      
      console.log(`📂 Loaded ${messages.length} messages from ${filepath}`);
    } catch (err: unknown) {
      console.log(`❌ Load failed: ${(err as Error).message}`);
    }
  }

  /**
   * Exit the chat session
   */
  private exit(): void {
    this.isRunning = false;
    this.rl?.close();
    console.log("\n👋 Goodbye!");
  }

  /**
   * Wait for session to end
   */
  private async waitForEnd(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.isRunning) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}
