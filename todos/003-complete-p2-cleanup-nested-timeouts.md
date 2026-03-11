---
status: pending
priority: p2
issue_id: "003"
tags: [code-review, quality]
dependencies: []
---

# Clean up nested setTimeout in executor kill/timeout

## Problem Statement

The timeout handler spawns a nested `setTimeout` for SIGKILL that is never cleared if the process exits before the delay. Same issue in `kill()`. Killing an exited process is a no-op but it's sloppy and could produce confusing logs.

## Findings

- **TypeScript review**: "Store the inner timeout ID and clear it after `await proc.exited`"
- **Location**: `src/executor/claude.ts:67-73` (timeout handler) and `111-118` (kill method)

## Proposed Solutions

### Fix (straightforward)

```typescript
async kill() {
  killed = true;
  clearTimeout(timeout);
  proc.kill("SIGTERM");
  const sigkillTimer = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_DELAY_MS);
  await proc.exited;
  clearTimeout(sigkillTimer);
},
```

Apply same pattern to the timeout handler.

- Effort: Small

## Acceptance Criteria

- [ ] All nested timeouts are cleared after process exits
- [ ] No stale timers fire on already-exited processes

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
