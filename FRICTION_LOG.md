# Friction Log

This project is an entry in the **Meta Global AI Developer Hackathon**: a Spine 2D asset
site where users remix the textures of existing rigs from a prompt, using Meta's models.
This log records where building it went slower than it should have.

**Meta's models and tooling come first.** Friction with the Meta Model API, the Muse
models and Muse Code is what Meta cares about most, so it goes in the first section,
in enough detail that the Meta team could act on it. Other project friction goes in
the second section.

## Context

- **Hackathon:** building period Oct 27 – Nov 4, 2026. Submissions are due **Wed, Nov 4, 9:00 PM ET** and need a public repo and a three-minute demo video of what was built during the event.
- **This repo will be public.** Never write keys, tokens or personal data here.
- **Meta models in use (Meta Model API, `https://api.meta.ai/v1`):**
  - **Muse Spark** (`muse-spark-1.3`, `/chat/completions`): looks at the atlas pages and the user's prompt, and writes the repaint instructions (`backend/src/lib/meta.ts`, `planRemix`).
  - **Muse Image** (`muse-image-1.0`, `/images/edits`): repaints each atlas page (`repaintPage`).
  - **Muse Code:** not used yet.

## How to add an entry

Agents (Claude, Gemini, Muse Code) and people add to this file whenever something costs a
retry, a wrong turn, a wasted model run (each one spends API credits), or the user's time.
Add the entry in the same task, not later.

- Decide the section first. Anything about Meta's models, API, docs, SDKs or Muse Code goes under **1. Meta models & tooling**, even if we worked around it.
- For Meta entries, record what's needed to reproduce it: endpoint, model ID, the request fields, and the response or error text. Say whether it's **verified** (we called the API and saw it) or **from the docs** or **inferred**.
- Put new entries at the top of their section's **Log**, under a dated heading (`### YYYY-MM-DD — short title`).
- When an open item is fixed, move it out of **Open** and update its log entry's **Status**.

```md
### YYYY-MM-DD — Short title
- **What happened:** the symptom, as the user saw it.
- **Evidence:** (Meta entries) endpoint, model, request fields, response/error; verified / from docs / inferred.
- **Cost:** retries, wasted runs (credits), rework, or user time.
- **Cause:** the real reason, once known.
- **Workaround / status:** what we changed (files), or "open".
- **Ask for Meta:** (Meta entries, optional) the API, model or docs change that would remove this friction.
- **Lesson:** what to do differently next time.
```

---

## 1. Meta models & tooling

### Open

- **Muse Image can't return transparency**, so every page has to be put on a key colour and keyed back out. That's the source of most of the friction below. (2026-10-27)
- **The key colour bleeds into the repainted art** (e.g. a teal axe on cyan runs), and Muse Image has no setting to stop it. (2026-10-27)
- **Edit strength can only be set through prompt text.** We haven't found a strength or fidelity parameter for `/images/edits`; check the API reference before building more on prompt wording. (2026-10-27)
- **Muse Image moves and resizes parts** by a few percent, so we need a pixel-alignment step after every call. (2026-10-27)
- **Muse Image sometimes redraws the whole layout** on big changes, moving and duplicating parts. We check every page and repaint once, which costs an extra image call. (2026-10-28)

### Log

