---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, architecture, reliability]
dependencies: []
---

# Add per-thread concurrency guard

## Problem Statement

If a user sends two messages rapidly to the same Telegram thread, both will call `sessionManager.handleMessage()` concurrently. Both read the same `agentSessionId`, both spawn `claude --resume <same-session-id>`, and both race on `setStatus`. This creates undefined behavior in Claude Code and inconsistent session state.

## Findings

- **Performance review**: "Two processes trying to resume the same conversation creates an undefined state"
- **Security review**: "The `status` field in the database could become inconsistent"
- **Architecture review**: "Claude Code's behavior with concurrent `--resume` on the same session ID is undefined"
- 3/6 agents flagged this independently — highest-confidence finding

**Location**: `src/session/manager.ts:17-56`

## Proposed Solutions

### Option A: Status check in SessionManager (Recommended)
Check `session.status === "running"` before spawning. Reject with user-facing message.

```typescript
if (session.status === "running") {
  return (async function*() {
    yield { kind: "error" as const, message: "Still working on your previous message." };
  })();
}
```

- Pros: Simple, no new dependencies, uses existing status field
- Cons: Check-then-act is not perfectly atomic (fine for single-process Bun)
- Effort: Small

### Option B: Atomic SQL update
Use `UPDATE sessions SET status = 'running' WHERE id = ? AND status = 'idle' RETURNING *` and check if it returned a row.

- Pros: Atomic, no race window
- Cons: Slightly more complex SQL
- Effort: Small

### Option C: In-memory Map<string, Promise>
Track active requests in a Map keyed by `platform:threadId`.

- Pros: No DB round-trip, can queue messages
- Cons: Lost on restart, more state to manage
- Effort: Medium

## Acceptance Criteria

- [ ] Sending two rapid messages to the same thread does not spawn two concurrent `--resume` processes
- [ ] Second message gets a user-facing "still processing" response
- [ ] Status field remains consistent

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |

## Resources

- PR branch: `feat/phase-1a-core-plumbing`
- File: `src/session/manager.ts`
