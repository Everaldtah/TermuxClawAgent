# 🤖 TermuxAgent

> Token-Optimized AI Agent for Android/Termux  
> Based on OpenClaw Architecture | Lightweight | Mobile-First

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/termux-agent/termux-agent)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)

## 🎯 Overview

TermuxAgent is a **token-optimized** AI agent specifically designed to run on Android smartphones via [Termux](https://termux.dev/). It brings the power of modern LLMs (GPT-4, Claude, Llama, etc.) to your pocket with minimal resource usage.

### Key Features

- 🚀 **Token-Optimized** - Minimal code, maximum functionality
- 📱 **Android Native** - Designed for Termux environment
- 🧠 **Multi-Provider** - OpenAI, Anthropic, Ollama, OpenRouter, Groq
- 🛠️ **Built-in Tools** - Shell, file operations, code execution
- 💾 **Memory** - Persistent conversation history
- ⚡ **Fast** - Lightweight with minimal dependencies
- 🔒 **Secure** - Local-first, your data stays with you

### ✨ New in this build

- 📲 **Full Android control** — a new `android_*` tool suite drives the
  phone end-to-end via Termux:API: SMS, calls, contacts, camera, GPS,
  sensors, clipboard, notifications, TTS, media player, WiFi, brightness,
  volume, share sheet, downloads, vibration, toasts, fingerprint auth.
  See [`src/tools/android.ts`](src/tools/android.ts).
- 🦙 **Local models via Ollama & LM Studio CLI** — register any locally
  hosted model in `config.json` under `localModels[]`. Both Ollama
  (`pkg install ollama`) and LM Studio's `lms` CLI expose an
  OpenAI-compatible endpoint, so the existing gateway talks to them
  with zero extra code. Helper: `ConfigManager.addLocalModel(...)`.
- 📒 **Obsidian integration** — `obsidian_read/write/append/list/search`
  tools talk to an Obsidian vault, using `obsidian-cli` when present and
  falling back to direct markdown I/O otherwise. See
  [`src/tools/obsidian.ts`](src/tools/obsidian.ts).
- 🧠 **Persistent graph memory in Obsidian** — the new `ObsidianMemory`
  module stores the agent's skills, daily activity, and durable facts as
  markdown notes wired together with `[[wikilinks]]`. Open the vault in
  Obsidian and switch to graph view to *see* the agent's memory. Skills
  live under `Memory/Skills/`, daily activity under `Memory/Daily/`, and
  facts under `Memory/Facts/`.
- 🎯 **Smarter token-efficiency module** — the new `TokenOptimizer`
  replaces the old crude message-count trim with a token-aware budget:
  it compacts oversized tool output (the biggest token sink), clips long
  assistant replies, and drops oldest middle messages first while always
  keeping the system prompt and recent turns. On every turn the runtime
  also pulls only the top-k relevant snippets from Obsidian memory and
  injects them as a tiny RAG context block, so prompt tokens stay flat
  even as the vault grows — closer to local RAG precision with far
  fewer hallucinations than stuffing raw history into the prompt.

## 📋 Requirements

- Android 7.0+ (API 24+)
- [Termux](https://f-droid.org/packages/com.termux/) from F-Droid
- Node.js 20+ (installed via Termux)
- 100MB free storage
- Internet connection (for cloud LLMs)

## 🚀 Quick Install

```bash
# In Termux, run:
curl -fsSL https://raw.githubusercontent.com/termux-agent/termux-agent/main/scripts/install-termux.sh | bash
```

Or manually:

```bash
# Update packages
pkg update && pkg upgrade -y

# Install Node.js
pkg install -y nodejs-lts

# Install TermuxAgent
npm install -g termux-agent

# Run setup
termux-agent setup
```

## 💬 Usage

### Interactive Chat

```bash
# Start a chat session
termux-agent chat

# With specific model
termux-agent chat -m gpt-4o-mini

# With system prompt
termux-agent chat -s "You are a coding assistant"
```

### Single Question (Quick Mode)

```bash
# Ask a single question
termux-agent ask "What is the capital of France?"

# With streaming disabled
termux-agent ask "Explain quantum computing" --no-stream
```

### Configuration

```bash
# Initialize config
termux-agent config --init

# Set API key
termux-agent config --set provider.openai.apiKey=sk-...

# Get config value
termux-agent config --get model.default

# List all config
termux-agent config --list
```

### Tool Management

```bash
# List available tools
termux-agent tools --list

# Enable/disable tools
termux-agent tools --enable shell
termux-agent tools --disable code
```

### Status & Info

```bash
# Show agent status
termux-agent status

# Show help
termux-agent --help
```

## ⚙️ Configuration

Configuration is stored in `~/.termux-agent/config.json`:

```json
{
  "version": "1.0.0",
  "provider": {
    "default": "openai",
    "openai": {
      "name": "openai",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4o-mini"
    }
  },
  "model": {
    "default": "gpt-4o-mini",
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "context": {
    "maxMessages": 50,
    "maxTokens": 8000,
    "enableSummarization": true
  },
  "memory": {
    "enabled": true,
    "path": "~/.termux-agent/memory",
    "maxSize": 104857600
  },
  "tools": {
    "enabled": ["shell", "file", "code"],
    "timeout": 30000
  }
}
```

## 🛠️ Built-in Tools

| Tool | Description | Example |
|------|-------------|---------|
| `shell` | Execute shell commands | List files, run scripts |
| `read_file` | Read file contents | View code, configs |
| `write_file` | Write to files | Save output, edit files |
| `list_directory` | List directory contents | Browse files |
| `run_code` | Execute Python/JS code | Quick calculations |
| `termux_info` | Get Termux environment info | Debug issues |
| `fetch` | HTTP requests | Get web content |
| `search_files` | Grep search in files | Find in codebase |

## 🔌 Supported Providers

| Provider | Models | Setup |
|----------|--------|-------|
| **OpenAI** | GPT-4, GPT-4o, GPT-3.5 | API Key from [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | Claude 3.5, Claude 3 | API Key from [console.anthropic.com](https://console.anthropic.com) |
| **Ollama** | Llama, Mistral, etc. | Run locally: `ollama serve` |
| **OpenRouter** | 100+ models | Key from [openrouter.ai](https://openrouter.ai) |
| **Groq** | Llama, Mixtral | Key from [groq.com](https://groq.com) |

## 📝 Chat Commands

During an interactive chat session:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/quit` | Exit chat session |
| `/clear` | Clear conversation context |
| `/model` | Show current model |
| `/tokens` | Toggle token usage display |
| `/save <file>` | Save conversation to file |
| `/load <file>` | Load conversation from file |

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TERMUX_AGENT_LOG` | Log level (debug/info/warn/error) | `info` |
| `NODE_DISABLE_COMPILE_CACHE` | Disable compile cache | `0` |
| `NO_COLOR` | Disable colored output | unset |

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│           TermuxAgent CLI               │
├─────────────────────────────────────────┤
│  Chat Session  │  Config  │  Commands   │
├─────────────────────────────────────────┤
│           Agent Runtime                 │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ Gateway │ │ Memory  │ │  Tools   │  │
│  │ Client  │ │ Store   │ │ Registry │  │
│  └─────────┘ └─────────┘ └──────────┘  │
├─────────────────────────────────────────┤
│         LLM Providers                   │
│  OpenAI │ Claude │ Ollama │ OpenRouter  │
└─────────────────────────────────────────┘
```

## 📦 Development

```bash
# Clone repository
git clone https://github.com/termux-agent/termux-agent.git
cd termux-agent

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

- Based on [OpenClaw](https://github.com/openclaw/openclaw) architecture
- Inspired by the need for mobile-first AI agents
- Built for the Termux community

## 🔗 Links

- [GitHub](https://github.com/termux-agent/termux-agent)
- [Issues](https://github.com/termux-agent/termux-agent/issues)
- [Termux Wiki](https://wiki.termux.com)

---

<p align="center">
  <b>Made with ❤️ for Android developers</b><br>
  <sub>Run AI in your pocket 🦞</sub>
</p>
