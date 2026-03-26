# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.8] - 2026-03-25

### Added
- Email (AgentMail) platform adapter — WebSocket for real-time inbound, API key auth, one inbox per workspace
- Full CLI onboarding for email — API key reuse across workspaces, inbox creation/reassignment
- Email context prefix for agent tone adaptation ("Bae from <workspace>")
- Workspace/platform context in all message logs for multi-workspace debugging

### Changed
- Removed iMessage platform — will revisit with a managed API service (Blooio, LoopMessage, or similar)

### Fixed
- Email display name format and WebSocket subscription timing
- Init wizard no longer prompts redundantly for workspace directory when path is already known
- Unified log tag format to `[bae:workspace/platform]` across all adapters

## [0.2.7] - 2026-03-23

### Added
- Context-aware `bae init` — detects if current folder is a workspace and branches accordingly
- `bae workspace add` now prompts path first, then slug with smart default, and offers to add a channel
- `bae channel add` always shows workspace selector with current folder pre-selected
- All start/restart flows now use OS-native supervisor (launchd/systemd) automatically

### Changed
- `bae init` only starts/restarts when config actually changed — asks "Start Bae now?" if not running
- Consistent restart behavior across all CLI commands

### Fixed
- `bae init` from a new folder no longer offers to manage unrelated workspaces
- Default slug validation now accepts the default value when pressing Enter

## [0.2.6] - 2026-03-22

### Added
- WeChat platform adapter via Tencent iLink Bot API (HTTP long-polling, QR code login, text-only v1)
- OS-native process supervisor — `bae start -d` uses launchd (macOS) or systemd (Linux) for auto-restart on crash
- `--port` flag for `bae start` to override default port

## [0.2.5] - 2026-03-21

### Changed
- Auth preflight uses `claude auth status` instead of spawning a session — no API credits, no session pollution, instant check
- Startup shows progress messages during preflight checks (`Checking for updates...`, `Checking Claude Code...`, `Verifying auth...`)

## [0.2.4] - 2026-03-21

### Added
- Preflight auth check on `bae start` and `bae init` — verifies Claude Code can respond before booting
- Runtime auth error detection — shows actionable message in channel instead of cryptic "/login" text
- Timestamped logs (`HH:mm:ss.SSS`) for all `bae start` output
- `bae upgrade` command — updates to latest version and restarts if running
- Auto-update on `bae start` — checks npm and updates before booting
- Live auto-update — checks npm every 6 hours while running, installs and restarts automatically
- Auto-restart after `bae channel add/remove`, `bae workspace remove/set-executor`, and `bae init`
- Auto-start bae after `bae init` completes (no manual `bae start` needed)

### Changed
- `bae start -d` promoted as recommended default in help text and all hints
- Config changes no longer require manual restart — bae restarts itself
- Typing indicator stops cleanly after agent reply (no more lingering "typing...")

### Fixed
- Typing indicator stuck for minutes after agent reply on Telegram
- Auth error leaves typing indicator running — broken process stayed alive, steered messages caused minutes of phantom typing
- Opt out of auto-updates with `BAE_NO_AUTO_UPDATE=1`

## [0.2.3] - 2026-03-20

### Added
- Interactive `bae workspace add` — prompts for slug and path if not provided, defaults to current directory
- Interactive `bae channel add` — auto-detects single workspace, platform selection prompt, hides already-configured platforms
- `--help` for workspace and channel subcommands
- Auto-update notifications — checks npm registry every 24h, notifies once per new version
- "Add another channel" option when re-running `bae init` on existing workspace
- iMessage headless init support (`--platform imessage`)
- Platform flag validation (rejects unknown platforms like `--platform discord`)

### Changed
- Default workspace path changed from `~/baesment` to current directory
- Slack setup: manifest auto-copied to clipboard (macOS/Windows/Linux), fallback to temp file
- Slack setup: two-step guided flow (create app → confirm → one token at a time)
- Channel list output grouped by workspace
- Better error messages with actionable guidance throughout CLI
- `bae start` shows "Send a message to your bot to start chatting!" on success
- `bae init` highlighted as starting point in help text
- License changed from MIT to Apache-2.0
- README rewritten for user-friendly onboarding with Quick Start guide

## [0.2.2] - 2026-03-19

### Added
- Slack platform support via Socket Mode (no tunnel needed)
  - Native streaming API (`chat.startStream`/`appendStream`/`stopStream`)
  - `/new` as Slack slash command
  - Thread replies in DMs for streaming
  - Message dedup for Socket Mode retries
  - Slack app manifest (`slack-manifest.json`) for one-click setup
- iMessage platform support (macOS only, local mode)
  - Direct `@photon-ai/imessage-kit` SDK (self-messaging enabled)
  - `Bae:` prefix on agent responses for loop prevention
  - Auto-launch Messages.app if not running
  - Auto-open System Settings for Full Disk Access setup
  - Content-based message dedup for iCloud sync duplicates
- PlatformAdapter architecture
  - `PlatformThread` interface (id, post, postStream, startTyping)
  - `PlatformConfig` for per-platform split thresholds
  - `ChannelHandle` unified start/stop interface
  - `src/bot.ts` renamed to `src/channel.ts` (consistent "channel" naming)
  - Shared formatters extracted to `src/formatter/common.ts`
