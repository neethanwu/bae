# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/neethanwu/bae/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/neethanwu/bae/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/neethanwu/bae/releases/tag/v0.1.0
