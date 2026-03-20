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
- **Agent-agnostic** — swap between Claude Code, Codex, or any CLI agent without losing project context

## Quick Start

### 1. Install

```bash
npm install -g bae-bridge
```

### 2. Make sure your agent is ready

```bash
claude --version    # Claude Code must be installed and authenticated
```

### 3. Set up your first channel

```bash
bae init
```

The wizard walks you through everything:
- Choose your platform (Telegram, Slack, or iMessage)
- Enter your credentials (or none for iMessage)
- Pick your workspace directory (defaults to your current folder)
- Set allowed user IDs

### 4. Start

```bash
bae start
```

That's it. Message your bot and start chatting with your agent.

## Platform Setup

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Run `bae init`, select Telegram, paste your token

**Find your user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram.

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
2. Add your terminal app (Terminal, iTerm, Warp, etc.)
3. **Restart your terminal** (required — won't work without this)
4. Run `bae init`, select iMessage

No credentials needed — iMessage reads from your local Messages database and sends via AppleScript. Text yourself ("Note to Self") to chat with your agent. Agent responses are prefixed with `Bae:` so you can tell them apart.

## Usage

```bash
bae start          # Start in foreground
bae start -d       # Start in background (daemon mode)
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

Each workspace is a folder on disk — the agent's working directory. Create separate workspaces for different projects:

```bash
# Add a workspace
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

| Platform | Connection | Streaming |
|----------|-----------|-----------|
| Telegram | Long polling (Chat SDK) | Edit-in-place |
| Slack | Socket Mode (WebSocket) | Native streaming API |
| iMessage | SQLite database polling | No streaming (plain text) |

All connections are **outbound** — Bae never needs a public URL, tunnel, or webhook endpoint. It works behind any firewall or NAT.

## Status

Phase 3 — Telegram + Slack + iMessage, multi-workspace, session continuity, streaming, steering, daemon mode, interactive CLI.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
