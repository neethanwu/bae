# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/neethanwu/bae/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/neethanwu/bae/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/neethanwu/bae/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/neethanwu/bae/releases/tag/v0.1.0
