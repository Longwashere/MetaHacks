# Agent Guide

Instructions for any AI coding agent (Claude, Gemini, Muse, etc.) working in this repo.

## Stack — always build with these

- **React 19** with TypeScript (strict mode).
- **React Router v8** in framework mode (Vite plugin, SSR on by default). This is the routing, data-loading, and build framework — not Next.js, not plain Vite SPA.
- **shadcn/ui** is the component library (Radix UI primitives, new-york style, lucide icons).
- **Tailwind CSS v4** for styling (CSS-first config in `app/app.css`; there is no `tailwind.config.js`).

Do not add another UI kit (MUI, Chakra, Mantine, Ant, etc.), CSS-in-JS library, or alternate router.

## Project layout

```
app/
  root.tsx            # HTML shell, global links, root ErrorBoundary
  routes.ts           # route config
  routes/             # route modules
  components/ui/      # shadcn components (CLI-managed)
  components/         # app-specific components
  lib/utils.ts        # cn() helper
  app.css             # Tailwind + shadcn theme
components.json       # shadcn config
```

## Commands

```bash
npm run dev         # dev server
npm run build       # production build
npm run typecheck   # react-router typegen && tsc — run before finishing a task
```

Requires Node > 22.22.

---

## shadcn/ui

### Setup rules

- **Reach for a shadcn component first.** Before hand-rolling a button, input, dialog, dropdown, card, table, toast, etc., use the shadcn version.
- Add components with the CLI, don't copy them by hand:
  ```bash
  npx shadcn@latest add <component>   # e.g. card dialog input select
  ```
  They land in `app/components/ui/`. Check that folder first — the component may already be installed.
- Import with the `~` alias: `import { Button } from "~/components/ui/button";`
- Icons come from `lucide-react`.
- Dark mode is **class-based**: it applies when a `.dark` class is on an ancestor (e.g. `<html>`), not from `prefers-color-scheme`.

### Best practices

- **Compose, don't fork.** Build app components in `app/components/` by composing `ui/` primitives. If you need a new look app-wide, add a `cva` variant to the ui component instead of overriding classes at every call site.
- **Use `asChild` to change the rendered element.** Render a router link as a button with `<Button asChild><Link to="/x">Go</Link></Button>` — never nest `<button>` inside `<a>` or vice versa.
- **Merge classes with `cn()`** from `~/lib/utils` and accept a `className` prop on reusable components so callers can extend styles; `cn` resolves conflicting Tailwind classes (last one wins).
- **Use theme tokens, not raw colors**: `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-primary text-primary-foreground`, `border-border`, `bg-destructive`, etc. Raw colors like `bg-white` / `text-gray-500` break dark mode and theming. Change the palette by editing the CSS variables in `app/app.css`.
- **Keep accessibility intact.** Radix handles focus and ARIA — don't strip it. Every `Dialog`/`Sheet`/`AlertDialog` needs a title (use `className="sr-only"` if visually hidden); icon-only buttons need `aria-label` or `<span className="sr-only">`; pair inputs with `<Label htmlFor>`.
- **Use the right primitive**: `AlertDialog` for destructive confirmations, `Dialog` for general modals, `Sheet` for side panels, `Popover` for interactive floating content, `Tooltip` only for supplementary non-interactive hints, `Sonner` for toasts.
- **Form fields must have a `name`** so they submit with React Router `<Form>` / `fetcher.Form` (see below).

---

## React Router (framework mode)

The installed docs are the source of truth for this version: `node_modules/react-router/docs/`. For non-trivial work, also read `.agents/skills/react-router/SKILL.md` and its `references/framework-mode.md`.

### Setup rules

- Routes are declared explicitly in `app/routes.ts` (config-based, not file-system routing). Every new page must be registered there with `route()`, `index()`, `layout()`, or `prefix()`.
- Route modules live in `app/routes/`. Root layout, global `<head>` links, and the top-level error boundary are in `app/root.tsx`.
- Import router APIs from `react-router` — never `react-router-dom` or `@remix-run/*`.

### Best practices

