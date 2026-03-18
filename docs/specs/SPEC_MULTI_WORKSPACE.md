# SPEC: Multi-Workspace Architecture

> Status: **Implemented** — landed in `feat/multi-workspace-schema` branch.
> Date: 2026-03-17

## 1. Overview

BAE currently supports a single workspace (one folder, one bot token, one agent). This spec defines the evolution to **multi-workspace** — multiple independent agent identities running from a single BAE process, each with its own folder, channels, and sessions.

## 2. Core Concepts

### 2.1 Hierarchy

```
Server (one BAE process)
  └── Workspace ("Amy", ~/research, executor: claude-code)
        ├── Channel (Telegram bot @AmyResearchBot)
        │     ├── DM with user 456 → session A (resumes)
        │     ├── DM with user 789 → session B (resumes)
        │     └── Group chat 101 → session C (resumes)
        ├── Channel (Slack app "Amy" in WorkspaceHQ)
        │     ├── DM with user U01 → session D (resumes)
        │     └── Channel #research → session E (resumes)
        └── Channel (Resend email amy@research.co)
              └── Thread with alice@example.com → session F
```

### 2.2 Workspace = Agent Identity

A workspace IS the agent. It is defined by:

- **A folder on disk** — the agent's working directory (`~/research`, `~/news-ingestion`)
- **An executor** — which CLI agent to spawn (Claude Code, Codex, etc.), swappable anytime
- **A name/slug** — human-readable identifier ("amy", "news-bot")

Everything in the folder constitutes the agent's identity: `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `SOUL.md`, symlinked skills, git history, project files. Changing the executor (e.g. Claude Code → Codex) does NOT change the identity — the folder stays the same, so all context is preserved.

### 2.3 Channel = Communication Pipe

A channel is how users reach a workspace. It is NOT a "bot" — that term is platform-specific. A Resend email channel is not a bot, it's just a way to talk to Amy.

- One workspace can have many channels (Telegram + Slack + email)
- One channel belongs to exactly one workspace
- Constraint: one channel per platform per workspace (Amy has one Telegram presence, not two)

**The channel IS the routing key.** When a message arrives, BAE knows which bot/API received it → looks up the channel → resolves the workspace. No ambiguity.

### 2.4 Session = A Conversation on a Channel

A session is a specific conversation within a channel:

- DM with user 456 on Amy's Telegram = one session
- Group chat 101 on Amy's Telegram = a different session
- Same Amy, same channel, different sessions

Sessions maintain resume functionality (`agent_session_id` / `--resume`). `/new` clears the session and starts fresh within the same channel. Sessions are NOT shared across platforms — what you discussed with Amy on Telegram doesn't appear in your Slack conversation with her.

**However**, the project context IS shared because all channels for a workspace spawn the agent in the same folder. The files, git history, and memory files are inherently shared.

## 3. Schema

### 3.1 Tables

```sql
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,        -- slug: "amy", "news-bot"
  name        TEXT NOT NULL,           -- display: "Amy - Research Assistant"
  path        TEXT NOT NULL UNIQUE,    -- ~/research (expanded, absolute)
  executor    TEXT NOT NULL DEFAULT 'claude-code',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE channels (
  id            TEXT PRIMARY KEY,      -- generated: "chan_k7x9m2"
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  platform      TEXT NOT NULL,         -- "telegram", "slack", "resend", "discord"
  label         TEXT,                  -- "Amy on Telegram" (optional, for GUI)
  config        TEXT,                  -- non-secret platform config (JSON)
  allowed_users TEXT,                  -- comma-separated user IDs (per-channel access control)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, platform)       -- one channel per platform per workspace
);

CREATE TABLE sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  channel_id        TEXT NOT NULL REFERENCES channels(id),
  conversation_id   TEXT NOT NULL,     -- platform-specific: chat ID, channel ID, email thread
  agent_session_id  TEXT,              -- executor's resume token
  status            TEXT NOT NULL DEFAULT 'idle',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, conversation_id)  -- one session per conversation per channel
);
```

### 3.2 Key Design Decisions

- **`conversation_id`** (not `chat_id` or `thread_id`) — platform-agnostic name that maps to Telegram chat IDs, Slack channel IDs, Discord channel IDs, email thread IDs, WhatsApp phone numbers, etc.
- **`UNIQUE(workspace_id, platform)` on channels** — prevents duplicate platform bindings per workspace. Can be relaxed later if a real use case emerges.
- **`UNIQUE(channel_id, conversation_id)` on sessions** — one resumable session per conversation per channel.
- **`allowed_users` per channel** — access control is per-channel, not global. Amy might be private (only you), News Bot might serve a team.

### 3.3 Credential Storage

**Secrets are NOT stored in SQLite.** They live on the filesystem:

```
~/.bae/
  ├── bae.db                          # schema + references only
  └── credentials/
      ├── chan_k7x9m2.env             # TELEGRAM_BOT_TOKEN=...       (mode 0600)
      ├── chan_p3q8n1.env             # SLACK_BOT_TOKEN=...          (mode 0600)
      │                              # SLACK_SIGNING_SECRET=...
      └── chan_r5t2w7.env             # RESEND_API_KEY=...           (mode 0600)
                                      # RESEND_FROM=amy@research.co
```

Each platform adapter knows which env vars it needs and loads them from the channel's credential file at runtime. This pattern:

