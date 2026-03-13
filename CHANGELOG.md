# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
