---
status: pending
priority: p3
issue_id: "007"
tags: [code-review, quality]
dependencies: []
---

# Remove unused updateCwd and Executor.name (YAGNI)

## Problem Statement

- `updateCwd()` in `SessionStore` is defined but never called
- `Executor.name` is declared but never read

## Fix

- Remove `updateCwd` from `src/session/store.ts:99-103`
- Remove `readonly name: string` from `src/executor/types.ts:17`
- Remove `readonly name = "claude-code"` from `src/executor/claude.ts:15`
- Effort: Trivial (~10 lines removed)

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
