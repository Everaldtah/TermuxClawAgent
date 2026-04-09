/**
 * Logger - Simple logging utility for TermuxAgent
 * Token-optimized, minimal overhead
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  timestamps?: boolean;
  colors?: boolean;
}

/**
 * Simple console logger with level filtering
 */
export class Logger {
  private level: LogLevel;
  private prefix: string;
  private timestamps: boolean;
  private colors: boolean;

  private static levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4
  };

  private static colors: Record<string, string> = {
    reset: "\x1b[0m",
    debug: "\x1b[36m", // Cyan
    info: "\x1b[32m",  // Green
    warn: "\x1b[33m",  // Yellow
    error: "\x1b[31m", // Red
    gray: "\x1b[90m"   // Gray
  };

  constructor(prefix: string = "", options: LoggerOptions = {}) {
    this.prefix = prefix;
    this.level = options.level || this.getEnvLevel();
    this.timestamps = options.timestamps ?? false;
    this.colors = options.colors ?? this.supportsColors();
  }

  private getEnvLevel(): LogLevel {
    const env = process.env.TERMUX_AGENT_LOG;
    if (env && env in Logger.levels) {
      return env as LogLevel;
    }
    return "info";
  }

  private supportsColors(): boolean {
    return !!process.stdout.isTTY && !process.env.NO_COLOR;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.levels[level] >= Logger.levels[this.level];
  }

  private format(level: LogLevel, message: string): string {
    const parts: string[] = [];

    // Timestamp
    if (this.timestamps) {
      const ts = new Date().toISOString();
      parts.push(this.colors ? `${Logger.colors.gray}[${ts}]${Logger.colors.reset}` : `[${ts}]`);
    }

    // Level
    if (this.colors) {
      const color = Logger.colors[level] || Logger.colors.reset;
      parts.push(`${color}[${level.toUpperCase()}]${Logger.colors.reset}`);
    } else {
      parts.push(`[${level.toUpperCase()}]`);
    }

    // Prefix
    if (this.prefix) {
      parts.push(`[${this.prefix}]`);
    }

    // Message
    parts.push(message);

    return parts.join(" ");
  }

  public debug(message: string): void {
    if (this.shouldLog("debug")) {
      console.debug(this.format("debug", message));
    }
  }

  public info(message: string): void {
    if (this.shouldLog("info")) {
      console.info(this.format("info", message));
    }
  }

  public warn(message: string): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", message));
    }
  }

  public error(message: string): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", message));
    }
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger("Global");
