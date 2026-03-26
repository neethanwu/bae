# Bae — Your Agent, In Your Pocket

[![npm version](https://img.shields.io/npm/v/bae-bridge)](https://www.npmjs.com/package/bae-bridge)
[![npm downloads](https://img.shields.io/npm/dm/bae-bridge)](https://www.npmjs.com/package/bae-bridge)

> Access your agents from anywhere — continuously.

```
 ██████╗  █████╗ ███████╗
 ██╔══██╗██╔══██╗██╔════╝
 ██████╔╝███████║█████╗
 ██╔══██╗██╔══██║██╔══╝
 ██████╔╝██║  ██║███████╗
 ╚═════╝ ╚═╝  ╚═╝╚══════╝
```

## What Is Bae?

You already have powerful agents. Bae lets you reach them from your pocket.

```
Your Phone                     Your Machine
┌─────────────┐               ┌─────────────────────────────────┐
│  Telegram   │               │                                 │
│  Slack      │◀── Bae ──────▶│  Claude Code / Codex / OpenCode │
│  WeChat     │               │                                 │
│  Email      │               │                                 │
└─────────────┘               │  Your files, skills, MCP tools  │
                              └─────────────────────────────────┘
```

**What makes Bae different:**

- **No API keys needed** — uses your existing agent subscription (Claude Max, etc.)
- **Full agent power** — file editing, bash, code generation, web search — everything your agent can do locally
- **No tunnel or server** — all connections are outbound (long polling, Socket Mode, database polling)
- **Multi-platform** — Telegram, Slack, WeChat, and Email today. Discord coming soon.
- **Conversation continuity** — messages in the same thread share agent context
- **Agent-agnostic** — swap between agents without losing project context

## Supported Agents

Bae works with any CLI agent that accepts prompts and produces text output. The agent runs on your machine with your local auth — no API keys needed.

| Agent | Status |
|-------|--------|
| [Claude Code](https://docs.anthropic.com/s/claude-code) | **Supported** |
| [Codex](https://github.com/openai/codex) | Testing |
| [OpenCode](https://github.com/opencode-ai/opencode) | Testing |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Testing |
| [Amp](https://ampcode.com/) | Testing |

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

### 4. Done!

`bae init` starts Bae automatically when setup completes. Message your bot and start chatting. Use `bae logs` to watch what's happening, and `bae stop` when you're done.

## Platform Setup

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric user ID
5. Run `bae init`, select Telegram, paste your token and user ID

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Run `bae init` or `bae channel add --platform slack` — the manifest is copied to your clipboard automatically
3. Under **Basic Information** → **App-Level Tokens**, generate one with `connections:write` scope
4. Under **Install App**, install to your workspace
5. Run `bae init`, select Slack, paste both tokens

**Find your user ID:** Click your profile in Slack → **⋯** menu → **Copy member ID**.

Slack uses Socket Mode (outbound WebSocket) — no tunnel or public URL needed.

### WeChat

1. Run `bae init` (or `bae channel add --platform wechat`)
2. A QR code appears in your terminal — scan it with WeChat on your phone
3. Confirm the connection in WeChat
4. Done — message the bot from your WeChat to talk to your agent

**How it works:** WeChat uses Tencent's iLink Bot API — all connections are outbound (HTTP long-polling), no tunnel needed. Messages are plain text only. Your WeChat user ID will be shown during setup for the allowed users list.

### Email (AgentMail)

1. Run `bae init` (or `bae channel add --platform email`)
2. Sign up for a free [AgentMail](https://agentmail.to) account (3 inboxes, 3,000 emails/month)
3. Paste your API key — Bae creates an inbox for your agent
4. Done — send an email to your agent's address to start a conversation

**How it works:** Email uses [AgentMail](https://agentmail.to) for inbox management — WebSocket for real-time inbound email, no tunnel needed. Each email thread maps to an agent session. Replies are sent in-thread automatically. You own your AgentMail account; Bae just manages the connection.

## Usage

```bash
bae start -d              # Start in background (recommended)
bae start                 # Start in foreground (see all logs)
bae start --port 8080     # Use a custom port (default: 19456)
bae stop                  # Stop the daemon
bae status                # Check if running
bae logs                  # Tail daemon logs
bae upgrade               # Update to latest version (restarts if running)
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

Bae auto-detects your workspace and restarts automatically — no manual restart needed. All channels share the same agent and project context.

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

Everything in the workspace folder (CLAUDE.md, git history, project files) is the agent's context. When more agents are supported, you'll be able to swap anytime without losing context:

```bash
bae workspace set-executor research codex    # coming soon
```

## How It Works

> **DM-only for now.** Bae focuses on personal use — direct messages between you and your agent. Group chat support is planned for a future release.



| Platform | Connection | Streaming | Formatting |
|----------|-----------|-----------|------------|
| Telegram | Long polling | Edit-in-place | HTML |
| Slack | Socket Mode (WebSocket) | Native streaming API | Markdown |
| WeChat | Long polling (iLink API) | No streaming | Plain text |
| Email | WebSocket (AgentMail) | No streaming | Plain text |

All connections are **outbound** — Bae never needs a public URL, tunnel, or webhook endpoint. Works behind any firewall or NAT.

## Always On

Bae is designed to stay running without babysitting:

- **Auto-updates** — checks for new versions on startup and every 6 hours while running. Updates install and restart seamlessly. Opt out with `BAE_NO_AUTO_UPDATE=1`.
- **Survives crashes** — `bae start -d` automatically restarts if something goes wrong.
- **Survives sleep** — on macOS, Bae picks back up when your Mac wakes from sleep.
- **Manual update** — run `bae upgrade` to update immediately.

## Status

Phase 3 — Telegram, Slack, WeChat, Email, multi-workspace, session continuity, streaming, steering, daemon mode, interactive CLI, auto-updates.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