- Matches the existing `~/.bae/.env` approach (mode 0600, owner-only)
- Keeps secrets out of database backups/copies
- Works cleanly with the Tauri GUI (write directly to credential file)
- Is platform-agnostic (each platform needs different credential shapes)

**Credential shapes by platform:**

| Platform | Env vars in credential file |
|----------|---------------------------|
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` |
| WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |

### 3.4 Non-Secret Channel Config

The `channels.config` JSON column stores platform-specific configuration that is NOT secret:

```json
// Telegram channel
{ "parse_mode": "HTML" }

// Resend channel
{ "from_name": "Amy", "reply_to": "support@research.co" }

// Slack channel
{ "app_id": "A0123456789" }
```

This keeps the schema generic while allowing per-platform configuration without schema changes.

## 4. Routing

### 4.1 Message Flow

```
Message arrives on platform API
  → Platform adapter identifies which channel received it
     (each bot token / API key = one Chat SDK instance = one channel)
  → Look up channel → get workspace_id, executor, path
  → Extract conversation_id from message context
     (Telegram: chat.id, Slack: channel, Discord: channel_id, Email: thread-id)
  → Get-or-create session for (channel_id, conversation_id)
  → Spawn executor in workspace.path with session resume token
  → Stream response back through the originating channel
```

### 4.2 Multi-Bot Polling

BAE creates one Chat SDK / adapter instance per channel. Each instance polls its own bot token independently. This is safe because:

- **Different tokens = different polling connections.** Telegram (and other platforms) only reject multiple connections on the SAME token. Multiple bots with different tokens in a single Node.js process works fine — each `TelegramBot` instance maintains its own long-polling loop.
- **Memory is the main constraint.** Each polling instance consumes ~10-20MB. 5 workspaces with 2 channels each = ~10 instances = ~100-200MB. Acceptable for a personal tool.
- **Chat SDK supports this.** The `chat` package creates separate instances per adapter. Multiple `Chat` objects with different tokens coexist in one process.

**References:**
- [node-telegram-bot-api: Multiple bots issue #446](https://github.com/yagop/node-telegram-bot-api/issues/446) — confirms multiple instances with different tokens work
- [Chat SDK Telegram adapter](https://www.chat-sdk.dev/docs/adapters/telegram) — one adapter per token

### 4.3 Workspace Switching

There is NO workspace switching from within IM. The channel binding determines the workspace — period. To talk to a different workspace, message a different bot.

Workspace management (create, configure, bind channels) happens exclusively via CLI (`bae workspace add`) or the Tauri GUI. This keeps the IM experience simple: you're always talking to Amy (or whoever that bot is), no mode switching.

## 5. Executor Swappability

The executor is a workspace-level setting. Changing it means: "from now on, when I talk to Amy, use Codex instead of Claude Code."

Because the executor always spawns in the workspace folder, switching executors is seamless:

- All context files (`CLAUDE.md`, `AGENTS.md`, etc.) are in the folder
- Git history is in the folder
- The `agent_session_id` from a previous executor won't work with the new one — but that's expected. The session continues in the folder, not in the agent's memory.
- From the user's perspective: "Amy switched brains but remembers everything" (via files/context, not conversation history).

## 6. Access Control

Access control is **per-channel**, not global:

- Amy's Telegram channel: only user 456 can DM her
- News Bot's Telegram channel: users 456, 789, 101 can all use it
- Amy's Slack channel: inherited from Slack workspace permissions + BAE allowlist

The `allowed_users` field on the `channels` table stores a comma-separated list of platform-specific user IDs, matching the current `BAE_ALLOWED_USERS` pattern but scoped to each channel.

## 7. Migration Path

Since BAE currently has zero production users, migration is straightforward:

1. Create `workspaces` table, insert one row from current `BAE_CWD`
2. Create `channels` table, insert one row from current bot token config
3. Rename `thread_id` → `conversation_id` in sessions table
4. Add `workspace_id` and `channel_id` FK columns to sessions
5. Move `TELEGRAM_BOT_TOKEN` from `~/.bae/.env` to `~/.bae/credentials/{channel_id}.env`
6. Backfill session rows with workspace/channel references

**Best done now** — before users exist. Zero migration pain.

## 8. CLI Surface

```bash
# Workspace management
bae workspace list
bae workspace add <slug> --name "Amy" --path ~/research --executor claude-code
bae workspace remove <slug>
bae workspace set-executor <slug> codex

# Channel management
bae channel list [--workspace <slug>]
bae channel add <workspace-slug> --platform telegram --label "Amy on Telegram"
  # → prompts for credentials, writes to ~/.bae/credentials/{id}.env
bae channel remove <channel-id>

# Start server (polls all channels across all workspaces)
bae start [-d]
```

## 9. Open Questions

- **Channel config validation** — should BAE validate that credentials work (e.g., call `getMe` on Telegram) during `bae channel add`? Probably yes.
- **Workspace templates** — should `bae workspace add` scaffold the folder with starter files (CLAUDE.md, etc.)? Nice-to-have, not required.
- **Cross-workspace messaging** — should Amy be able to ask News Bot something? Out of scope for now. Revisit when there's demand.

## 10. Relationship to Roadmap

This spec intersects with:

- **Phase 3 (Platform Expansion)** — adding Slack/Discord means adding new platform adapters that plug into the channel system
- **Phase 4 (Tauri + ACP)** — the GUI manages workspaces and channels; ACP may change how executors communicate

Whether to implement multi-workspace before or alongside Phase 3 is a separate decision. The schema can land first as it's backward-compatible with single-workspace usage.
