# Connecting the backend

The UI runs entirely on mock data right now. All data access goes through **one file**, so wiring up a real backend means changing the function bodies there. You shouldn't need to touch the routes or components.

| File | What it does now | What to do |
| --- | --- | --- |
| `app/lib/api.server.ts` | In-memory mock store (resets on server restart) | Replace each function body with a call to your API/DB. Keep the signatures. |
| `app/lib/auth.server.ts` | Always returns `demo-user` | Read the real session/JWT from `request` and return the user (or `throw redirect("/login")`). |
| `app/lib/mock-data.server.ts` | Seed assets | Delete it once `api.server.ts` no longer imports it. |
| `app/lib/types.ts` | The response shapes the UI expects | Match your API to these, or map to them inside `api.server.ts`. |
| `app/components/SpinePreview.tsx` | Draws a fake SVG rig with CSS animations | Swap in the Spine web runtime (see "Real previews" below). |

All `*.server.ts` files run on the server only, so API keys and secrets can go there (read from `process.env`). They never reach the browser.

## Function → endpoint contract

Each function in `api.server.ts` has a `BACKEND:` comment with the endpoint it stands in for. These paths are suggestions; any API that returns the same shapes will work.

| Function | Suggested endpoint | Returns |
| --- | --- | --- |
| `listAssets({ q, category, sort })` | `GET /assets?q=&category=&sort=popular\|newest\|name` | `SpineAsset[]` |
| `listFeaturedAssets(limit)` | `GET /assets/featured?limit=` | `SpineAsset[]` |
| `getAsset(id)` | `GET /assets/:id` | `SpineAsset \| null` (return `null` on 404) |
| `getSkeletonExport(id)` | `GET /assets/:id/skeleton` | Skeleton file contents. The `/assets/:id/download` route serves it. Change that route to stream the file or `redirect()` to a signed URL. |
| `getSavedAssetIds(userId)` | `GET /me/library/ids` | `string[]` |
| `getLibrary(userId)` | `GET /me/library` | `SpineAsset[]` (most recently saved first) |
| `getMyRemixes(userId)` | `GET /me/remixes` | `SpineAsset[]` (newest first) |
| `listRelatedAssets(asset, limit)` | `GET /assets/:id/related` | `SpineAsset[]` (same category) |
| `listRemixesOf(assetId, limit)` | `GET /assets/:id/remixes` | Public `SpineAsset[]` whose `remixOf.id === assetId` |
| `saveToLibrary(userId, assetId)` | `PUT /me/library/:assetId` | `void`. Should be idempotent. |
| `removeFromLibrary(userId, assetId)` | `DELETE /me/library/:assetId` | `void`. Should be idempotent. |
| `createRemixJob(userId, input, apiVersion)` | `POST /v2/remixes` or `POST /v1/remixes` (JSON `RemixInput` + `base: { name, atlasUrl, premultipliedAlpha }`) | **Live:** calls the backend at `BACKEND_URL` (default `http://localhost:4000`). Returns `RemixJob`, or `null` if the base rig doesn't exist or has no files |
| `getRemixJob(userId, jobId)` | `GET /{v1,v2}/remixes/:id`, using the job's version | **Live:** polls the backend while the job runs. `RemixJob \| null` |

## Remix flow

Users don't create rigs from scratch. They pick an existing rig and re-texture it. A remix keeps the base rig's skeleton, bones, slots, skins and animations, and only replaces the atlas page images (and the `.atlas` file, if regions get repacked).

1. **Pick a base rig.** `/remix` shows a picker with two tabs: **All rigs** (`listAssets`, searchable with `?rq=`) and **My library** (`getLibrary`). Choosing a rig sets `?base=<assetId>`. The asset page's "Remix this rig" button links straight to that URL.
2. **Describe the new look.** The form posts `RemixInput` to the `action` in `app/routes/remix.tsx`:
   ```ts
   { baseAssetId, prompt, style, strength /* 0–1 */, keepPalette, keepPosition, keepSize, keepOutline /* booleans */ }
   ```
   `style` is one of `REMIX_STYLES`: `"auto"` (the default) leaves the style to the prompt and otherwise keeps the base rig's, or an `ArtStyle` to force one. The resulting asset's `style` is the base rig's for `"auto"`.
   The action validates it on the server. Return field errors as `data({ errors }, { status: 400 })`; the keys are `base`, `prompt`, `style` and `strength`.
