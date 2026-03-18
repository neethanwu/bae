# Bae — Your AI, Always On

[![npm version](https://img.shields.io/npm/v/bae-bridge)](https://www.npmjs.com/package/bae-bridge)

> Turn any always-on machine into a personal AI agent server, accessible from your messaging apps.

## What Is Bae?

Bae is a **tunnel** — a thin, opinionated relay that connects your messaging apps (Telegram, Slack, Discord) to CLI-based coding agents (Claude Code, Codex, OpenCode, etc.) running on your machine. The agent is the brain. Bae is the phone line.

**Bae is not** an AI framework, an agent SDK, or an API wrapper. It does not modify, enhance, or intercept the agent's capabilities. Whatever your agent can do locally, you can now do from your phone.

## Why Bae?

You have an always-on machine at home. You have Claude Code installed with a Max subscription. You have Telegram on your phone. Bae connects them:

```
Your Phone (Telegram)  →  Bae (bridge)  →  Local Agent (on your machine)
```

- **No API keys needed** — uses your existing agent subscription auth
- **Full agent power** — file editing, bash execution, code generation, web search
- **Agent-agnostic** — Claude Code first, extensible to Codex, OpenCode, Gemini CLI, Amp
- **No tunnel needed** — long polling, no public URL, no signup, no extra processes
- **Conversation continuity** — messages in the same thread share agent context
- **Never goes out of date** — when your agent gets new features, Bae gets them for free

## Architecture

```
Your Phone                     Your Machine
┌─────────────┐               ┌─────────────────────────────────────────┐
│             │               │                                         │
│  Telegram   │◀── polling ──▶│  ┌───────┐       ┌───────────────────┐  │
│  Slack      │◀── polling ──▶│  │  Bae  │──────▶│  Local Agents     │  │
│  Discord    │◀── polling ──▶│  │       │◀──────│  Claude Code      │  │
│             │               │  └───────┘       │  Codex            │  │
└─────────────┘               │                  │  OpenCode         │  │
                              │                  │  Amp, etc.        │  │
                              │                  └───────────────────┘  │
                              │                                         │
                              │  Your filesystem, skills, MCP servers   │
                              └─────────────────────────────────────────┘
```

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Type safety for message parsing |
| Runtime | Node.js 20+ / Bun | Cross-runtime; SQLite via `better-sqlite3` (Node) or `bun:sqlite` (Bun) |
| HTTP | Hono | Health check + future dashboard API (~14kb) |
| IM | Vercel Chat SDK | Unified interface for Telegram, Slack, Discord — long polling + webhook |
| Agent | Subprocess | Agent-agnostic; `--resume` for conversation continuity |
| Storage | SQLite | Session persistence at `~/.bae/bae.db` via `bun:sqlite` |

## Prerequisites

- **Node.js 20+** — runtime for the bridge
- **Claude Code** (or another supported agent) — installed and authenticated
- **Telegram Bot Token** — create one via [@BotFather](https://t.me/BotFather)

## Install

```bash
npm install -g bae-bridge
```

## Setup

Run the interactive wizard:

```bash
bae init
```

This walks you through:
- Telegram bot token (validated against Telegram API)
- Workspace directory (default: `~/baesment`)
- Allowed Telegram user IDs (for access control)

Config is stored in `~/.bae/` — credentials in per-channel files, workspace/channel config in SQLite.

## Usage

```bash
# Start in foreground
bae start

# Start in background (daemon mode)
bae start -d

# Check if running
bae status

# View logs (daemon mode)
bae logs

# Stop the daemon
bae stop
```

Once running, message your bot on Telegram. Send `/new` to start a fresh agent session.

## Multi-Workspace

Bae supports multiple workspaces, each with its own agent identity, folder, and communication channels.

```bash
# Add a workspace
bae workspace add research --name "Research" --path ~/research

# Bind a Telegram bot to it
bae channel add research --platform telegram

# List workspaces and channels
bae workspace list
bae channel list
```

Each workspace is a folder on disk — the agent's working directory. Everything in the folder (CLAUDE.md, git history, project files) constitutes the agent's context. You can swap the underlying agent (Claude Code, Codex, etc.) without losing context:

```bash
bae workspace set-executor research codex
```

## Status

Phase 2 complete — Telegram bridge with session continuity, streaming, steering, daemon mode, multi-workspace support, and CLI management.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
