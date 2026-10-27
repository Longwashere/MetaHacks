# Agent Guide

This is an npm-workspaces monorepo. Read the guide for the package you're working in before making changes.

| Folder | What it is | Guide |
| --- | --- | --- |
| `frontend/` | React Router v8 (framework mode) + React 19 + shadcn/ui + Tailwind v4 | `frontend/AGENTS.md` |
| `backend/` | Node.js API (Express 5, TypeScript) | `backend/AGENTS.md` |

## Commands (from the repo root)

```bash
npm install            # installs every workspace; one lockfile at the root
npm run dev            # runs frontend and backend dev servers
npm run dev:frontend   # frontend only
npm run dev:backend    # backend only
npm run build          # builds every workspace
npm run typecheck      # typechecks every workspace — run before finishing a task
```

Add dependencies to a specific workspace: `npm install <pkg> -w frontend` or `-w backend`. Don't add app dependencies to the root `package.json`.

Keep frontend and backend code separate: the frontend talks to the backend over HTTP (see `frontend/BACKEND.md` for the API contract the UI expects). Don't import across the two packages.