- **Type every route module** with its generated types: `import type { Route } from "./+types/<route-file>";` then use `Route.LoaderArgs`, `Route.ActionArgs`, `Route.ComponentProps`, `Route.MetaArgs`. Run `npm run typecheck` (it regenerates types) after adding a route.
- **Read data in `loader`, write data in `action`.** Don't fetch in `useEffect`. Inside the route component, consume data via the `loaderData` / `actionData` props from `Route.ComponentProps`; use `useLoaderData` only in child components when prop-drilling is awkward.
- **Mutate with `<Form method="post">` or `useFetcher()`**, not `onSubmit` + `fetch`. React Router revalidates loaders automatically after actions. Use `useFetcher` for in-place mutations that shouldn't navigate (like buttons, toggles, inline edits); use `<Form>` when the mutation should navigate.
- **Use multiple actions per route via an `intent`** field (`<button name="intent" value="delete">`) and branch on it in the action.
- **Show pending UI** with `useNavigation()` (page-level) or `fetcher.state` (per-fetcher). Use optimistic UI by reading `fetcher.formData` while a submission is in flight.
- **Responses**: return plain objects from loaders/actions; use `data(value, { status, headers })` when you need a status code or headers; `throw redirect("/path")` to redirect; `throw data("Not found", { status: 404 })` for expected errors so the nearest `ErrorBoundary` renders.
- **Validate on the server.** Treat `request.formData()` and URL params as untrusted; validate and return field errors from the action (`return data({ errors }, { status: 400 })`) and render them from `actionData`.
- **Never leak secrets.** Loader return values are serialized to the browser — return only what the UI needs. Keep server-only code (DB clients, secrets, `process.env`) in `*.server.ts` files or `.server/` directories so it can't be bundled into the client.
- **Avoid waterfalls.** Fetch independent data in parallel with `Promise.all`. Use nested routes so each segment loads its own data in parallel. Return a promise (unawaited) from a loader and render with `<Suspense>` + `<Await>` to stream slow, non-critical data.
- **Put shareable UI state in the URL.** Filters, sort order, pagination, tabs, and search queries belong in search params (`useSearchParams` / `<Form method="get">`), not `useState`.
- **Use layouts for shared chrome.** Group routes under a `layout()` route that renders `<Outlet />` instead of repeating headers/sidebars per page.
- **Navigation**: use `<Link>` / `<NavLink>` for links (NavLink for active styling); reserve `useNavigate` for navigation that happens outside user clicks (e.g. after a timer). Use `href("/users/:id", { id })` for type-safe paths.
- **Export `meta`** from each page route for `<title>` and description; export `ErrorBoundary` from routes that can fail in route-specific ways.
- **Client-only data**: use `clientLoader` / `clientAction` only when data truly must come from the browser (e.g. localStorage); add a `HydrateFallback` when a `clientLoader` runs on hydration.

---

## React 19

- **Function components and hooks only.** One main component per file, PascalCase file and component names for components; route modules keep their route file names.
- **Don't sync state with effects.** Compute derived values during render instead of `useEffect` + `setState`. Use `useEffect` only to synchronize with external systems (subscriptions, DOM APIs, timers), and always clean up.
- **Keep state minimal and close to where it's used**; lift it only as far as needed. Prefer URL state (search params) and loader data over client state for anything server-backed.
- **SSR-safe rendering.** This app server-renders, so render output must match on server and client: don't read `window`, `document`, `localStorage`, `Date.now()`, or `Math.random()` during render — do it in an effect or `clientLoader`.
- **Stable keys**: use IDs from data, never array indexes for lists that can reorder, insert, or delete.
- **`ref` is a regular prop** in React 19 — don't use `forwardRef` in new code.
- **Don't memoize by default.** Add `useMemo` / `useCallback` / `memo` only for measured performance problems or when referential stability is required by a dependency.
- **Use React 19 APIs where they fit**: `useOptimistic` for optimistic updates outside fetchers, `use()` for reading promises/context inside Suspense boundaries. Set `<title>`/`<meta>` through the route `meta` export rather than rendering them inline.
- **Semantic HTML first**: real `<button>`, `<a>`, `<nav>`, `<main>`, `<label>` elements; no clickable `<div>`s.

---

## Tailwind CSS v4

- **Configure in CSS.** Theme customization goes in `@theme` / `:root` variables in `app/app.css`. Don't create `tailwind.config.js`.
- **Utilities in markup.** Style with utility classes; avoid `@apply` outside the base layer and avoid custom CSS files.
- **Never build class names dynamically** (`` `bg-${color}-500` `` won't be generated). Map to complete class strings (`{ red: "bg-red-500", … }[color]`) or use `cva` variants.
- **Mobile-first responsive**: write base styles for small screens, then layer `sm:` / `md:` / `lg:` overrides.
- **Prefer layout utilities** — `flex`/`grid` with `gap-*` over margins between siblings; `size-*` for equal width/height.
- **Conditional classes go through `cn()`**, never string concatenation.

---

## TypeScript

- Strict mode is on — no `any`, no `@ts-ignore`; use `unknown` and narrow, or fix the types.
- `verbatimModuleSyntax` is on: type-only imports must use `import type { … }` (or inline `type` specifiers).
- Use the `~/` alias for anything under `app/` instead of long relative paths.

## Before finishing a task

1. `npm run typecheck` passes.
2. New pages are registered in `app/routes.ts` and export `meta`.
3. UI uses shadcn components + theme tokens and works in both light and dark mode.
4. No secrets or server-only modules are reachable from client code.
