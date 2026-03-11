---
status: pending
priority: p3
issue_id: "006"
tags: [code-review, security]
dependencies: []
---

# Set ~/.bae/ directory permissions to 0o700

## Problem Statement

`~/.bae/` is created with default permissions (0644). The `agent_session_id` values could theoretically be used to resume Claude sessions if an attacker has local access.

## Fix

```typescript
mkdirSync(dir, { recursive: true, mode: 0o700 });
```

- **Location**: `src/session/store.ts:47`
- Effort: Trivial

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
