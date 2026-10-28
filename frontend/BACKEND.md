# Connecting the backend

The UI gets all its data from the backend (`BACKEND_URL`, default `http://localhost:4000`) through **one file**, `app/lib/api.server.ts`. Routes and components don't call the backend directly.

| File | What it does |
| --- | --- |
| `app/lib/api.server.ts` | One function per backend endpoint (table below). Calls for the signed-in user take their `Session` and send its access token as `Authorization: Bearer …`. |
| `app/lib/auth.server.ts` | Supabase Auth (Google sign-in). The root `middleware` reads and refreshes the session cookies on every request. Loaders and actions call `getSession(context)` (guests get `null`) or `requireSession(context, request)` (sends guests to `/login?next=…`). |
| `app/lib/types.ts` | The response shapes the UI expects. The backend returns these shapes. |

All `*.server.ts` files run on the server only, so API keys and secrets can go there (read from `process.env`). They never reach the browser. A `Session` holds the access token, so **never return it from a loader**: the root loader returns only `session.user` (id, name, email, avatar).

Frontend env vars (in `frontend/.env` in dev; `vite.config.ts` loads it into `process.env`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BACKEND_URL`, `PUBLIC_SITE_URL`.

## Function → endpoint contract

| Function | Endpoint | Returns |
| --- | --- | --- |
| `listAssets({ q, category, sort })` | `GET /assets?q=&category=&sort=popular\|newest\|name` | Public `SpineAsset[]` |
| `listFeaturedAssets(limit)` | `GET /assets?sort=popular&limit=` | Public `SpineAsset[]` |
| `getAsset(id, session)` | `GET /assets/:id` | `SpineAsset \| null`. Private assets are only returned to their owner. |
| `listRelatedAssets(asset, limit)` | `GET /assets/:id/related?limit=` | Public `SpineAsset[]` in the same category |
| `listRemixesOf(assetId, limit)` | `GET /assets/:id/remixes?limit=` | Public `SpineAsset[]` whose `remixOf.id === assetId` |
| `getSavedAssetIds(session)` | `GET /me/library/ids` | `string[]`; `[]` for guests without a call |
| `getLibrary(session)` | `GET /me/library` | `SpineAsset[]`, most recently saved first |
| `saveToLibrary(session, assetId)` | `PUT /me/library/:assetId` | `204`. Idempotent. |
| `removeFromLibrary(session, assetId)` | `DELETE /me/library/:assetId` | `204`. Idempotent. |
| `getMyRemixes(session)` | `GET /me/remixes` | The user's own `SpineAsset[]`, newest first |
| `setRemixVisibility(session, assetId, visibility)` | `PATCH /me/remixes/:assetId` (JSON `{ visibility }`) | Updated `SpineAsset`, or `null` if it isn't the user's |
| `copyRemix(session, assetId)` | `POST /me/remixes/:assetId/copy` | `201` new private copy as `SpineAsset`; `200` with the user's existing copy, or the remix itself if it's theirs; `{ ok: false, error }` on 400/404. Free: no model runs. See **Copies** below. |
| `saveRemixSkeleton(session, assetId, skeleton, skin)` | `POST /me/remixes/:assetId/skeleton` (JSON `{ skeleton, skin }`, up to 8 MB) | Updated `SpineAsset` pointing at the stored skeleton, or `null` if it isn't the user's |
| `autoTweakRemix(session, assetId, input)` | `POST /me/remixes/:assetId/auto-tweak` (JSON `AutoTweakInput`, up to 12 MB) | `AutoTweakReview` (one Muse Spark call, nothing stored); `{ ok: false, error }` on 400/404/502. See **Auto-tweak** below. |
| `animateRemix(session, assetId, input)` | `POST /me/remixes/:assetId/animations` (JSON `AnimateInput`, up to 8 MB) | `201` `AnimateResult`: the updated `SpineAsset`, the new animation, Muse's notes and any dropped bones; `{ ok: false, error }` on 400/404/409/502. See **Generated animations** below. |
| `createRemixJob(session, input, apiVersion)` | `POST /me/remix-jobs` (JSON `RemixInput` + `apiVersion`) | `202` `RemixJob`; `400 { errors }`; `402 { error }` when the monthly allowance is used up |
| `getRemixJob(session, jobId)` | `GET /me/remix-jobs/:id` | `RemixJob \| null` |
| `getAccount(session)` | `GET /me` | `Account`: profile, plan, subscription and `usage: { used, limit, resetsAt }` |
| `createCheckoutUrl(session)` | `POST /billing/checkout` | `{ url }` of Stripe Checkout (or the portal for existing subscribers) |
| `createPortalUrl(session)` | `POST /billing/portal` | `{ url }` of the Stripe customer portal, or `null` if they never subscribed |

`/assets/:id/download` redirects to the asset's `skeletonUrl`, or serves `buildPlaceholderSkeleton(asset)` for assets without files.

## Remix flow

Users don't create rigs from scratch. They pick an existing rig and re-texture it. A remix keeps the base rig's skeleton, bones, slots, skins and animations, and only replaces the atlas page images (and the `.atlas` file, if regions get repacked).

1. **Pick a base rig.** `/remix` shows a picker with two tabs: **All rigs** (`listAssets`, searchable with `?rq=`) and **My library** (`getLibrary`). Choosing a rig sets `?base=<assetId>`. The asset page's "Remix this rig" button links straight to that URL.
2. **Describe the new look.** The form posts `RemixInput` to the `action` in `app/routes/remix.tsx`:
   ```ts
   { baseAssetId, prompt, style, strength /* 0–1 */, keepPalette, keepPosition, keepSize, keepOutline /* booleans */, visibility /* "public" | "private" */ }
   ```
   **Reference image (optional, v2 only).** `<ReferenceImageField>` shrinks the chosen file to a JPEG of at most 1024px in the browser and submits it as `referenceImage` (a data URL). The action passes it to `createRemixJob`, which sends it in the `POST /me/remix-jobs` body next to the input (body limit ~5.7 MB; 4 MB decoded). With a reference image, the prompt may be empty; the backend uses "Match the look of the reference image.". The backend re-encodes it with sharp, stores it as `remixes/<time>_<jobId>_ref/reference.jpg`, and sets `input.referenceImage` to that key. `RemixJob.referenceUrl` is its URL, and the progress card shows it. In the job, Muse Spark first gets the reference next to one atlas page (`describeReference`) and returns the `look` to carry over and, if the rendering clearly differs, its `style`. The look goes into `planRemix`. Under `"auto"`, the reference's style is the target style. Muse Image never sees the reference image (see `FRICTION_LOG.md`). `prompts.json` records `referenceLook`. The v1 pipeline rejects reference images (`400`, field `referenceImage`).
   `style` is one of `REMIX_STYLES`: `"auto"` (the default) leaves the style to the prompt and otherwise keeps the base rig's, or an `ArtStyle` to force one. The resulting asset's `style` is the base rig's for `"auto"`.
   The action validates it on the server. Return field errors as `data({ errors }, { status: 400 })`; the keys are `base`, `prompt`, `style` and `strength`.
3. **Run the job.** `createRemixJob` returns a job, and the action redirects to `/remix?base=<id>&job=<jobId>`. `?job=` is only for the progress view: once the job succeeds, the loader redirects to `/remix?asset=<remixId>`. While the job is `queued` or `running`, the page re-runs its loader every second, which calls `getRemixJob`. Fill in `progress` (0–1) and `stage` (for example "Painting new textures"). Once Muse has planned the look, `editPrompt` holds its expanded prompt for the image model and the page shows it. If Muse Image rejects that prompt under its content policy, the backend has Muse re-word it once and retries: `promptStatus` is `"rewording"` while Muse rewrites it, then `"reworded"` with the new prompt in `editPrompt`. The page shows both states.
4. **Show the result.** On `succeeded`, `job.asset` must be a full `SpineAsset` with `remixOf: { id, name }` set to the base rig. Copy `category`, `boneCount`, `slotCount`, `spineVersion` and `animations` from the base, since they don't change. The remix appears under **My Library → Remixes** and in a "Remixes of …" section on the base rig's page once it's public. On `failed`, set `job.error` to a user-facing message.

The backend will need the base rig's atlas regions (slot attachments and their UV rects) so new textures fit the existing mesh and region attachments. `strength`, `keepPalette` and `keepPosition` / `keepSize` / `keepOutline` are hints for the texture model; the keep-part options are off by default and only add the matching instruction to the prompts.

If a remix takes longer than a minute or so, consider server-sent events (SSE) or a WebSocket instead of polling. You can add an SSE resource route and replace the `useEffect` polling in `remix.tsx`.

5. **Come back to it.** `/remix?asset=<remixId>` is the workspace for a remix the user owns (made by a job or copied): the player, tweaks, sprite sheet and part fixes, with the rig it was made from (`remixOf`) as the base. If that rig is gone or private, the remix stands in as the base. Anyone else is redirected to the asset page. The owner opening `/assets/<remixId>` is redirected here too; `?public=1` and the per-animation pages show them the public page instead.

**Who can remix what:** users can remix any public rig or any of their own remixes, including other remixes. Signing in is required, and each remix counts toward the monthly allowance. If some rigs shouldn't be remixable (licensing, premium content), add a flag such as `remixable: boolean` to `SpineAsset`. Filter on it in the picker, hide the "Remix this rig" button, and reject it in `createRemixJob`.

## Copies

On someone else's remix, the asset page's main button is **Make a copy** (the asset route's `action` calls `copyRemix`, then redirects to `/remix?asset=<copyId>`). **Repaint with a new prompt** stays as the secondary button and starts a normal remix from it.

- A copy is a new private `assets` row owned by the user with the source's files, prompt and metadata. No model runs and it doesn't count toward the allowance.
- It shares the source's storage keys. That's safe because every save (remix, part fix, skeleton) writes a new `remixes/<folder>/`, so neither side can change the other's files.
- It keeps the source's `remix_of`, so a part fix with `source: "original"` still starts from the original rig. `copy_of` / `copy_of_name` (exposed as `SpineAsset.copyOf`) credit the remix it came from, and the asset page shows a "Copy of …" badge.
- Copying the same remix again returns the existing copy. Official rigs and assets without files can't be copied (`400`).
- Part fixes on a copy use the edit prompt of the job that made the source, found by following `copy_of`.

## Auto-tweak

The tweak panel's **Line up parts** button (Parts tab, finished remixes only) fixes parts the image model shifted or resized:

1. In the browser, `app/lib/spine-auto-tweak.ts` loads the original and the remix into hidden, same-sized players, paused at 0% and 50% of the selected animation. They share a skeleton, so the framing is identical.
2. For each part it compares the opaque pixels of its atlas region in both rigs (centre and spread), maps them through the attachment's UVs into world space, and turns the difference into a `dx`/`dy`/`scale`/`rotation` part tweak. Rotation comes from the direction of the pixels' long axis, so it's only measured on clearly elongated parts (limbs, weapons) and turns of 2–45°. Parts whose painted area changed by more than 25% count as `reshaped` and get no measured fix, since that would undo the new look. In keep-outline remixes the alpha is reused, so nothing measures and Muse's eye does the work.
3. It sends one image per pose (`ORIGINAL | REMIX NOW | REMIX + MEASURED FIXES`, parts numbered, measured ones in orange) and the part list to the backend. Muse Spark returns the final transform for the parts it changes, in screen terms; the backend keeps only known parts and clamps every value.
4. The page applies them as live tweaks; the user reviews and saves as usual. If the review fails, the measured fixes are applied on their own.

Every run, including failed ones, is saved locally (never to R2, since snapshots can show private remixes) to `backend/data/auto-tweaks/<time>_<assetId>/`: `pose-N.jpg` (the images Muse saw), `system-prompt.txt`, and `reply.json` (the text request, the part list, Muse's HTTP status and full raw response, and the validated review or error the endpoint returned, plus timing). Set `AUTO_TWEAK_LOG_DIR` to change the folder.

## Generated animations

The remix page's **Animate** tab (finished remixes only, `app/components/AnimatePanel.tsx`) adds a new animation from a prompt. It's two Muse Spark calls (`backend/src/lib/animate.ts`, effects in `animate-fx.ts`), both sent with `reasoning_effort: "high"` (`ANIMATE_REASONING_EFFORT`; the API accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`). A run takes about 2–4 minutes and doesn't count toward the monthly allowance.

