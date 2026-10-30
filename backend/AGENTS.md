# Backend Agent Guide

Node.js API for the app, written in TypeScript (strict mode) with Express 5.

## Commands

```bash
npm run dev         # tsx watch on src/index.ts (or `npm run dev:backend` from the root)
npm run build       # tsc → dist/
npm start           # node dist/index.js
npm run typecheck   # tsc --noEmit over src/ and test/ — run before finishing a task
npm test            # node:test via tsx (test/*.test.ts) — run after changing v3 post-processing (textures.ts, fitKeyedPage)
```

## Rules

- ES modules with `NodeNext` resolution: relative imports need a `.js` extension (`import { x } from "./lib/x.js"`).
- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- No `any` or `@ts-ignore`; use `unknown` and narrow.
- Read config and secrets from `process.env`; never commit `.env`.
- Validate every request body, query and param. Treat them as untrusted.
- The API shapes the frontend expects are in `frontend/BACKEND.md` and `frontend/app/lib/types.ts`.

## Living docs

- **Remix v3 agent loop** (`src/v3/lib/remix.ts`): https://claude.ai/artifact/BCV5nnvZ98CbmB44K5Sqy6. It's a Claude Doc with diagrams of the setup, the main loop, a paint round and the tweak step, plus the checks, scoring and limits. When a change touches the loop's flow, checks, scoring, stop conditions or the constants at the top of `remix.ts`, update the doc in the same task: edit the affected section and diagram, and keep function and constant names in the doc matching the code. Use the Claude Docs tools to edit it, not a web fetch.
