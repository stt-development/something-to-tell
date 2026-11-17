# Web App

React + TypeScript frontend for Something To Tell Engine.

Responsibilities:

- project list and project workspace UI
- graph visualization with React Flow
- local interaction state with Zustand
- human approval flows for graph changes and future AI suggestions

The frontend must use shared contracts from `packages/contracts` and must not
read or write SQLite directly.

## Development

```bash
pnpm web:dev
pnpm web:typecheck
pnpm --dir apps/web test
pnpm --dir apps/web build
```

P1-002 uses seeded local graph state. Runtime-backed CRUD is deferred to later
Phase 1 tasks.
