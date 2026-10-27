# Backend Agent Guide

Node.js API for the app, written in TypeScript (strict mode) with Express 5.

## Commands

```bash
npm run dev         # tsx watch on src/index.ts (or `npm run dev:backend` from the root)
npm run build       # tsc → dist/
npm start           # node dist/index.js
npm run typecheck   # tsc --noEmit — run before finishing a task
```

## Rules

- ES modules with `NodeNext` resolution: relative imports need a `.js` extension (`import { x } from "./lib/x.js"`).
- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- No `any` or `@ts-ignore`; use `unknown` and narrow.
- Read config and secrets from `process.env`; never commit `.env`.
- Validate every request body, query and param. Treat them as untrusted.
- The API shapes the frontend expects are in `frontend/BACKEND.md` and `frontend/app/lib/types.ts`.
