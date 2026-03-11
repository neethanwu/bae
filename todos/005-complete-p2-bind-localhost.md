---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, security]
dependencies: []
---

# Bind HTTP server to 127.0.0.1

## Problem Statement

Bun's default server binds to `0.0.0.0`, making the health endpoint accessible to other machines on the local network. This confirms the service is running to any network-adjacent attacker.

## Findings

- **Security review**: "Bind to `127.0.0.1` if the health endpoint is only needed locally"
- **Location**: `src/index.ts:8-11`

## Fix

```typescript
export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
```

- Effort: Trivial (one line)

## Acceptance Criteria

- [ ] HTTP server only listens on localhost
- [ ] Health endpoint not accessible from other machines on LAN

## Work Log

| Date | Action |
|------|--------|
| 2026-03-10 | Created from Phase 1a code review |