- Slack mrkdwn formatter (code-block-safe) for non-streamed messages
- iMessage `stripMarkdown` for plain-text output
- Interactive CLI improvements
  - `bae workspace add` prompts interactively if no flags given
  - `bae channel add` auto-detects single workspace, platform selection prompt
  - `--help` for workspace and channel subcommands
  - Default workspace path to current directory (not `~/baesment`)
  - "Add another channel?" after `bae init`
  - iMessage headless init support (`--platform imessage`)
  - Better error messages with actionable guidance
  - Channel list grouped by workspace
  - Platform flag validation (rejects unknown platforms)
- Auto-update notifications
  - Checks npm registry every 24 hours (non-blocking)
  - Notifies once per new version on stderr
  - Opt-out via `BAE_NO_UPDATE_NOTIFIER` env var
  - Only runs on `start` and `status` commands (no delay on `--help`)
- `BAE_LOCAL_MODE=true` credential marker for platforms without API tokens

### Changed
- Bridge uses `PlatformThread` + `PlatformConfig` instead of Chat SDK `Thread`
- Commands gain `platform` parameter (`/start` is Telegram-only)
- `createBot()` renamed to `createChannel()` with `CreateChannelOptions`
- `BotHandle` renamed to `ChannelHandle`
- License changed from MIT to Apache-2.0

### Removed
- `chat-adapter-imessage` dependency (replaced by direct `@photon-ai/imessage-kit`)

## [0.2.1] - 2026-03-17

### Added
- Multi-workspace support — multiple agent identities from one BAE process
- Three-table schema: workspaces, channels, sessions with CHECK constraints and ON DELETE CASCADE
- `bae workspace list/add/remove/set-executor` CLI commands
- `bae channel list/add/remove` CLI commands with credential validation
- Per-channel credential files (`~/.bae/credentials/`) with mode 0600
- Per-channel access control (`allowed_users` per channel, not global)
- Schema versioning via `PRAGMA user_version` with transaction-wrapped migrations
- Channel ID generation via nanoid (path traversal guard on all credential operations)
- Duplicate bot token detection across workspaces
- Parallel multi-channel boot via `Promise.allSettled`
- Foreign key indexes for cascade delete performance

### Changed
- `SessionStore` renamed to `Store` (manages workspaces, channels, and sessions)
- Bot token passed directly to Chat SDK adapter constructor (no `process.env` mutation)
- Separate Chat SDK state adapter per bot instance (prevents dedup collisions)
- Explicit `adapter.stopPolling()` on shutdown (Chat SDK `shutdown()` alone doesn't stop polling)
- `createBot()` now takes options object (`CreateBotOptions`) instead of positional args
- `createBridge()` receives `Store` instance via config (injected, not created internally)
- Bridge auth check uses pre-parsed `allowedUsers: string[]` from channel
- All routing changed from `(platform, threadId)` to `(channelId, conversationId)`
- `bae init` now creates workspace + channel + credential file (idempotent on re-run)
- `~/.bae/.env` now only stores `BAE_PORT` (credentials moved to per-channel files)
- Version fallback reads `package.json` when running from source

### Removed
- Global `BAE_ALLOWED_USERS` env var (replaced by per-channel `allowed_users`)
- Global `BAE_CWD` env var (replaced by workspace path in database)
- `TELEGRAM_BOT_TOKEN` in `~/.bae/.env` (moved to credential files)

## [0.2.0] - 2026-03-17

### Added
- Mid-stream steering — send messages while the agent is working
- Persistent stdin process (`--input-format stream-json`) replaces spawn-per-message
- Telegram HTML formatting (bold, italic, code blocks, links, blockquotes)
- Markdown-to-HTML converter with plain-text fallback on Telegram rejection
- Code-fence-aware message splitting (close/reopen ``` across messages)
- Smart split thresholds accounting for Chat SDK text expansion
- Unclosed code fence handling for streaming (tables mid-render)
- Randomized pop culture messages for `/start`, `/new`, and errors
- Retry state adapter to handle Chat SDK thread lock during steering
- `editMessage` override to suppress empty-text `ValidationError` crashes

### Fixed
- Messages exceeding Telegram's 4096-char limit during streaming
- Text loss at message split boundaries
- "message is not modified" errors during streaming edits
- Chat SDK thread lock (`LOCK_FAILED`) when steering messages arrive

### Changed
- Streaming uses Chat SDK `fallbackStream` (edit-in-place) instead of discrete messages
- Long-lived `consumeAllTurns` event consumer replaces per-turn `streamResponse`
- Removed metadata footer from responses (timing/cost kept in dev logs only)
- Error messages now user-friendly with pop culture references

## [0.1.0] - 2026-03-12

### Added
- Telegram-to-Claude Code bridge
- Conversation continuity via `--resume` session management
- Long polling with typing indicator and logging
- Progressive streaming with code-fence-aware message splitting
- Cross-runtime SQLite adapter (bun:sqlite + better-sqlite3)
- CLI entry point: `bae start`, `bae stop`, `bae status`, `bae logs`
- `bae init` onboarding wizard with ASCII branding
- Daemon mode for background operation
- tsup build for npm distribution
- CI/CD workflows (GitHub Actions)

### Fixed
- DM-only mode (onNewMessage instead of onNewMention)
- Variable hoisting bug in built CLI (`bae logs`)
- Cold start diagnostic timestamps

### Changed
- Factory-based initialization (`createBot`, `createBridge`)
- Auto-create workspace directory, default `~/baesment`

[Unreleased]: https://github.com/neethanwu/bae/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/neethanwu/bae/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/neethanwu/bae/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/neethanwu/bae/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/neethanwu/bae/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/neethanwu/bae/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/neethanwu/bae/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/neethanwu/bae/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/neethanwu/bae/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/neethanwu/bae/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/neethanwu/bae/releases/tag/v0.1.0
