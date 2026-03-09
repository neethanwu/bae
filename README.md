# Bae — Your AI, Always On

> Turn any always-on machine into a personal AI agent server, accessible from your messaging apps.

## What Is Bae?

Bae is a **tunnel** — a thin, opinionated relay that connects your messaging apps (Telegram, Slack, Discord) to CLI-based coding agents (Claude Code, Codex, OpenCode, etc.) running on your home machine. The agent is the brain. Bae is the phone line.

**Bae is not** an AI framework, an agent SDK, a Claude Code plugin system, or an API wrapper. It does not modify, enhance, or intercept the agent's capabilities. Whatever your agent can do locally, you can now do from your phone.

## Why Bae?

You have a Mac Mini (or any always-on computer) at home. You have Claude Code installed with a Max subscription. You have Telegram on your phone. Bae connects them:

```
Your Phone (Telegram)  →  Bae (bridge)  →  claude -p (on your Mac)
```

- **No API keys needed** — uses your existing Claude Code subscription auth
- **Full agent power** — file editing, bash execution, code generation, web search
- **Agent-agnostic** — designed for Claude Code first, extensible to Codex, OpenCode, Gemini CLI, Amp
- **Zero-config networking** — `cloudflared` tunnel, one command
- **Never goes out of date** — when your agent gets new features, Bae gets them for free

## Architecture

```
  Your Phone                        Your Mac Mini (always on)
 ┌──────────┐                      ┌────────────────────────────────┐
 │ Telegram  │──webhook──┐         │                                │
 │ Slack     │──webhook──┤  tunnel  │  ┌──────┐     ┌────────────┐  │
 │ Discord   │──webhook──┼────────▶│  │ Bae  │────▶│ claude -p  │  │
 │ ...       │           │         │  │      │◀────│ (or codex  │  │
 └──────────┘            │         │  └──┬───┘     │  exec, etc)│  │
                         │         │     │         └────────────┘  │
                         │         │     │  Your filesystem        │
                         │         │     │  Your skills/config     │
                         │         │     │  Your MCP servers       │
                         │         └────────────────────────────────┘
                         │
                    cloudflared tunnel
                    (one command, zero config)
```

## Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Chat SDK is TS; type safety for message parsing |
| Runtime | Bun | Native TS, built-in SQLite, fast subprocess spawning |
| HTTP | Hono | Minimal webhook receiver (~14kb) |
| IM Abstraction | Vercel Chat SDK | Write once → Telegram, Slack, Discord, Teams, etc. |
| Agent Backend | `claude -p` subprocess | Subscription-friendly, full agent capabilities |
| Tunnel | cloudflared | One binary, one command, free, no account needed |

## Quick Start

```bash
# Prerequisites: Bun, Claude Code installed & authenticated

# Clone and install
git clone <repo-url> && cd bae
bun install

# Set env vars
export TELEGRAM_BOT_TOKEN="your-bot-token"    # from @BotFather
export BAE_ALLOWED_USERS="your-telegram-id"   # from @userinfobot

# Run (polling mode — no tunnel needed for local dev)
bun run dev
```

For webhook mode (production), start a tunnel and register the webhook:

```bash
npx cloudflared tunnel --url http://localhost:3456
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://YOUR-TUNNEL-URL/webhook/telegram"
```

## License

MIT
