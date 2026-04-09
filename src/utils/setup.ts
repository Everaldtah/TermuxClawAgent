/**
 * Setup utility - Interactive configuration wizard for TermuxAgent
 */

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { ConfigManager, CONFIG_PATH } from "../config/manager.js";
import { GatewayClient } from "../gateway/client.js";
import { Logger } from "./logger.js";

const logger = new Logger("Setup");

interface SetupAnswers {
  provider: string;
  apiKey: string;
  model: string;
  temperature: number;
  enableMemory: boolean;
  enableTools: boolean;
}

/**
 * Run interactive setup wizard
 */
export async function runInteractiveSetup(): Promise<void> {
  const rl = createInterface({
    input: stdin,
    output: stdout
  });

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    return new Promise((resolve) => {
      const prompt = defaultValue 
        ? `${question} (${defaultValue}): `
        : `${question}: `;
      rl.question(prompt, (answer) => {
        resolve(answer.trim() || defaultValue || "");
      });
    });
  };

  const askYesNo = async (question: string, defaultValue: boolean = true): Promise<boolean> => {
    const defaultStr = defaultValue ? "Y/n" : "y/N";
    const answer = await ask(question, defaultStr);
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") return true;
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") return false;
    return defaultValue;
  };

  console.log("\n🚀 TermuxAgent Setup Wizard\n");
  console.log("This will create your configuration file.\n");

  try {
    // Provider selection
    console.log("Select your LLM provider:");
    console.log("  1. OpenAI (GPT-4, GPT-3.5)");
    console.log("  2. Anthropic (Claude)");
    console.log("  3. Ollama (local models)");
    console.log("  4. OpenRouter (multiple providers)");
    console.log("  5. Groq (fast inference)");
    
    const providerChoice = await ask("Provider (1-5)", "1");
    const providers: Record<string, string> = {
      "1": "openai",
      "2": "anthropic",
      "3": "ollama",
      "4": "openrouter",
      "5": "groq"
    };
    const provider = providers[providerChoice] || "openai";

    // API Key
    let apiKey = "";
    let baseUrl = "";
    
    if (provider === "ollama") {
      baseUrl = await ask("Ollama URL", "http://localhost:11434/v1");
    } else {
      const keyName = provider === "anthropic" ? "Anthropic API Key" :
                      provider === "groq" ? "Groq API Key" :
                      provider === "openrouter" ? "OpenRouter API Key" :
                      "OpenAI API Key";
      apiKey = await ask(keyName);
    }

    // Model selection
    const defaultModels: Record<string, string> = {
      openai: "gpt-4o-mini",
      anthropic: "claude-3-haiku-20240307",
      ollama: "llama3.2",
      openrouter: "openai/gpt-4o-mini",
      groq: "llama-3.1-8b-instant"
    };
    
    const model = await ask("Model", defaultModels[provider]);

    // Temperature
    const tempStr = await ask("Temperature (0-1)", "0.7");
    const temperature = parseFloat(tempStr) || 0.7;

    // Features
    const enableMemory = await askYesNo("Enable conversation memory?", true);
    const enableTools = await askYesNo("Enable tool execution?", true);

    rl.close();

    // Create config
    const config = new ConfigManager();
    await config.init();

    // Set provider
    await config.setProvider(provider, {
      name: provider,
      apiKey,
      baseUrl: baseUrl || undefined,
      defaultModel: model
    });

    // Set other values
    await config.set("provider.default", provider);
    await config.set("model.default", model);
    await config.set("model.temperature", temperature);
    await config.set("memory.enabled", enableMemory);
    
    if (enableTools) {
      await config.set("tools.enabled", ["shell", "file", "code"]);
    } else {
      await config.set("tools.enabled", []);
    }

    // Validate API key
    console.log("\n🔍 Validating API key...");
    
    try {
      const gateway = new GatewayClient({
        name: provider,
        apiKey,
        baseUrl: baseUrl || undefined,
        defaultModel: model
      });

      const isValid = await gateway.validate();
      
      if (isValid) {
        console.log("✅ API key is valid!");
      } else {
        console.log("⚠️  Could not validate API key. Please check your settings.");
      }
    } catch (err) {
      console.log(`⚠️  Validation error: ${err.message}`);
    }

    console.log("\n✅ Setup complete!");
    console.log(`\nConfig saved to: ${CONFIG_PATH}`);
    console.log("\nNext steps:");
    console.log("  termux-agent chat     - Start chatting");
    console.log("  termux-agent ask      - Ask a single question");
    console.log("  termux-agent status   - Check status\n");

  } catch (err) {
    rl.close();
    logger.error(`Setup failed: ${err.message}`);
    throw err;
  }
}
