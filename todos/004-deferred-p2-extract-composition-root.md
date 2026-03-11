---
status: deferred
priority: p2
issue_id: "004"
tags: [code-review, architecture, testability]
dependencies: []
---

# Extract composition root from bridge.ts

## Problem Statement

`bridge.ts` runs side effects at import time: reads env vars, calls `process.exit()`, creates SQLite database, constructs singletons. This makes `handleMessage` untestable without triggering the entire dependency tree. It also blocks the future monorepo split to `packages/core`.

## Findings

- **TypeScript review**: "You cannot import `handleMessage` in a test without triggering all of this"
- **Architecture review**: "The composition root is invisible — it is a side effect of `import`"
- **Location**: `src/bridge.ts:1-34` (module-level initialization)

## Proposed Solutions

### Option A: Move initialization to index.ts (Recommended)
`bridge.ts` exports a factory or class that accepts dependencies. `index.ts` wires everything together.

- Pros: Clean separation, testable, standard pattern
- Cons: Slightly more boilerplate
- Effort: Medium

### Option B: Bridge class with constructor injection
```typescript
export class Bridge {
  constructor(private sessionManager: SessionManager, private config: BridgeConfig) {}
  async handleMessage(thread: Thread, message: MessageData): Promise<void> { ... }
}
```

- Pros: Fully testable, explicit dependencies
- Cons: More ceremony than needed for Phase 1a
- Effort: Medium

## Acceptance Criteria

- [ ] `handleMessage` can be imported and called in a test without side effects
- [ ] No `process.exit()` at module scope
- [ ] Dependencies are injected, not constructed at import time

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
| 2026-03-10 | Deferred to Phase 1b — not needed until tests or second platform are added |