1. **Inputs.** The page reads the skeleton (converting a binary `.skel` with `skelToJson`, sent as `skeleton`) and draws a **rig sheet** (`app/lib/spine-rig-sheet.ts`): the rest pose with every bone labelled beside four frames of the rig's own attack, sent as `images` (a JPEG data URL). Without the picture, Muse guessed the weapon from bone names (it swung the orc's skull shoulder pad, `SH_AC`) and struck behind the character's back. If the sheet can't be drawn, the request goes without it.
2. **Rig description.** Both calls get the request, duration and loop flag, the rig's size, one line per bone (parent, rest position and direction in screen space, its slots, and DRIVEN BY with the bone to move instead for IK and transform constraints), one line per slot in draw order (what it can show, hidden at rest, drawn behind the torso), and the largest motion per bone in the rig's own animations. Bones and slots named `fx_*` are ours and hidden from Muse.
3. **Plan.** The first call (`PLAN_SYSTEM_PROMPT`) studies the sheet and expands the request into a beat sheet: what it reads (facing, weapon bone, arm chains), the feel, timed beats, exaggerated hero poses as screen directions, overlap, and 2–4 effects. It carries 2D action best practices (startup/active/recovery, hit-stop, line of action, silhouette, arcs, weight, jumps, hit reactions, direction of strikes). Returned as `AnimateResult.plan` and shown under **Choreography**.
4. **Keys.** The second call (`SYSTEM_PROMPT`, `response_format: json_object`) keys the beat sheet. Per bone: `rotate` as `aim` (the screen direction the bone points, 0 = right, 90 = up) or `deg` (relative), `move` (screen units), `scale` (screen width/height, swapped onto upright bones' axes), `shear` (for smears), each key with an arrival ease (`snap`, `settle`, `smooth`, `linear`). Effects: `flash` (whole body, two-colour tint, at most 2 frames held, strength ≤ 0.5; only when the character is hit or powers up), `slots` (rgba tint and alpha fades, attachment swaps), `drawOrder` (slots to the front or back), and `trails` (afterimages behind a weapon bone). Spine technique rules cover rotating limbs rather than moving them, planted feet, continuous angles, moving holds and volume-keeping squash.
5. **Checks.** Unknown or constraint-driven bones, unknown slots and attachments are dropped (listed in `dropped`); values and times are clamped and times snapped to 30 fps; loops are closed. A reply with stray words in its JSON is repaired at the parse error. Aim keys are resolved parents first by posing the animation in the Spine runtime (`@esotericsoftware/spine-core`). If the chest tilts more than 45° from rest (unless the request asks for a flip or spin), the core body bones' rotations are scaled down. An unusable keyframe reply is retried once.
6. **Trails** are baked: the animation is played in the runtime, and `fx_trail_<bone>_<n>` bones and slots copy the art the weapon bone carries (for a weighted mesh, the triangles mostly weighted to it), lagging its swing relative to the chest by 2, 4 and 6 frames. They're solid colour silhouettes (two-colour tint, additive) whose alpha follows the weapon's speed relative to the body, so they only show during swings. They're added to the setup pose (invisible) and reused by later animations.
7. **Saving.** The finished skeleton is saved to a new `remixes/<time>_anim_<id>/skeleton.json` and the asset's `animations` gets `{ name, durationSec, loop }`. If the remix's skeleton changed while Muse was working, it fails with `409`.

Every run, including failed ones, is saved locally to `backend/data/animations/<time>_<assetId>/` (`system-prompts.txt` and `run.json` with the rig description, the beat sheet, Muse's raw replies and the result). Set `ANIMATION_LOG_DIR` to change the folder. `finishAnimation` turns a saved reply into the finished skeleton without new calls, for replaying replies through changed code.

## Part fixes

Below the remix result, the **Fix parts** card sits beside the sprite sheet. Once a remix has finished, its region boxes on the sheet are buttons: the user picks the parts that came out wrong, describes them, and repaints only those.

- `POST /me/remixes/:assetId/part-fixes` with `{ regions: string[], prompt, source: "original" | "remix" }` returns `202 PartFixJob`, or `400/402/404/409 { error }`. `409` means another fix on the same remix is still running. Each fix is a `remix_jobs` row (`input.kind = "parts"`), so it counts toward the monthly allowance. `GET /me/remix-jobs/:id` ignores these rows.
- `GET /me/part-fixes/:id` returns `PartFixJob`. The page keeps the id in `?fix=` (next to `?asset=`) and polls it like a remix job.
- Pipeline (`backend/src/v2/lib/part-fix.ts`): only the chosen regions are packed into the model's square. With `source: "original"`, they come from the rig the remix was made from; it falls back to the remix's own parts if that rig is gone or its atlas differs. Muse Image gets only that one image. Before painting, Muse Spark gets the same image (at 768 px), each chosen part's name and position in it, the remix job's edit prompt (or the user's remix prompt), the art style and the request. It writes the image prompt (`planPartFix`): the remix's art style in paint terms, then what each part becomes, named by where it sits and kept to one piece (no face on a torso piece, no hand on a limb). The page shows this as the fix's **Expanded prompt** (`PartFixJob.editPrompt`, stored in `remix_jobs.edit_prompt`). When Spark's reply is unusable, the request goes in as-is. An earlier version sent the rest of the remix as a reference image, and Muse Image repainted that image instead (see `FRICTION_LOG.md`). The packed parts are centred in the square, because with only one or two parts Muse Image tends to draw in the middle whatever the input shows. Part fixes don't use the full remix's `layoutFit` box check. `attachedFit` counts paint as fine if it's connected to a chosen part, even past its box, and only paint touching no part counts against the result. Then `shrinkPartsToBoxes` fits each part into its target, scaling it down evenly and centring it if it doesn't fit, so nothing is cut off. The target is the part's box less a 2% margin, so soft edges never touch the region's edge. For a part drawn by a mesh that can't be boxed, the target is also the mesh's outline, mapped from UVs to the page with `uvToPage` (which handles rotated and whitespace-stripped regions), because the game clips the part to it. Up to 1% of the part may spill past the outline, so a leaf tip doesn't shrink the whole part. An outline is used only if it holds at least 85% of the original part's opaque pixels; otherwise the atlas and skeleton may not match, and the box alone is used. Part fixes skip `fitToPage`'s drift correction, since the parts are already placed. The model is asked to paint again when under 85% of the paint is attached, or when a part would need shrinking below 50%. `prompts.json` records both numbers for each attempt under `layoutChecks`. The result is then keyed and copied into those regions only. The atlas and every page are written to a new `remixes/<time>_<jobId>/` folder, because the runtime loads pages next to the atlas. Then the remix's `files.atlas`/`files.textures` are updated in place. The previous files stay in storage; nothing points back to them yet.

- **Mesh outlines:** Spine only draws a mesh's texture inside its traced outline, so a part repainted with a new shape (a mace where a sword was) would be cut off. Before painting, the job checks the chosen regions' mesh attachments (`backend/src/lib/mesh.ts`). After painting, every *rigid* one gets a box over its whole region in the remix's skeleton, saved as `skeleton.json` in the fix's folder. Rigid means unweighted, never deformed by an animation, not linked, and with points still mapped straight from the image. If any chosen part's mesh can't be boxed, the image prompt asks the model to keep inside the original outline. `meshes.json` in the folder records what was checked and boxed. Binary `.skel` rigs are left as they are.

## Full textures (tweak panel)

**Tweak → Parts** offers the same box swap by hand. **Full textures → Show all** applies it to every rigid mesh part, and each part has a **Show the full texture** checkbox. For a part that can't be swapped, the checkbox is disabled and says why. `RigInfo.meshes` lists each mesh part with `null` (can be swapped) or a reason (`MESH_REASONS` in `app/lib/spine-mesh.ts`). The preview swaps the mesh shape live (`TweakController.planMeshes`/`applyMeshes`). **Save** writes the box into the skeleton JSON (`boxMesh` in `spine-tweak-bake.ts`), before any offset, so the offset moves the box.

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

**Example rigs:** `public/spine/` holds the base rigs, including Esoteric's official example exports, which are for development only (see `public/spine/README.md`). The same files are in the R2 bucket under `spine/` (`npm run upload:spine -w backend`); the backend serves URLs from there when R2 is configured.

**Remixes** are painted by the backend: v1 in `backend/src/lib/remix.ts`, v2 in `backend/src/v2/lib/remix.ts`. v2 started as an exact copy of v1 and will change. Both currently work the same way: Muse Spark looks at the base atlas pages and writes an edit prompt and a name, Muse Image repaints each page, and the result is resized and clipped to the original page's alpha so every region still fits its attachment. The remix keeps the base skeleton and gets a new `.atlas` + pages stored under `remixes/<timestamp>_<jobId>/` in R2 (or locally at the backend's `/files/remixes/` without R2). Only rigs with `files` can be remixed. The remix form has a **Remix API** selector, which defaults to v2, and each job records its `apiVersion`. `tint` is now only used by seed data; drop it once no asset sets it.

If grid performance becomes a problem with many real rigs, show `thumbnailUrl` images in `AssetCard`/`RigPicker` and mount `SpineRuntime` only on hover.

## Auth & users

- Sign-in is Google via Supabase Auth: `/login` starts the OAuth flow, `/auth/callback` exchanges the code for session cookies, and `/logout` (POST) clears them. Guests can browse Explore, asset pages and the remix picker; saving, remixing, the library and `/account` need an account.
- `SpineAsset.visibility` controls exposure. Only `public` assets appear in Explore, the sitemap and search engines. For now every new remix (and every copy) is public: the remix form has no visibility choice and the backend ignores `visibility` on `POST /remixes`. Public remixes appear in Explore and on the base rig's page, and anyone can remix them in turn; private ones are only shown to their owner (others get a 404). The owner can change it later with `<VisibilityToggle>` (asset page, remix result, and **My Library → Remixes**).
- Plans: everyone gets `FREE_MONTHLY_REMIXES` (default 3) a calendar month; a Stripe subscription gives `PRO_MONTHLY_REMIXES` (default 100). `/account` shows usage and opens Stripe Checkout or the customer portal. The backend's Stripe webhook is the only thing that changes a user's plan.
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