### 2026-10-28 — Muse Image completes fragments into whole objects
- **What happened:** two Skeleton Warrior → "human warrior, Simpsons style" remixes came back with extra parts: five boots, two heads, and limbs with hands and feet. These spilled out of their boxes and scrambled the sheet (layout scores 70% and 87%).
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`. The extras were completed versions of fragments: bone segments drawn as whole legs with feet, greaves and a boot with legs inside, an empty helmet with a head in it. Muse Spark's plans had asked for it ("repaint all horizontal bone shafts as yellow human arms and legs"). Our per-part label line also listed about 34 nouns such as "left leg bone", "tall armored boot" and "left shin plate".
- **Cost:** two remix runs and the user's time.
- **Cause:** image models are trained on whole characters and finish partial objects. Skeleton → human is the worst case because none of the parts contain flesh. Our prompts encouraged it.
- **Workaround / status:** Muse Spark is told that each part becomes the matching piece and nothing more: bone segments without hands or feet, armour left empty, one head. The image prompt adds: "Don't complete it into a whole object: no heads inside helmets, no legs inside boots or greaves, no hands or feet on limb segments." The label line is gone, and Spark no longer returns labels. One v2 test run with the same prompt (`remixes/2026-10-28T07-33-41-088Z_test_piece_rule_mvrssggh/`) kept every part in place, with one head and empty armour. A few small extras were drawn in empty space, where they get cut off anyway.
- **Lesson:** describe parts as pieces ("upper-arm segment", "empty helmet"), never as whole objects, and don't list nouns the model might draw.

### 2026-10-28 — Muse Image redrew the sprite sheet's layout on a big restyle
- **What happened:** a Skeleton Warrior remix ("human warrior, Simpsons style", `job_7470ab50`) came back with every part out of its box. The sheet showed pieces of the wrong parts.
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`. Overlaying the part boxes on the returned image showed Muse Image had drawn a new layout: parts were enlarged, spread into the empty right quarter of the page, and duplicated (five boots, two heads). Only 70% of its painted pixels fell inside the part boxes; 22 earlier runs scored 90–100%. Our own fitting cut the boxes in the right places. Run in R2 under `remixes/2026-10-28T07-10-47-960Z_job_7470ab50/`.
- **Cost:** one remix run and the user's time.
- **Cause:** a large change (thin bones turned into whole arms and legs, in a new style) and empty space on the page. The prompt's "keep every part where it is" and "leave empty areas empty" didn't hold.
- **Workaround / status:** after each page, `layoutFit` (`textures.ts`) measures the share of painted pixels inside the part boxes. Under 85%, the page is saved as `<page>.rejected.png` and painted once more with a note about the moved parts. If the second attempt also fails, the job fails with a clear message (failed jobs don't count toward the user's quota). Scores are saved as `layoutChecks` in `prompts.json`. The retry hasn't been tested against a live run yet.
- **Ask for Meta:** an edit mode that keeps the input's layout, or masks/regions on `/images/edits`, so the model can only paint inside given areas.
- **Lesson:** check the model's output geometry before using it; a cheap pixel check catches what the prompt can't prevent.

