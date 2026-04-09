#!/usr/bin/env node
// TermuxAgent - Token-Optimized AI Agent for Android/Termux
// Based on OpenClaw architecture, optimized for mobile devices

import { readFileSync, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Minimal Node version check (Termux usually has recent Node)
const MIN_NODE_MAJOR = 20;
const parseNodeVersion = (raw) => {
  const [major = "0"] = raw.split(".");
  return Number(major);
};

const ensureNodeVersion = () => {
  const major = parseNodeVersion(process.versions.node);
  if (major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `termux-agent: Node.js v${MIN_NODE_MAJOR}+ required (current: v${process.versions.node})\n` +
      "Run: pkg install nodejs-lts\n"
    );
    process.exit(1);
  }
};

ensureNodeVersion();

// Enable compile cache if available
if (process.env.NODE_DISABLE_COMPILE_CACHE !== "1") {
  try {
    const { enableCompileCache } = await import("node:module");
    enableCompileCache?.();
  } catch { /* ignore */ }
}

// Check for dist build or run from source
const distPath = join(__dirname, "dist", "cli", "index.js");
const srcPath = join(__dirname, "src", "cli", "index.ts");

async function main() {
  try {
    // Prefer dist if available
    if (existsSync(distPath)) {
      await import(distPath);
    } else {
      // Run with tsx or direct import if TypeScript
      try {
        await import("./src/cli/index.ts");
      } catch (err) {
        if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("TypeScript")) {
          process.stderr.write(
            "termux-agent: TypeScript source detected.\n" +
            "Install tsx: npm install -g tsx\n" +
            "Or build first: npm run build\n"
          );
          process.exit(1);
        }
        throw err;
      }
    }
  } catch (err) {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
