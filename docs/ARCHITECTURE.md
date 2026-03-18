# ARCHITECTURE.md — Bae System Architecture

## 1. Design Philosophy

1. **Bae is a tunnel, not a brain.** It does not modify, wrap, or enhance the agent's capabilities. It passes messages through and streams responses back. The agent (Claude Code, Codex, etc.) is the brain.

2. **Bae is agent-agnostic.** The `Executor` interface abstracts over any CLI agent that speaks JSONL. Claude Code is the first backend. Codex, OpenCode, Gemini CLI, and Amp can be added with ~50 lines each.

3. **Bae is platform-agnostic.** It runs on macOS, Linux, and Windows (WSL). IM support covers Telegram, Slack, and Discord via the Chat SDK's adapter system.

4. **Bae is user-config-free for the agent.** Users configure their agent directly (CLAUDE.md, skills, MCP servers, allowed tools). Bae doesn't know or care what the agent is configured to do.

## 2. System Overview

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                       User's Machine                              │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                      Bae Process                              │ │
│  │                                                               │ │
│  │  ┌───────────┐    ┌─────────────┐    ┌──────────────────┐    │ │
│  │  │ Chat SDK  │    │             │    │    Executor       │    │ │
│  │  │ (polling) │───▶│   Bridge    │───▶│  ┌─────────────┐ │    │ │
│  │  │           │    │             │    │  │ Claude Code │ │──┐ │ │
│  │  │ Telegram  │    │ - Auth      │    │  └─────────────┘ │  │ │ │
│  │  │ Slack     │    │ - Commands  │    │  ┌─────────────┐ │  │ │ │
│  │  │ Discord   │    │ - Dispatch  │    │  │ Codex       │ │  │ │ │
│  │  └───────────┘    │ - Format    │    │  │ (future)    │ │  │ │ │
│  │                   └──────┬──────┘    │  └─────────────┘ │  │ │ │
│  │                          │           └──────────────────┘  │ │ │
│  │  ┌───────────┐     ┌────▼──────┐                           │ │ │
│  │  │ Hono HTTP │     │  Session  │    ┌──────────────────┐   │ │ │
│  │  │ /health   │     │  Manager  │    │  Formatter       │   │ │ │
│  │  │ /api/*    │     └────┬──────┘    │  (per platform)  │   │ │ │
│  │  └───────────┘     ┌────▼──────┐    │  - Telegram      │   │ │ │
│  │                    │  Session  │    │  - Slack          │   │ │ │
│  │                    │  Store    │    │  - Discord        │   │ │ │
│  │                    │ (SQLite)  │    └──────────────────┘   │ │ │
│  │                    └───────────┘                            │ │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────┐                                   ┌────────┐│
│  │ Agent CLI         │ ← subprocess per message         │ ~/     ││
│  │ (claude, codex,   │   spawned by Executor            │ baesment│
│  │  opencode, etc.)  │   --resume for continuity        │        ││
│  └──────────────────┘                                   └────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow — Happy Path

```
1. User sends "fix the bug in server.ts" on Telegram
                    │
                    ▼
2. Chat SDK long-polls Telegram's getUpdates API
   (no tunnel, no webhook, no public URL needed)
                    │
                    ▼
3. Chat SDK fires onNewMessage handler
                    │
                    ▼
4. Bridge receives (thread, message)
   a. Auth check — is this user in the allowlist?
   b. Command check — is this a /new, /start?
   c. Start typing indicator
   d. Dispatch to session manager
                    │
                    ▼
5. Session manager:
   a. Looks up session in SQLite (platform + threadId)
   b. If new → creates session entry
   c. If existing → retrieves agentSessionId for --resume
                    │
                    ▼
6. Executor spawns:
   claude -p --output-format stream-json --verbose \
     --dangerously-skip-permissions \
     [--resume <agentSessionId>] \
     -- "fix the bug in server.ts"
                    │
                    ▼
7. Stream pipeline:
   stdout → parseJSONLStream → transformClaudeEvent → AgentEvent[]
   Events: init → text_delta* → tool_use* → result
                    │
                    ▼
8. Bridge consumes events:
   - init: store agentSessionId in SQLite
   - text_delta: accumulate response → formatter
   - tool_use: log tool name, optionally show status
   - result: finalize, post to IM
                    │
                    ▼
9. Formatter transforms for target platform:
   - Telegram: plain text (Chat SDK adapter limitation), 4096 char limit, code-fence-aware splitting
   - Slack: Block Kit, 3000 char limit, threading (future)
   - Discord: Markdown, 2000 char limit, embeds for code (future)
                    │
                    ▼
10. Chat SDK posts formatted response back to IM
```

### 2.3 Conversation Continuity (--resume)

```
1. User replies in same thread: "now run the tests"
                    │
                    ▼
2. Session manager finds agentSessionId from prior message
                    │
                    ▼
3. Executor spawns with --resume:
   claude -p --resume <agentSessionId> -- "now run the tests"
                    │
                    ▼
4. Agent continues conversation with full prior context
   (all previous messages, tool uses, file states preserved)
                    │
                    ▼
5. Same streaming → formatting → posting flow
```

## 3. Architectural Decisions

### 3.1 Option B: Spawn-Per-Message with --resume

**Decision:** Spawn a new process per message, use `--resume <sessionId>` for continuity.

**Why not persistent process (Option A)?**
- `claude -p --input-format stream-json` did not reliably accept stdin after emitting a result
- Option B confirmed working: `--resume` preserves full conversation context
- Simpler lifecycle — no process pooling, idle timeouts, or crash recovery for long-lived processes
- Trade-off: no mid-stream steering yet (see §8)

### 3.2 Long Polling over Webhooks

**Decision:** Use Telegram long polling (`getUpdates`) instead of webhooks.

**Why:**
- No tunnel dependency (ngrok, cloudflared) — eliminates signup, DNS issues, extra processes
- Works on any machine without public IP or port forwarding
- One command to start: `bun run dev`
- Chat SDK supports it natively via `mode: "auto"` (auto-detects local vs serverless)
- Distributable — no external tooling required for end users

Webhook mode remains available in the Chat SDK for serverless deployments, but Bae's primary use case (personal machine) doesn't need it.

### 3.3 Formatter Per Platform

**Decision:** Each IM platform gets its own formatter. The bridge is platform-agnostic.

**Planned interface** (extracted when 2nd platform arrives):

```typescript
interface PlatformFormatter {
  readonly name: string;
  readonly maxMessageLength: number;
  startTyping(thread: Thread): Promise<void>;
  formatResponse(text: string): string;
  splitMessage(text: string): string[];
  formatToolUse(toolName: string, input: string): string;
  formatError(message: string): string;
}
```

**Per-platform details:**

| Platform | Char limit | Format | Typing API |
|----------|-----------|--------|------------|
| Telegram | 4096 | Plain text (Chat SDK adapter sends no `parse_mode`) | `sendChatAction("typing")` every 4s |
| Slack | 3000 (recommended) | mrkdwn / Block Kit | `chat.meTyping` |
| Discord | 2000 | Standard Markdown | Gateway typing event |

**Current state:** Telegram formatter in `src/formatter/telegram.ts`. When Slack arrives, extract the `PlatformFormatter` interface from both concrete implementations.

**Key rules for message splitting:**
- Split at paragraph boundaries (`\n\n`)
- If paragraph too long, split at line boundaries (`\n`)
- **Never split inside a code fence** (track ``` open/close state)
- Reserve ~100 chars for formatting overhead

### 3.4 No Tunnel in Architecture

Bae does not include, manage, or require a tunnel. Long polling handles IM platforms. If a user wants webhooks for a specific deployment, they bring their own reverse proxy — that's their infrastructure, not Bae's.

### 3.5 No Skills/Plugin Installation

**Decision:** Bae is not distributed as a Claude Code skill or MCP plugin.

**Why:**
- Skills are for enhancing the agent's capabilities. Bae is infrastructure — it runs the agent, not inside it.
- Installation via skill would be a confusing UX: "install a skill to talk to the agent that runs the skill"
- Bae needs its own lifecycle (start/stop/status), config, and persistent state — none of which fit the skill model
- Distribution via npm, Homebrew, curl, and Tauri desktop app covers all user types

## 4. Single Package Architecture

### 4.1 Package Structure

Single package, multiple interfaces — inspired by QMD's architecture. No monorepo, no workspaces. One `src/`, one build, one publish.

**Why not monorepo?**
- Bae is small and single-maintainer — workspace overhead isn't justified
- Interfaces (Telegram bot, CLI, Tauri sidecar) are thin entry points — the real logic is bridge + session + executor + stream
- Tauri sidecar bundles a compiled binary — it doesn't import core as a library
- Splitting is easy later if needed: extract `packages/core` from `src/index.ts` facade

**Current structure:**

```
bae/
├── package.json               # single package, exports SDK + bin
├── biome.json                 # linter/formatter config
├── tsconfig.json
├── bin/bae                    # runtime wrapper (future)
│
├── src/
│   ├── index.ts               # PUBLIC API FACADE — the key abstraction
│   ├── bridge.ts              # core orchestration
│   ├── commands.ts            # command routing
│   ├── session/               # SQLite session store + manager
│   ├── executor/              # agent backends (Executor interface)
│   ├── stream/                # JSONL parser + AgentEvent transformer
│   ├── formatter/             # per-platform formatters
│   │   └── telegram.ts
│   ├── telegram/              # Telegram-specific entry (future)
│   │   └── bot.ts
│   ├── cli/                   # CLI entry (future)
│   │   └── main.ts            # arg parsing, config
│   └── server.ts              # Hono HTTP /health
│
└── src-tauri/                 # Tauri shell (future, when desktop arrives)
    └── tauri.conf.json        # sidecar: bundles compiled bin/bae
```

**The key pattern:** `src/index.ts` is the public API facade. CLI and Telegram bot import raw internals for fine-grained control. External consumers (MCP, SDK users) import only from the facade. This one file is what makes splitting into a monorepo easy later if it's ever needed.

**Reference:** [QMD 2.0](https://github.com/tobi/qmd) uses the same pattern — single package with `src/index.ts` as the public API, CLI and MCP server as separate entry points into the same codebase.

### 4.2 Distribution Channels

| Channel | Build | User gets | Needs Bun? |
|---------|-------|-----------|------------|
| CLI binary (primary) | `bun build --compile` | Single binary (~50-90MB) | No — bun runtime embedded |
| Homebrew | Downloads from GitHub Releases | `brew install bae` | No |
| curl install | Downloads from GitHub Releases | `curl -fsSL .../install \| bash` | No |
| Docker | Compiled binary in distroless | `docker run bae serve` | No |
| Desktop app | Tauri bundles compiled binary | `.dmg` / `.msi` / `.AppImage` | No |
| npm install -g | `npm install -g bae` | Global CLI | No — uses better-sqlite3 on Node |
| Development | `bun run dev` | Source checkout | Yes |

**Cross-runtime SQLite:** `src/session/db.ts` detects the runtime at startup and loads the appropriate SQLite library — `bun:sqlite` on Bun, `better-sqlite3` on Node.js. Uses QMD's `"bun:" + "sqlite"` string-concat trick to prevent TypeScript from resolving the bun import during Node builds. This means `npm install -g bae` works on both `node` and `bun`.

**Cross-compilation** via `bun build --compile --target`:
- `bun-darwin-arm64` (Apple Silicon)
- `bun-darwin-x64` (Intel Mac)
- `bun-linux-x64`, `bun-linux-arm64`
- `bun-windows-x64`

### 4.3 Tauri Integration

The desktop app uses the **sidecar pattern**: it bundles the compiled `bae` CLI binary and spawns it as a child process. The React webview communicates with it over localhost HTTP.

**Why sidecar over direct import:**
- Desktop app uses the exact same engine binary as CLI users
- One codebase to debug, not two runtime contexts
- Tauri's sidecar API handles process lifecycle (start, stop, restart)
- React frontend is a thin dashboard — setup wizard, session viewer, log tail

## 5. Component Specifications

### 5.1 Stream Pipeline (`stream/`)

```
subprocess stdout → parseJSONLStream() → transformClaudeEvent() → AgentEvent[]
```

**`AgentEvent` types:**
- `init` — session ID from agent
- `text_delta` — incremental text chunk
- `tool_use` — tool name + input
- `result` — turn complete, final text + metadata
- `error` — agent error

**Key design:** `transformClaudeEvent()` returns an **array** — one JSONL line can contain multiple content blocks (text + tool_use in the same assistant message).

### 5.2 Store (`session/store.ts`)

SQLite via `bun:sqlite` (Bun) or `better-sqlite3` (Node) at `~/.bae/bae.db`.

**Three-table schema (v1):**

```
Server (one BAE process)
  └── Workspace ("amy", ~/research, executor: claude-code)
        └── Channel (chan_k7x9m2a4bn, telegram)
              ├── DM with user 456 → session A (resumes)
              └── DM with user 789 → session B (resumes)
```

```sql
workspaces (id TEXT PK, name, path UNIQUE, executor CHECK('claude-code'))
channels   (id TEXT PK CHECK('chan_*'), workspace_id FK CASCADE, platform, allowed_users NOT NULL)
sessions   (id INTEGER PK, channel_id FK CASCADE, conversation_id, agent_session_id, status CHECK)
```

- **Workspace = agent identity.** A folder on disk with CLAUDE.md, AGENTS.md, etc. Executor is swappable.
- **Channel = communication pipe.** One bot token (Telegram), one app (Slack), etc. Not a "bot" — email isn't a bot.
- **Session = conversation within a channel.** One session per DM/group per channel. Resumes via `agent_session_id`.

**Key constraints:** ON DELETE CASCADE, CHECK on status/executor/channel ID format, FK indexes, `UNIQUE(workspace_id, platform)`.

**Credential storage:** Secrets (bot tokens) stored in `~/.bae/credentials/{channel_id}.env` (mode 0600), NOT in SQLite. Each platform adapter loads its credential file at startup.

**Schema versioning:** `PRAGMA user_version` (read via `queryGet`, set in transactions). Forward-only migrations.

**Pragmas:** WAL mode, foreign_keys ON (verified), busy_timeout 5000ms.

**No messages table yet** — conversation history is stored by the agent (Claude Code's `~/.claude/` directory).

### 5.3 Executor (`executor/`)

```typescript
interface Executor {
  readonly name: string;
  execute(options: ExecuteOptions): ExecuteResult;
}

interface ExecuteResult {
  events: AsyncIterable<AgentEvent>;
  sessionId: Promise<string>;
  kill(): Promise<void>;
}
```

Each agent backend implements `Executor`. Currently: `ClaudeCodeExecutor`.

### 5.4 Session Manager (`session/manager.ts`)

Maps channel conversations to agent sessions. The bridge talks to this, not directly to executors.

- `handleMessage(channelId, conversationId, text)` → resolves workspace from channel, creates executor per workspace type, spawns with `--resume` if session exists
- `clearSession(channelId, conversationId)` → for `/new` command
- Steering: active process with `send()` → writes to stdin instead of spawning new process
- Updates session status (idle/running) and stores agentSessionId on init

### 5.5 Bridge (`bridge.ts`)

Central orchestrator. Receives (thread, message) from Chat SDK, routes through session manager, consumes events, posts response.

**Responsibilities:** auth check → command routing → typing indicator → session dispatch → event consumption → formatter → response posting → logging.

### 5.6 Commands

| Command | Description |
|---------|-------------|
| `/new` | Clear session, start fresh conversation |
| `/start` | Welcome message (Telegram convention) |

**Design decision:** Minimal commands only. Bae is invisible infrastructure — users talk to the agent, not to Bae. Commands like `/cd`, `/status`, `/help` were considered and rejected because they're too tech-oriented, don't scale across platforms, and the agent can handle equivalent requests via natural language.

Everything that's not a `/command` is passed directly to the executor.

## 6. Security Model

### 6.1 Auth

Per-channel `allowed_users` — comma-separated list of platform user IDs stored on each channel row. Messages from other users are silently dropped. Parsed to `string[]` at query time (not on every message).

### 6.2 Agent Permissions

| Phase | Strategy | Mechanism |
|-------|----------|-----------|
| Phase 0-1 | Skip all | `--dangerously-skip-permissions` |
| Phase 1+ | Pre-approve | `--allowedTools "Bash,Read,Edit,..."` |
| Phase 2+ | External handler | `--permission-prompt-tool <mcp_tool>` (surface as IM buttons) |

### 6.3 Environment Variable Safety

The executor strips `CLAUDECODE` from the subprocess environment to prevent Claude Code's nested session check. No other env vars are modified.

### 6.4 Bot Token Security

If someone gets your bot token, they could message the agent. Mitigations:
- Per-channel `allowed_users` allowlist (user IDs are numeric and not guessable)
- `bae stop` kills the bridge instantly
- Tokens stored in per-channel credential files (`~/.bae/credentials/{id}.env`, mode 0600), NOT in SQLite
- Channel IDs validated with strict regex (`chan_[a-z0-9]{10}`) to prevent path traversal in credential file operations
- Bot tokens passed directly to Chat SDK adapter constructor (never set in `process.env`)

## 7. Technology Decisions

| Choice | Why |
|--------|-----|
| Bun | Native TS, built-in SQLite, fast subprocess spawning, `bun build --compile` for single binary |
| Hono | ~14kb, native Bun support, minimal HTTP layer for /health and future dashboard API |
| Chat SDK | Unified IM interface, long polling + webhook, thread management, typing indicators |
| SQLite | Zero config, cross-runtime (`bun:sqlite` on Bun, `better-sqlite3` on Node), durable session storage |
| Long polling | No tunnel, no signup, works anywhere, one command startup |
| Subprocess | Uses user's local auth (subscription), no API keys needed |
| Tauri | Cross-platform desktop app, Rust shell + React webview, sidecar pattern for CLI |

## 8. Steering (Phase 2)

### 8.1 What Is Steering?

Steering = sending messages while the agent is still working. In terminal-based agents, users can type "actually, focus on the auth middleware" while the agent is mid-response. The agent adjusts course without restarting.

### 8.2 Current State

Phase 1a uses spawn-per-message (Option B). Messages wait until the current turn completes — the Chat SDK's thread lock prevents concurrent processing.

### 8.3 Paths to Steering

| Approach | Status | How it works |
|----------|--------|--------------|
| Persistent stdin (Option A) | Needs reinvestigation | Keep `claude -p --input-format stream-json` process alive, write new messages to stdin mid-stream |
| Claude Agent SDK | Available | Async generator input pattern — yield new user messages as they arrive |
| ACP (Agent Client Protocol) | Emerging | Unified protocol for agent communication — OpenCode already has ACP server mode |

The Chat SDK side is already ready — `onSubscribedMessage` fires immediately regardless of whether a previous response is still streaming. The bridge receives the message; the question is how to deliver it to the agent mid-turn.

### 8.4 Agent Client Protocol (ACP)

ACP is an emerging protocol for standardized agent communication. Notable implementations:
- **OpenCode** — has an ACP server mode
- **acpx** — unified CLI surface for Codex, Claude, OpenCode via ACP

If ACP matures, Bae could add an ACP-based executor that talks to any ACP-compatible agent without custom subprocess wrappers. This would also naturally solve steering since ACP supports bidirectional streaming.

**Status:** Phase 3 investigation — evaluate whether ACP provides better UX than spawn+resume before building Tauri.

## 8.5 Roadmap

| Phase | Focus | Key deliverables |
|-------|-------|-----------------|
| 1 (done) | Telegram MVP | Session continuity, streaming, daemon CLI, npm publish |
| 2 | Steering | Mid-stream message injection, agent-side protocol investigation |
| 3 | Desktop + ACP | Tauri desktop app, ACP evaluation (vs spawn+resume), agent adapters |
| 4 | Platform expansion | Slack, Discord, Resend (email), iMessage — triggers PlatformAdapter extraction |

## 9. Error Handling

| Error | Detection | Response |
|-------|-----------|----------|
| Agent process crash | Non-zero exit code | Send error message, next message respawns with `--resume` |
| Agent process hang | Timeout (default 5min) | Kill process, send timeout message |
| JSONL parse error | JSON.parse throws | Log, skip line, continue |
| Agent session expired | Resume fails | Start new session, inform user |
| Chat SDK post fails | HTTP error | Log, retry once |
| SQLite locked | SQLITE_BUSY | Handled by busy_timeout pragma (5s) |

## 10. Extensibility

### 10.1 New Agent Backends

Add a new file in `executor/` implementing the `Executor` interface. Each executor is ~50-100 lines.

### 10.2 New IM Platforms

Install the Chat SDK adapter package, add to adapters config, implement the `PlatformFormatter` interface for platform-specific UX.

### 10.3 Dashboard API (Phase 2+)

Hono serves dashboard routes at `/api/*`. WebSocket at `/ws` for real-time session feed. React webview in Tauri app consumes these endpoints.