### 2026-10-28 — Muse Image painted a new layout into the padding of a wide page
- **What happened:** the Goblin remix (`job_cec7f55e`) came back without its spear.
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`. The 1024×128 page was padded to a square, so the parts filled only the top 13%. Our new per-part label line placed parts using the page's own height, so it said "long spear shaft (bottom left)", "round wooden shield (middle center)", and so on. Muse Image painted full-size parts at exactly those spots in the empty padding and left the spear's real spot as background. Once the parts were cut back out of their atlas areas, the spear was empty. Run in R2 under `remixes/2026-10-28T06-37-32-750Z_job_cec7f55e/`.
- **Cost:** one remix run and the user's time. The bug was ours (the label positions); Muse Image followed the text over the input image.
- **Cause:** wrong position words in our prompt, plus Muse Image's readiness to fill empty padding with new content.
- **Workaround / status:** pages are no longer padded. Each page's parts are packed into a square of their own, all scaled by the same factor and as large as fits, and copied back after painting (`backend/src/lib/layout.ts`; `toModelInput` and `fitToPage` in both `textures.ts`). The Goblin's parts are now 2.5× bigger and nothing is left empty. The part list sent to Muse Spark uses positions in that square (the per-part label line was later removed). Offline round trips over all 72 bundled pages showed no failures and no loss in quality from packing. Not yet checked against a real model run.
- **Ask for Meta:** honour the input's aspect ratio on edits, so atlas strips don't need padding.
- **Lesson:** anything in the prompt about where things are has to use the coordinates of the image the model actually receives.

### 2026-10-27 — Muse Image painted the orc's jaw as a foot
- **What happened:** in an Orc Berserker remix, `head_2` (the lower jaw with two tusks) came back as a green foot with a spiked cuff.
- **Evidence (inferred):** `POST /images/edits`, `muse-image-1.0`. Cut out of the head, the jaw is a rounded green block with a red wrap and two points, and it sits next to `legL`, which has the same cuff. Muse Image sees only the page and Muse Spark's `editPrompt`, never part names. Muse Spark got the names but no positions, so it couldn't tie a name to a shape. This run's `prompts.json` wasn't kept locally, so we can't tell which model got it wrong.
- **Cost:** one remix run, plus the user's time.
- **Cause:** nothing tells Muse Image what an ambiguous part is, so it goes by the silhouette.
- **Workaround / status:** Muse Spark now gets each part's page and position (`describeParts` in `backend/src/lib/remix.ts` and `backend/src/v2/lib/remix.ts`). It's told to name parts in `editPrompt` by what they are and where they sit, and the list is saved to `prompts.json`. Not yet checked against a real run.
- **Ask for Meta:** a way to pass region labels or masks to `/images/edits`, so atlas parts can be named without going through prompt text.
- **Lesson:** an atlas part shown on its own can look like a different body part; tell the image model what each one is.

### 2026-10-28 — Muse Spark takes ~47 s to review two snapshot images
- **What happened:** the first auto-tweak test waited 47 s for Muse Spark's review, so the user would watch "Muse is reviewing the fixes…" for most of a minute. Snapshotting and measuring in the browser took about 0.5 s.
- **Evidence (verified):** `POST /chat/completions`, `muse-spark-1.3`, a ~2.4 KB system prompt, a text part listing 16 parts, and two 1200×426 JPEG data URLs (`image_url`). `200` after 46.9 s with a valid JSON reply. Run saved in `backend/data/auto-tweaks/2026-10-28T05-32-35-885Z_test_skeleton-archer-orc/` (local only).
- **Cost:** user waiting time on every click; one call's credits for the test.
- **Cause:** not known; one sample. The reply also accepted all 9 measured fixes unchanged, so this run didn't show Muse adding anything beyond the measurement.
- **Workaround / status:** open. Try smaller images or one pose, and time a few more runs before deciding.
- **Ask for Meta:** publish typical latency for vision requests by image size, or offer a faster vision tier for short structured replies.
- **Lesson:** time model calls in the run log (`durationMs` in `reply.json`) so latency shows up without guessing.

### 2026-10-27 — Muse Image sometimes rejects remix prompts under its content policy
- **What happened:** every now and then a remix failed with "The image model declined this prompt", and the user had to reword it themselves and spend another run.
- **Evidence (reported by the user; request not captured here):** `POST /images/edits`, `muse-image-1.0`; the error body contains `content_policy_violation`. The rejected prompt is Muse Spark's own `editPrompt`, so our own model writes prompts the image model refuses.
- **Cost:** a failed run per rejection (the planning call and any pages already painted), plus the user's time.
- **Workaround / status:** on a `content_policy_violation`, Muse Spark re-words the `editPrompt` once and the page is retried; the UI shows the new prompt with a "Re-worded for content policy" badge (`rewordForContentPolicy` in `backend/src/lib/meta.ts`, retry in `remix.ts`). Not yet verified against a real rejection.
- **Ask for Meta:** say in the error which part of the prompt was flagged, and give Muse Spark a way to check a prompt against Muse Image's policy before spending an image call.
- **Lesson:** capture the rejected prompt and full error body next time it happens (`prompts.json` now records the re-worded prompt).

### 2026-10-27 — `/images/edits` has no transparent output
- **What happened:** we needed transparent sprite pages. The agent first claimed transparency was impossible without testing it; the user pushed back, and three test calls settled it.
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`, an RGBA PNG input, `size: "1024x1024"`:
  - with `background: "transparent"`: `400 invalid_request_error`, "`background` is not a supported image edit field";
  - without it: `200`, a 3-channel WebP;
  - with `output_format: "png"`: a 3-channel PNG, and the response includes `"background": "opaque"`;
  - a transparent input area came back **black**, because the RGB under alpha 0 is black.
- **Cost:** one round of pushback, three API calls, and the whole key-colour pipeline.
- **Workaround / status:** put pages on a saturated key colour; with outline kept, reuse the original alpha; otherwise key the colour out with unmixing and edge despill (`backend/src/lib/textures.ts`).
- **Ask for Meta:** support `background: "transparent"` on edits, as image APIs shaped like OpenAI's do; or at least keep the input's alpha.
- **Lesson:** the Meta API is OpenAI-shaped but doesn't support every OpenAI field. Test with one cheap call before saying something is impossible.

