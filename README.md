# Bae — Your AI, Always On

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
Your Phone                    Your Machine
┌────────────┐               ┌──────────────────────────────────────┐
│            │               │                                      │
│  Telegram  │◀── polling ──▶│  ┌───────┐      ┌─────────────────┐ │
│  Slack     │◀── polling ──▶│  │  Bae  │─────▶│  Local Agents   │ │
│  Discord   │◀── polling ──▶│  │       │◀─────│  Claude Code    │ │
│            │               │  └───────┘      │  Codex          │ │
└────────────┘               │                 │  OpenCode       │ │
                             │                 │  Amp, etc.      │ │
                             │                 └─────────────────┘ │
                             │                                      │
                             │  Your filesystem, skills, MCP servers│
                             └──────────────────────────────────────┘
```

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Type safety for message parsing |
| Runtime | Bun | Native TS, built-in SQLite, fast subprocess spawning, single binary via `bun build --compile` |
| HTTP | Hono | Health check + future dashboard API (~14kb) |
| IM | Vercel Chat SDK | Unified interface for Telegram, Slack, Discord — long polling + webhook |
| Agent | Subprocess | Agent-agnostic; `--resume` for conversation continuity |
| Storage | SQLite | Session persistence at `~/.bae/bae.db` via `bun:sqlite` |

## Install

```bash
# Homebrew (macOS)
brew install bae-dev/tap/bae

# curl
curl -fsSL https://getbae.dev/install | bash

# npm
bun add -g bae

# Docker
docker run -d --name bae \
  -v ~/.bae:/root/.bae \
  -v ~/.claude:/root/.claude \
  -e TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN \
  -e BAE_ALLOWED_USERS=$BAE_ALLOWED_USERS \
  ghcr.io/bae-dev/bae:latest
```

A desktop app (macOS, Windows, Linux) is planned.

## Status

Phase 1a complete — session continuity working. See [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for roadmap.

## License

MIT
