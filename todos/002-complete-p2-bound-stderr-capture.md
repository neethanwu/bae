---
status: pending
priority: p2
issue_id: "002"
tags: [code-review, performance]
dependencies: []
---

# Bound stderr capture in ClaudeCodeExecutor

## Problem Statement

`new Response(proc.stderr).text()` buffers the entire stderr into memory before slicing to 500 chars for logging. If Claude emits large stderr (stack traces, verbose debug), this grows unbounded for up to 5 minutes (default timeout).

## Findings

- **Performance review**: "This string will grow unbounded until the process exits"
- **Location**: `src/executor/claude.ts:51-55`

## Proposed Solutions

### Option A: Stream with size cap (Recommended)
Read stderr incrementally, stop after 4KB.

- Effort: Small

### Option B: Pipe stderr to /dev/null, log nothing
- Pros: Zero memory cost
- Cons: Lose debugging info
- Effort: Trivial

## Acceptance Criteria

- [ ] stderr capture is bounded to a reasonable size (e.g., 4KB)
- [ ] Remaining stderr is drained/cancelled, not buffered

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