### 2026-10-27 — Output size doesn't match the requested `size`
- **What happened:** we asked for `1024x1024` and `1536x1536` and got `1600x1600` back both times.
- **Evidence (verified):** this session's test calls, and the `*.generated.png` files in `backend/data/remixes/`. The docs say quality is high up to 1600px; the default output is WebP.
- **Cost:** code has to resize every result back to the input's size, and can't trust pixel positions.
- **Workaround / status:** `fitToPage` resizes the result back to the square it sent. Pages go out as a square of packed parts (`layout.ts`), because the model only roughly keeps other aspect ratios.
- **Ask for Meta:** honour `size` on edits, or document that it's a hint and what sizes come back.

### 2026-10-27 — Muse Image shifts and stretches the parts
- **What happened:** repainted parts landed beside their original outlines, leaving bands of background colour along one edge (Skeleton Archer, and the orc).
- **Evidence (verified):** on the forest-orc run, 25% of the original part pixels fell on background before alignment. The best fit was a 3.8% vertical stretch plus a 6px shift.
- **Cost:** several remix runs (credits) and an alignment step.
- **Workaround / status:** `alignToPage` finds the stretch and shift that best match the original silhouettes and undoes it, bringing the 25% down to 4%. The rest is filled from neighbouring colour.
- **Ask for Meta:** a mode for edits that keeps the input's geometry: same size, nothing moved.

### 2026-10-27 — The background colour gets painted into the parts
- **What happened:** the final textures showed a cyan rim and a dark-teal outline, and the axe came back teal.
- **Evidence:** verified that where the model's dark outline meets cyan it paints dark teal, e.g. RGB (20, 80, 85). Inferred that cyan tints the art: in a test on a black background, with a similar but not identical prompt, the axe came back grey steel.
- **Cost:** three fix rounds and two wasted runs.
- **Workaround / status:** unmix the edges, despill within 4px of the background, and fill gaps from neighbouring colour (`textures.ts`). Colour bleeding into the art itself is still open.
- **Ask for Meta:** transparency support (above) would remove this whole class of problem.

### 2026-10-27 — A grey background hid grey parts
- **What happened:** the Skeleton Archer remix left the bones unpainted.
- **Evidence (verified, then fixed):** parts close to the grey background colour were treated as background. A run on magenta painted every part.
- **Cost:** a bad run, and a first investigation that couldn't see what was sent (see "Remix runs couldn't be debugged").
- **Workaround / status:** saturated key colours; `pickBackground` chooses the one farthest from the rig's colours and the prompt's.
- **Lesson:** for image edits, the background colour is part of the prompt. Tell the model what colour it is, and keep it far from the art.

### 2026-10-27 — Edit strength has no direct parameter
- **What happened:** the user had to ask whether the strength slider reached the Meta API at all.
- **Evidence (inferred from our code and the docs we read):** `/images/edits` is sent `model`, `prompt`, `images`, `size`, `n`. Strength only goes to Muse Spark as a phrase ("subtle / moderate / bold"), and reaches Muse Image only if Spark carries it into the edit prompt.
- **Workaround / status:** open.
- **Ask for Meta:** a strength or fidelity parameter for edits, or documentation of how much the prompt controls change.

### 2026-10-27 — Image calls can take minutes
- **What happened:** the user had to ask whether long jobs and timeouts were handled.
- **Evidence:** Node's built-in fetch gives up after 5 minutes without response headers, which is too short for image generation. The docs list retryable `503 server_error` responses.
- **Workaround / status:** `ai-fetch.ts` uses an undici agent with no header or body timeout, plus a timeout per call and per job (`config.ts`, set in `.env`), and one retry on 503. Remixes run as background jobs with a progress bar.
- **Ask for Meta:** streaming or progress events for image jobs, so clients can show real progress instead of an estimate.

### 2026-10-27 — Muse Spark structured output
- **What happened:** the plan needs JSON (`{name, editPrompt}`).
- **Evidence (from the docs):** the chat-completions docs mention `response_format` but don't describe the format types or JSON-mode behaviour.
- **Workaround / status:** we ask for "JSON only" in the system prompt and parse the first `{` to the last `}`. An unusable reply falls back to the user's own prompt, which drops strength and style.
- **Ask for Meta:** document `response_format` / JSON-schema support for Muse Spark.

---

## 2. Other project friction

### Open

