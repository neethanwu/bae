# Bae — Your AI, Always On

[![npm version](https://img.shields.io/npm/v/bae-bridge)](https://www.npmjs.com/package/bae-bridge)

> Turn any always-on machine into a personal AI agent server, accessible from your messaging apps.

```
 ██████╗  █████╗ ███████╗
 ██╔══██╗██╔══██╗██╔════╝
 ██████╔╝███████║█████╗
 ██╔══██╗██╔══██║██╔══╝
 ██████╔╝██║  ██║███████╗
 ╚═════╝ ╚═╝  ╚═╝╚══════╝
```

## What Is Bae?

Bae connects your messaging apps to coding agents running on your machine. The agent is the brain. Bae is the phone line.

```
Your Phone                     Your Machine
┌─────────────┐               ┌─────────────────────────────────┐
│  Telegram   │               │                                 │
│  Slack      │◀── Bae ──────▶│  Claude Code / Codex / OpenCode │
│  iMessage   │               │                                 │
└─────────────┘               │  Your files, skills, MCP tools  │
                              └─────────────────────────────────┘
```

**What makes Bae different:**

- **No API keys needed** — uses your existing agent subscription (Claude Max, etc.)
- **Full agent power** — file editing, bash, code generation, web search — everything your agent can do locally
- **No tunnel or server** — all connections are outbound (long polling, Socket Mode, database polling)
- **Multi-platform** — Telegram, Slack, and iMessage today. Discord and email coming soon.
- **Conversation continuity** — messages in the same thread share agent context
- **Agent-agnostic** — swap between agents without losing project context

## Supported Agents

Bae works with any CLI agent that accepts prompts and produces text output. The agent runs on your machine with your local auth — no API keys needed.

| Agent | Status | Notes |
|-------|--------|-------|
| [Claude Code](https://docs.anthropic.com/s/claude-code) | **Tested** | Primary backend. Streaming, steering, session resume. |
| [Codex](https://github.com/openai/codex) | Planned | Will use the same executor interface. |
| [OpenCode](https://github.com/opencode-ai/opencode) | Planned | ACP protocol support in future. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Planned | Executor adapter needed. |
| [Amp](https://ampcode.com/) | Planned | Executor adapter needed. |

To use Bae, install at least one agent first. For example:

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code
claude auth login
```

## Quick Start

### 1. Install Bae

```bash
npm install -g bae-bridge
```

### 2. Go to your project folder

```bash
cd ~/my-project
```

Bae uses your current directory as the agent's workspace. The agent will have access to all files here — CLAUDE.md, git history, project files, etc.

### 3. Set up your first channel

```bash
bae init
```

The wizard walks you through everything — pick your platform, enter credentials, and set allowed user IDs.

### 4. Start in background

```bash
bae start -d
```

That's it! Message your bot and start chatting with your agent. Use `bae logs` to watch what's happening, and `bae stop` when you're done.

## Platform Setup

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Run `bae init`, select Telegram, paste your token

**Find your user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your numeric user ID.

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Paste the contents of [`slack-manifest.json`](slack-manifest.json) from this repo
3. Under **Basic Information** → **App-Level Tokens**, generate one with `connections:write` scope
4. Under **Install App**, install to your workspace
5. Run `bae init`, select Slack, paste both tokens

**Find your user ID:** Click your profile in Slack → **⋯** menu → **Copy member ID**.

Slack uses Socket Mode (outbound WebSocket) — no tunnel or public URL needed.

### iMessage (macOS only)

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add your terminal app (Terminal, iTerm, Warp, etc.) — this allows Bae to read your Messages database while it's running. **Keep this enabled** as long as you use Bae with iMessage.
3. **Restart your terminal** (required — macOS doesn't apply the permission until restart)
4. Run `bae init`, select iMessage

No credentials needed. Text yourself ("Note to Self") to chat with your agent. Agent responses are prefixed with `Bae:` so you can tell them apart.

## Usage

```bash
bae start -d       # Start in background (recommended)
bae start          # Start in foreground (see all logs)
bae stop           # Stop the daemon
bae status         # Check if running
bae logs           # Tail daemon logs
```

### Commands in chat

| Command | What it does |
|---------|-------------|
| `/new` | Start a fresh agent session (clears context) |
| `/start` | Welcome message (Telegram only) |
| Everything else | Goes directly to your agent |

### Adding more channels

Already running Telegram? Add Slack too:

```bash
bae channel add --platform slack
```

Bae auto-detects your workspace. All channels share the same agent and project context.

## Multi-Workspace

Each workspace is a folder on disk. Create separate workspaces for different projects:

```bash
# Go to your project folder
cd ~/research
bae workspace add research

# Or specify the path explicitly
bae workspace add research --path ~/research

# Add a channel to it
bae channel add research --platform telegram

# List everything
bae workspace list
bae channel list
```

Everything in the workspace folder (CLAUDE.md, git history, project files) is the agent's context. Swap the agent anytime without losing context:

```bash
bae workspace set-executor research codex
```

## How It Works

| Platform | Connection | Streaming | Formatting |
|----------|-----------|-----------|------------|
| Telegram | Long polling | Edit-in-place | HTML |
| Slack | Socket Mode (WebSocket) | Native streaming API | Markdown |
| iMessage | Database polling (2s) | No streaming | Plain text |

All connections are **outbound** — Bae never needs a public URL, tunnel, or webhook endpoint. Works behind any firewall or NAT.

## Status

Phase 3 — Telegram + Slack + iMessage, multi-workspace, session continuity, streaming, steering, daemon mode, interactive CLI.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