3. **Run the job.** `createRemixJob` returns a job, and the action redirects to `/remix?base=<id>&job=<jobId>`. While the job is `queued` or `running`, the page re-runs its loader every second, which calls `getRemixJob`. Fill in `progress` (0–1) and `stage` (for example "Painting new textures"). Once Muse has planned the look, `editPrompt` holds its expanded prompt for the image model and the page shows it. If Muse Image rejects that prompt under its content policy, the backend has Muse re-word it once and retries: `promptStatus` is `"rewording"` while Muse rewrites it, then `"reworded"` with the new prompt in `editPrompt`. The page shows both states.
4. **Show the result.** On `succeeded`, `job.asset` must be a full `SpineAsset` with `remixOf: { id, name }` set to the base rig. Copy `category`, `boneCount`, `slotCount`, `spineVersion` and `animations` from the base, since they don't change. The remix appears under **My Library → Remixes** and in a "Remixes of …" section on the base rig's page once it's public. On `failed`, set `job.error` to a user-facing message.

The backend will need the base rig's atlas regions (slot attachments and their UV rects) so new textures fit the existing mesh and region attachments. `strength`, `keepPalette` and `keepPosition` / `keepSize` / `keepOutline` are hints for the texture model; the keep-part options are off by default and only add the matching instruction to the prompts.

If a remix takes longer than a minute or so, consider server-sent events (SSE) or a WebSocket instead of polling. You can add an SSE resource route and replace the `useEffect` polling in `remix.tsx`.

**Who can remix what:** the mock lets users remix any public rig or anything in their library, including other remixes. If some rigs shouldn't be remixable (licensing, premium content), add a flag such as `remixable: boolean` to `SpineAsset`. Filter on it in the picker, hide the "Remix this rig" button, and reject it in `createRemixJob`.

## Asset files

`SpineAsset.files` is `null` when an asset has no exported files; the UI then draws a placeholder SVG rig. Otherwise it needs:

- `skeletonUrl`: `.skel` (binary, smaller) or `.json`
- `atlasUrl`: `.atlas`. The runtime loads page images relative to this URL, so keep the `.png`s next to it, or rewrite the page names in the atlas.
- `textureUrls`: the atlas page `.png`s (shown in the file list)
- `premultipliedAlpha`: `true` for "pma" exports. Getting this wrong causes dark fringes or halos around edges.
- `skin`: the skin to show, for rigs whose default skin is empty (e.g. the goblins example needs `"goblin"`)

The `animations` list must use the clip names in the skeleton exactly. The viewer calls `setAnimation(name)` and skips names that don't exist. Have the backend read the names and durations from the skeleton when an asset is ingested, rather than entering them by hand.

Serve files from a CDN with CORS enabled if they're on a different origin, since WebGL needs CORS to load textures. `/assets/:id/download` redirects to `skeletonUrl`. Change it to a signed URL or a zip of all files if you need that.

`thumbnailUrl` is optional but recommended (see SEO).

## Viewer (Spine web runtime)

The viewer uses the official `@esotericsoftware/spine-player`, pinned to 4.2.x to match the 4.2 exports. **Keep the runtime's major.minor version in step with the Spine editor version you export from.** A 4.2 runtime can't load 4.3 skeletons.

| Component | Role |
| --- | --- |
| `SpinePreview` | The square stage. Uses `SpineRuntime` when `asset.files` exists and falls back to `SpinePlaceholder` when files are missing or fail to load. |
| `SpineRuntime` | Wraps `SpinePlayer`. It's imported dynamically inside an effect, so it never runs during SSR and isn't in the main bundle. It mounts only while near the viewport (`useInView`) and frees the WebGL context when it unmounts, which keeps grids under the browser's limit of about 16 contexts. |
| `AssetPlayer` | Controls: animation (URL-driven), play/pause, speed and bones overlay. These map to `setAnimation`, `play()`/`pause()`, `player.speed` and `debug.bones`. |