- **RogueBard preview is broken.** It shows "Preview unavailable" with `Animation bounds are invalid: idle_aggressive`, even though its default skin has attachments. Not yet investigated. (2026-10-27)
- **Dev-server reloads kill remix jobs.** `tsx watch` restarts the backend on every file save, and jobs only live in memory, so a running remix is lost, wasting its credits. Its folder ends up with only `prompts.json`. Don't edit backend files while a remix is running, or tell the user their run was lost. Since the Supabase work, the lost job is marked failed (on the next poll and at startup) so it doesn't use up the user's monthly allowance, but the run itself is still lost. (2026-10-27)
- **Keyed mode is untested in a full run.** The despill fix for keyed mode (outline not kept) was only checked offline on saved model output. Still to see: gaps at joints, parts cut off at their region rectangle, and art close to the key colour turning transparent. (2026-10-27)
- **Spine viewer `dispose` crash.** A failed skeleton download makes the Spine runtime throw `Cannot read properties of null (reading 'dispose')`. The cause was found, but the fix (fetch the rig files ourselves, fall back to the placeholder) was never applied. (2026-10-26)
- **Node version.** React Router needs Node > 22.22.0; the dev machine's nvm default is 22.20.0. Most frontend commands only warn, but `npm run typecheck` fails outright in `react-router typegen` ("Oops, Node v22.20.0 detected"), which cost a retry on 2026-10-28. Workaround: Homebrew's Node 24 is installed, so run `PATH=/opt/homebrew/bin:$PATH npm run typecheck`, or `nvm install 24` and make it the default. (2026-10-27)
- **API keys appeared in plain text in chat sessions.** The Meta key and the Cloudflare API token (which the R2 credentials are derived from) are stored in `backend/.env` (gitignored), but rotate both before the repo goes public. Rolling the Cloudflare token changes `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` too. (2026-10-27)

### Log

