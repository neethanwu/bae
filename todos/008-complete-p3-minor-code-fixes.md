---
status: pending
priority: p3
issue_id: "008"
tags: [code-review, quality]
dependencies: []
---

# Minor code quality fixes from review

## Items

1. **Use `path.dirname()` instead of string slicing** — `store.ts:44-45` uses `lastIndexOf("/")` which breaks on edge cases. Use `dirname()` from already-imported `node:path`.

2. **Move `clearInterval` to `finally` block** — `bridge.ts` has duplicated `clearInterval` in happy path (line 124) and catch (line 141). Use single `finally` block.

3. **Use `ExecuteOptions` type reference** — `claude.ts:17-22` re-declares the parameter type inline instead of referencing imported `ExecuteOptions`.

4. **Derive platform from adapter** — `bridge.ts:78` hardcodes `const platform = "telegram"`. Should come from the caller or adapter.

## Effort

Small — all are quick, safe changes.

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