**Example rigs:** `public/spine/` holds Esoteric's official example exports (spineboy, raptor, goblins, coin, owl, powerup), which back a few mock assets. They're for development only (see `public/spine/README.md`). Delete them once the backend serves real files.

**Remixes** are painted by the backend: v1 in `backend/src/lib/remix.ts`, v2 in `backend/src/v2/lib/remix.ts`. v2 started as an exact copy of v1 and will change. Both currently work the same way: Muse Spark looks at the base atlas pages and writes an edit prompt and a name, Muse Image repaints each page, and the result is resized and clipped to the original page's alpha so every region still fits its attachment. The remix keeps the base skeleton and gets a new `.atlas` + pages served from the backend at `/files/remixes/<jobId>/` (with CORS). Only rigs with `files` can be remixed. The remix form has a **Remix API** selector, which defaults to v2, and each job records its `apiVersion`. `tint` is now only used by seed data; drop it once no asset sets it.

If grid performance becomes a problem with many real rigs, show `thumbnailUrl` images in `AssetCard`/`RigPicker` and mount `SpineRuntime` only on hover.

## Auth & users

- `getCurrentUser(request)` is called by every loader and action that needs a user. Make it the single source of truth.
- `SpineAsset.visibility` controls exposure. Only `public` assets appear in Explore, the sitemap and search engines. New remixes start `private`. Add a publish action when you want users to share their remixes.
- The theme cookie (`app/lib/theme.server.ts`) is independent of auth and can stay as is.

## Error handling

- Throw `data("...", { status: 404 })` for missing resources. The asset page has its own `ErrorBoundary`.
- If an API call fails unexpectedly, let it throw. The root `ErrorBoundary` in `app/root.tsx` catches it.
- For validation errors coming back from the API on a remix, return them from the `remix` action as `data({ errors }, { status: 400 })`. The form already renders `errors.<field>`.

## SEO

Public asset pages are built to rank for searches like "monk walking spine2d".

- **URLs:** every asset has a page at `/assets/:id`, and every animation has its own indexable page at `/assets/:id/:animation` (for example `/assets/wandering-monk/walk`). Categories live at `/explore/:category`.
  - Asset `id`s are the URL slugs. Make the backend generate readable, stable slugs such as `wandering-monk`, or `grumpy-mushroom-wizard-3f9a1c2b` when you need a unique suffix. If a slug ever changes, `throw redirect(newUrl, 301)` from the asset loader.
- **Titles and descriptions** are built in `app/lib/seo.ts`. `animationLabel()` maps clip names to the words people search with (`walk` → "Walking"). Add your own clip names there.
- **Indexing rules:**
  - Indexed: public assets (originals and public remixes), animation pages, categories, `/`, and `/remix` with no query string.
  - `noindex`: search results (`?q=`, `?rq=`), re-sorted lists, private remixes (`visibility: "private"`), `/remix` pages with a selected rig or job, and `/library`.
  - Canonical tags strip the query string.
- **Structured data:** asset pages emit `CreativeWork` + `BreadcrumbList` JSON-LD, and remixes add `isBasedOn` pointing to the base rig. Explore emits `CollectionPage`/`ItemList`, and home emits `WebSite` with a `SearchAction`.
- **`/sitemap.xml`** lists every public asset and animation page. **`/robots.txt`** points crawlers to it. Split the sitemap into an index once you pass about 50k URLs.
- **Set `PUBLIC_SITE_URL`** (e.g. `https://rigforge.com`) in production so canonical, OG and sitemap URLs are absolute and correct behind proxies.
- **Still to do with the backend:**
  - Render a PNG/GIF thumbnail per asset (or per animation) and set `thumbnailUrl`. It's used for `og:image` and the JSON-LD `image`, and pages with images get much richer search and social results.
  - Once Explore has more than a page of results, add real pagination with `<Link>`s to `?page=N` so crawlers can reach every asset. Infinite scroll alone isn't crawlable.
  - Return HTTP caching headers (`headers` export) on asset pages so crawls are cheap.