### 2026-10-28 — v2 reshape remixes had parts cut off at their region edges
- **What happened:** on newer v2 remixes (slime dog, squire, peashooter, assassin) eyes, arms and the mouth were cut in half in the final atlas page, though Muse Image's raw output had them whole and in place.
- **Cost:** four remixes with damaged textures (credits), and diagnosis time.
- **Cause:** `alignToPage` undoes the model's real drift (about 2% vertical stretch, 1–3 px sideways) by matching row and column coverage to the original page. In reshape mode (keep outline off) the model deliberately grows parts (ears, a hat, a hood: body area 1.4–1.7×), which dragged the fit to 4–8% stretches and shifts of up to 41 px. That pushed correctly placed parts out of their regions, and the region clip cut them.
- **Workaround / status:** fixed for v2. In reshape mode the drift is now fitted from the centres of parts that kept roughly their size (±25%), one vote per part, and no correction is made when fewer than two qualify (`backend/src/v2/lib/textures.ts`). Re-running it on the saved outputs of all seven v2 remixes: the broken ones keep far more of each part (squire's worst part 0% → 82%), and the earlier, correctly aligned ones are unchanged. Keep-outline mode still uses the coverage fit. Already-saved remixes keep their damaged pages unless rebuilt.
- **Lesson:** an alignment that matches old silhouettes is only valid when silhouettes are meant to stay. Log the fitted scale/offset per job so a fit stuck at its limits is visible.

### 2026-10-28 — Remix textures from R2 failed to load in the viewer
- **What happened:** the first two remixes stored in R2 finished and were saved, but the viewer showed "Couldn't load image" for their texture pages.
- **Cost:** two remix results that looked broken; time spent diagnosing.
- **Cause:** R2 only sends `Access-Control-Allow-Origin` (and `Vary: Origin`) when the request has an `Origin` header, and remix files are cached for a year. The sprite sheet's plain `<img>` (no `crossOrigin`) loaded the page first, the browser cached the CORS-less response, and the Spine runtime's `crossOrigin = "anonymous"` load reused it and was refused.
- **Workaround / status:** `crossOrigin="anonymous"` on the sprite sheet image (`frontend/app/components/SpriteSheet.tsx`). Browsers that already cached the bad response need a hard refresh.
- **Lesson:** load every cross-origin file the WebGL viewer uses in CORS mode, everywhere it appears on the page.

### 2026-10-27 — Moving rigs to R2 broke new remixes
- **What happened:** after the base rigs moved to R2, the frontend sent absolute `https://pub-….r2.dev/...` atlas URLs, but the backend's remix route only accepted plain `/spine/...` paths, so every new remix would have failed with "This rig has no textures to remix." Caught while reading the code for the Supabase work, before anyone ran a remix.
- **Cost:** no wasted runs; one wrong turn.
- **Cause:** the backend trusted, and therefore tightly validated, a file URL sent by the frontend. Changing where files live broke that check.
- **Workaround / status:** fixed. The backend now looks up the base rig in Supabase by `baseAssetId` and builds file URLs from stored keys (`backend/src/lib/remix-jobs.ts`, `storage.ts`).
- **Lesson:** after moving files, run one remix end to end. Don't let the client send URLs the server will fetch.

### 2026-10-27 — Some rigs never rendered: empty default skin
- **What happened:** EmberSerpent and FireBurstVFX showed "Preview unavailable" in the viewer and on the remix page. This only came to light while testing the new tweak panel, because EmberSerpent is one of only two rigs with physics.
- **Cost:** one investigation; it also hid these rigs from every demo.
- **Cause:** their `default` skin has no attachments, and `files.skin` was null, so the player measured empty bounds and threw `Animation bounds are invalid`.
- **Fix / status:** `skin: "023"` and `skin: "HuoYan"` in `mock-data.server.ts`. RogueBard fails with the same error for a different reason (still open).
- **Lesson:** when adding a rig with several skins, check that its `default` skin isn't empty and set `files.skin` if it is.

### 2026-10-27 — `git stash` during a test killed the running dev servers
- **What happened:** an agent ran `git stash` / `git stash pop` to compare against `master` in a browser, and both dev servers (`npm run dev`) stopped and had to be restarted.
- **Cost:** the user's dev session; any remix job running at the time would have been lost (jobs live in memory).
- **Fix / status:** restarted. Compare against `master` in a separate worktree instead.
- **Lesson:** don't swap the working tree under a running dev server; use `git worktree add` for before/after checks.

### 2026-10-27 — Background colour still visible after the fix
- **What happened:** after the first keyed-mode fix, a run still showed a dark-teal outline around every part.
- **Cost:** one wasted remix run.
- **Cause:** dark edge pixels the model blended into the key counted as solid outline.
- **Fix / status:** `despillEdges` in `textures.ts`. Teal-tinted pixels in that run went from 15,222 to 3,051, and what remains is legitimate blue/teal art.
- **Lesson:** check a fix against the run that showed the bug. To test a fit change, re-run `fitToPage` on the saved `*.generated.png` offline. It reproduces the output byte for byte and needs no model call.

### 2026-10-27 — The original outline cut off new shapes
- **What happened:** the original page's alpha cut off anything the model drew outside the old outline, even with "keep outline" off.
- **Fix / status:** with "keep outline" off, `fitToPage` keys the background out of the model output and clips it to each region's rectangle, which `parseAtlas` now reads.
- **Lesson:** the "keep outline" option has to change the compositing too, not just the prompt.

### 2026-10-27 — Remix runs couldn't be debugged
- **What happened:** we couldn't check what a bad remix had sent, or tell which output folder belonged to which run.
- **Fix / status:** prompts are logged, folders are named `<ISO timestamp>_<jobId>`, and each run writes `prompts.json` and `*.generated.png`.
- **Lesson:** save the inputs and raw outputs of every model call from day one.

### 2026-10-27 — Restructured into a monorepo after the frontend was built
- **What happened:** the app was built as a single React Router project, then moved into `frontend/` to make room for `backend/`.
- **Lesson:** if a backend is planned, start with workspaces.

### 2026-10-26 — Interrupted run: did it change anything?
- **What happened:** the user interrupted a debugging run and had to ask whether to undo its changes. It had only touched scratch files.
- **Lesson:** while debugging, keep experiments in the scratchpad and say which project files changed.

### 2026-10-26 — Spine viewer `dispose` crash was slow to diagnose
- **What happened:** the site threw `TypeError: Cannot read properties of null (reading 'dispose')`; reading the library source didn't find the cause.
- **Cause:** the Spine runtime treats a network-level failure as a successful download, then crashes on cleanup.
- **Fix / status:** open (see above).
- **Lesson:** for runtime errors, reproduce in the browser first (e.g. by blocking the request).

### 2026-10-26 — Product scope changed after the UI was built
- **What happened:** the first UI generated rigs from scratch. The real product remixes the textures of existing library rigs.
- **Lesson:** confirm the core user flow before building screens.
