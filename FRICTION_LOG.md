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
  - **Muse Spark** (`muse-spark-1.3`, `/chat/completions`): looks at the atlas pages and the user's prompt, and writes the repaint instructions (`backend/src/lib/meta.ts`, `planRemix`). Also writes the keyframes for generated animations (`backend/src/lib/animate.ts`).
  - **Muse Image** (`muse-image-1.0`, `/images/edits`): repaints each atlas page (`repaintPage`).
  - **Muse Code:** not used; it isn't on the Model API (see the 2026-10-28 entry).

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

- **Muse calls can't be priced from the API:** responses have tokens but no cost, and the rates in `MUSE_RATES` are unconfirmed third-party figures. (2026-11-02)
- **Muse Image can't return transparency**, so every page has to be put on a key colour and keyed back out. That's the source of most of the friction below. (2026-10-27)
- **The key colour bleeds into the repainted art** (e.g. a teal axe on cyan runs), and Muse Image has no setting to stop it. (2026-10-27)
- **Edit strength can only be set through prompt text.** We haven't found a strength or fidelity parameter for `/images/edits`; check the API reference before building more on prompt wording. (2026-10-27)
- **No mask on `/images/edits`:** asked to repaint only some areas, Muse Image redraws the whole image and can add content (a second face in an auto-rig parts sheet). (2026-11-02)
- **Muse Image ignores `size` and returns WebP:** asked for 1024×1024, got 1600×1600 WebP. Decode by content, not by extension, and don't rely on the output size. (2026-11-02)
- **Muse Image moves and resizes parts** by a few percent, so we need a pixel-alignment step after every call. (2026-10-27)
- **Muse Image sometimes redraws the whole layout** on big changes, moving and duplicating parts. We check every page and repaint once, which costs an extra image call. (2026-10-28)
- **Ambiguous atlas pieces get the wrong content:** Spark called the scarf-wrapped torso a helm, and Muse Image painted a face into it. (2026-10-28)
- **Muse Code isn't on the Model API.** `GET /v1/models` lists no Muse Code model, so the backend can't call it; planned "generate an animation with Muse Code" has to use Muse Spark instead. (2026-10-28)
- **Muse Spark can't key weapon swings it plans correctly**, and its review pass sees the failure without fixing it (overhead axe chop). (2026-11-02)

### Log

### 2026-11-02 — Muse Spark put a knight's hips at knee height, twice
- **What happened:** an auto-rigged knight tore at the legs whenever it stepped. Each thigh piece was the whole upper leg plus the hip, turning around a point near the knee.
- **Evidence (verified):** `POST /chat/completions`, `muse-spark-1.3-contributor`, `reasoning_effort: "low"`, JSON reply. The input was the cutout on a 0–1000 grid plus the silhouette's guess. Traces: `remixes/2026-11-02T22-13-46-234Z_autorig-prep_c75cbdd7/prepare.json` and `…22-24-13-471Z_autorig-prep_43bb1a50/prepare.json`.
  - **The reply:** pelvis at y 683, hips at y 748, knees at y 790. That makes the thighs 0.32–0.47× the length of the shins.
  - **The prompt said:** "hip: the top of the thigh inside the body, where the leg swings from (under any belt, skirt or loincloth)".
  - **The notes didn't mention it:** Spark's own notes covered only the neck and shoulders.
  - **Normal range:** the other runs and the 8 test characters came out at 0.6–2.1×.
- **Cost:** one bad rig saved, and a wrong turn (blaming the hidden-area fill) until the joints were measured.
- **Cause (inferred):** the cape and pouches hide the top of the legs, and Spark placed the hips on the visible leg armour instead.
- **Workaround / status:** fixed in `checkJoints`. A hip further than 20% of the leg's length from the pelvis's height is moved level with it and flagged. A thigh under 0.55× its shin falls back to the silhouette's guess. The joint editor now shows where the rig will cut, so a bad joint can be seen before building. On the second run, the check lifted both hips and flagged them.
- **Lesson:** check model-placed geometry against body proportions, not just "on the body".

### 2026-11-02 — SAM 3.1's request format isn't on its model page, and generic phrases miss gear on pixel art
- **What happened:** to test SAM 3.1 gear masks for auto-rig slicing, we first had to find how to call it. The model page (dev.meta.ai/models/sam-3-1) gives the price but no request or response example. Search results led to a community demo before the segmenting guide (dev.meta.ai/docs/sam/segmenting).
- **Evidence (verified):** `POST https://api.meta.ai/v1/responses`, `model: "sam-3.1"`, one user message with an `input_text` phrase and an `input_image` data URL, `metadata: { include_confidence: "true" }`, not streamed.
  - **Output:** one `output_text` of special tokens (`<0f>id<|box;…|><|mask;…|>`). It needs `@meta-sam/parser` to decode.
  - **Usage:** 0 tokens and `images_processed: 1`.
  - **Speed:** each call took 1.5–3.4 s, and 5 sent at once finished in 2.3–3.4 s.
  - **Hand-drawn knight (1024 px):** cape, both kneepads, both hands and the plume came back clean, at confidence 0.54–0.95. "Shoulder armor" got one pauldron whole but only part of the other (0.63).
  - **Pixel-art knight fixture (690 px):** "knee pad" and "helmet plume" returned nothing, and "shoulder armor" matched only two small gems.
  - **All five phrases in one call:** comma-separated, they returned 0 and 1 matches, as the guide warns.
- **Cost:** a few searches and one script fix; about 22 SAM calls (~$0.06 at the listed rate).
- **Cause:** documentation layout for the format. Fixed phrases don't fit every art style, so the phrases have to be written per character.
- **Workaround / status:** built in `backend/src/lib/autorig/gear.ts`. Muse Spark writes the phrases for each character, and its prompt asks for plain words. One phrase goes per call, all sent at once.
  - **Wording matters:** on the same knight, "knee armor" found nothing where "knee pad" found both kneepads, and "shoulder pad" found both pauldrons whole where "shoulder armor" got one partly.
  - **Fallback:** a pad phrase that finds nothing is retried once under its plain name.
  - **Masks stop inside the outline:** SAM's masks end just inside the art's black outline, so the outline stayed with the neighbouring limb. We grow each mask by 2 grid cells.
  - **Still open:** "plume" matched on one run and missed on the next. The orc's skull pauldrons aren't found under any phrase we tried.
- **Ask for Meta:** a request and response example on the model page, and several phrases per image call.
- **Lesson:** for a Meta model, start from the dev.meta.ai docs guide for its family, not the model page.

### 2026-11-02 — A flat marker colour gets Muse Image to paint hidden areas, but it bleeds the marker into what it paints
- **What happened:** following the no-mask entry below, we painted each auto-rig part's hidden areas one flat colour the character doesn't use (green, or yellow for a green-haired character) on magenta, asked Muse Image to paint over that colour, lined up each piece with its redraw, and copied back only the marked pixels. Muse painted most of the marker with good detail (a black knight's armour under its arms, an orc's skin and fur cuffs). But on the black knight it painted the thigh tops and crotch as dark green cloth: the marker's colour came through in the art.
- **Evidence (verified, `POST /v1/images/edits`, `muse-image-1.0`, `size: 1024x1024`, 6 calls on 3 parts sheets, 15–34 s, 13–36k input tokens):** after lining each piece up (shifts of up to 10 px in Muse's redraw, then a mean colour difference of 10–16 on the piece's own pixels), Muse painted 62–100% of the marked pixels. With a check that keeps a painted pixel only if its colour already occurs in that piece's own art, 91–97% are kept and the green cloth is gone.
- **Cost:** 6 test calls (a few cents) and one rework of the copy-back check.
- **Cause (inferred):** the same key-colour bleed as remixes (see Open): the model treats the marker as a colour of the scene, not as "nothing here".
- **Workaround / status:** worked around in `backend/src/lib/autorig/muse-fill.ts` (marker chosen from the art's least-used colours, per-piece alignment, own-palette check, the code's smear kept elsewhere). Still open: in some runs Muse paints a head-like shape into the torso's neck area; it only shows if the head turns far.
- **Ask for Meta:** a mask input on `/images/edits`; failing that, a way to say "this colour is empty space".
- **Lesson:** a flat marker colour tells the model where to paint far better than a smear does, but every pixel it paints there still has to be checked.

### 2026-11-02 — Muse Image can't repaint only part of an image: asked to fill hidden areas, it redrew the whole sheet and added a face
- **What happened:** for auto-rig slicing, we cut a character into 14 parts and filled each part's hidden areas (where another part covers it at a joint) by smearing colour. We asked Muse Image to repaint only those smeared areas with real detail and leave everything else alone. It painted good detail there (shoulders under the arms, fur cuffs at the wrists, boot tops), but it also repainted every piece, and it drew a complete second orc face into the torso's neck area, which would show whenever the head turns.
- **Evidence (verified, `POST /v1/images/edits`, `muse-image-1.0`, `size: 1024x1024`, one 870×870 parts sheet on #FF00FF, 12.6 s, usage 12,554 in / 1,008 out):** the pieces' outlines match the input at 92.5% IoU after a 3 px shift, and the pieces cover 4% more pixels. Where both images have a piece, the mean colour difference is 66 (sum over RGB, 0–765), so the art we asked it to keep was redrawn.
- **Cost:** one test call (about a cent), plus the decision to ship the code fill for now.
- **Cause (inferred):** `/images/edits` has no mask input, so "repaint only these areas" can only be asked in the prompt, and the model edits the whole image. Pieces that look like part of a body get completed with whatever is typical (a face above shoulders).
- **Workaround / status:** open. The auto-rig keeps its code fill. A Muse pass would have to keep our pixels, take Muse's only inside the hidden areas, align each piece separately, and check for invented content.
- **Ask for Meta:** a mask parameter on `/images/edits` (inpaint only where the mask is set), as other image APIs offer.
- **Lesson:** without a mask, treat an edit as a full repaint, and copy back only the pixels you need.

### 2026-11-02 — Muse Image under-does pose instructions, and its input token count varies for the same request
- **What happened:** testing whether Muse Image can redraw an uploaded character in a rig-ready pose (for auto-rigging). Identity, prop removal and the flat magenta background were all good. But each pose instruction was only partly followed: "arms about 45° down" came out at about 20–30° (front view) or near horizontal (three-quarter view); "filling about 80% of the image height" came out at 86–94%, with one character touching the side edges; "three-quarter view facing right" gave a slight turn of roughly 15–30°, and the orc stayed almost front-on.
- **Evidence (verified, `POST /v1/images/edits`, `muse-image-1.0`, `size: 1024x1024`, `n: 1`, one 1024×1024 PNG in `images`, 8 calls on 4 rig renders):** 13–33 s per call. `usage.input_tokens` was 12.6k–35.2k for the same image size and nearly the same prompt (e.g. the same skeleton render: 12,587 front-view vs 35,159 three-quarter), so the token count doesn't follow from the request alone.
Every reply was a **1600×1600 WebP** although the request asked for `size: "1024x1024"`; we'd saved them as `.png`, and macOS `sips` refused to convert them until we checked the real format (verified with PIL).
- **Cost:** none wasted. 8 test calls, all usable. About 10 minutes lost to the WebP files saved as PNG.
- **Cause (inferred):** the model treats angles, framing and view as soft hints, and there's no pose or framing parameter.
- **Workaround / status:** open. Plan to pad the result in code (don't trust framing) and to treat the view as "front" or "turned right" rather than an exact angle.
- **Ask for Meta:** a pose/view or reference-pose input for `/images/edits` (e.g. a pose skeleton image), and documentation of what `input_tokens` counts for image edits.
- **Lesson:** for geometry (angles, framing), check the output in code. Prompt numbers are approximate.

### 2026-11-02 — Muse Spark's overhead axe chop never went overhead, and its review pass didn't fix it
- **What happened:** the user asked for a heavy two-handed overhead axe chop on the Gangrenous Ghoul Warrior. The result never lifts the axe over the head: the wind-up buries it across the torso, the strike goes from the rest pose straight down, and at impact the body sinks to the ground line, the axe goes through the floor and a piece of the axe separates from the rest.
- **Evidence (verified, `POST /chat/completions`, `muse-spark-1.3-contributor`, run log `backend/data/animations/2026-11-02T14-45-13-136Z_gangrenous-ghoul-warrior-aeb5c6c7`, local):** 1.25 s, no loop, a 460-character prompt. The plan read the rig correctly (faces right, axe on `fuzi`/`fuzi2`, grip at `target2`) and asked for the right poses (`fuzi` aiming 150° at the top, then a 170° arc to −20°). The keys didn't produce them (see `strip-first.jpg`). Code had to apply three fixes: the body tilt was scaled down, and the leg IK targets were pulled back from up to 191% of the leg's reach. The review call (first live run of `reviewAnimation`) described the problems correctly ("Top buried axe in torso… handle stayed at ground while hands flew up") and returned new keys, but `strip-final.jpg` shows nearly the same motion. The trail was dropped because the plan put it on `fuzi2`, which has no art. 3 Spark calls, 277 s in total.
- **Cost:** one user run (about 4.5 minutes) with an unusable result, and the user's time.
- **Cause (inferred):** Spark can describe the poses and spot what's wrong in the frames, but it can't turn either into keys that land the axe where it says. The review sees the failure without being able to correct it.
- **Workaround / status:** open. Options under discussion: motion templates and IK in code, with Spark choosing parameters, plus numeric checks (axe tip path, hands on the handle, nothing below the ground) instead of a vision review.
- **Lesson:** a vision review only helps if the model can act on what it sees. For geometry, check and fix in code.

### 2026-11-02 — Muse Spark ignored the leg-reach rule, and edits kept the broken poses
- **What happened:** the user found generated animations weak and broken-looking. On the Gangrenous Ghoul Warrior, the "Come Here Taunt" and its "make it feel heavier" edit spread the feet so far that both legs would have to be about 1.5× their length.
- **Evidence (verified, `POST /chat/completions`, `muse-spark-1.3`, `reasoning_effort: medium`, run logs in `backend/data/animations/2026-11-01T19-43-06…` and `2026-11-02T06-15-37…`, local):** the keys prompt says "keep each foot within its leg's reach of the hips (about 90% of the leg's length)". Spark moved IK target `2233` to (+290, +11) and `target22` to (−236, +11) while dropping the hips (`bone2`) by 85. The legs are 210 and 204 units long, and reaching those feet would need 322 and 318 (153% and 156%). The edit was handed the old motion and told to keep it, so it kept both offsets. Across the last 8 successful runs, Spark took 79–206 s and wrote 8–20k completion tokens per keys call.
- **Cost:** at least two user runs (the taunt and its edit), and the user's time.
- **Cause (inferred):** prompt rules about geometry aren't enforced, and Spark never sees what its keys produce.
- **Workaround / status:** fixed in `backend/src/lib/animate.ts`: `clampReach` pulls two-bone IK targets back to 92% of the chain's posed length at each key. Replaying the saved replies, it caught both broken runs (up to 158%) and changed nothing in the other five. A review call (`reviewAnimation`) also shows Spark 8 frames of its first pass (`animate-render.ts`) and asks it to fix them. The frames of an earlier "overhead slam" show the axe barely moving and the body sinking below the ground, which the review is meant to catch. The review hasn't been run against Muse yet.
- **Lesson:** enforce physical limits in code. A rule written only in the prompt is a suggestion.

### 2026-11-02 — No way to price a call: no cost in responses, Muse Image reports 0 tokens, no reachable rate sheet
- **What happened:** to charge users credits for generated animations by what they really cost, we needed the price of each Muse call. Nothing in the API gives it, and Meta's pricing page couldn't be read, so the rates came from third-party listings that disagree.
- **Evidence (verified):** `POST https://api.meta.ai/v1/chat/completions` with `muse-spark-1.3-contributor` returns `usage` (`prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens`) but no cost or billing tier. `POST /v1/images/edits` with `muse-image-1.0` returns a `usage` object whose token counts are all 0 (8 v3 remix logs, 18 image calls, in `backend/data/remixes/*/prompts.json`). **Correction (verified, 2026-11-02):** that 0 came from our code, not the API. Muse Image's `usage` uses `input_tokens` / `output_tokens` / `total_tokens` (e.g. 12861 / 1272 / 14133 for one 1024×1024 edit), and `recordUsage` in `backend/src/v3/lib/meta.ts` reads only the chat names (`prompt_tokens`, `completion_tokens`), so it stored 0. Meta's rate sheet (dev.meta.ai/docs/pricing-rate-limits) couldn't be opened; third-party sites list Spark 1.3 at $1.25/$4.25 per million tokens, the contributor tier at $0.10/$0.20 (one source only), and Muse Image at $0.01 per image (one source only) (from third-party listings, not verified against Meta).
- **Cost:** about an hour of searching and cross-checking, and the credit prices rest on rates we can't confirm.
- **Cause:** the API reports tokens but not price, image calls report no usable usage, and the official pricing page wasn't reachable.
- **Workaround / status:** prices live in one table, `MUSE_RATES` in `backend/src/lib/config.ts`, with unknown models priced as standard Spark so nothing comes out free. Animation jobs store `cost_usd` and per-model token counts (`animation_jobs`), so they can be re-priced if the rates change. Open until Meta's rates are confirmed.
- **Ask for Meta:** return the cost (or the billed units and tier) of each call in the response, report image usage as images or pixels rather than zero tokens, and keep a public, linkable rate sheet that covers the contributor tiers.
- **Lesson:** keep raw usage for every job from the start, so pricing can be fixed later without guessing.

### 2026-10-31 — Muse Image moved the off-limits shapes it was told to leave alone
- **What happened:** On `ember-fire-knight-7e215105`, the part fix "turn this axe into a sword" (`job_2d65de90`, region `fuzi`) succeeded, but 18% of the new sword's paint ended up under neighbouring parts, and the sword came back upside down (pommel where the axe head was).
- **Evidence (verified):** `/images/edits`, `muse-image-1.0`, 1536×1536. Input: the axe on solid magenta, with the other parts sharing its atlas box drawn as flat solid pure blue shapes. The prompt said "The flat solid pure blue shapes are space other parts use: leave them exactly as they are, solid pure blue, and keep every new part off them". The output kept the shapes blue but narrowed and moved them (the big shape on the right and the ones at the top), and the blade ran into the space where the armour piece really is. Layout checks passed (attached 1, scale 1). R2 folder `remixes/2026-10-31T02-00-20-650Z_job_2d65de90`. The previous run, `job_37f11e88`, kept every shape in place, so it varies between runs.
- **Cost:** One paid fix with a broken result.
- **Cause:** Muse Image treats the off-limits shapes as editable layout, not fixed pixels. The orientation is our gap: neither prompt said which end of the weapon is held.
- **Workaround / status:** Open for the moved shapes. Planned: check that they came back where they were sent (repaint once, then fail). The orientation gap is addressed: Spark rule 5 in `PART_FIX_SYSTEM_PROMPT` now has Spark state each changed part's orientation (which end is held or joins the body, where the other points) and keep the held end in place. Not yet tried with a live run.
- **Ask for Meta:** A mask or "preserve these pixels" input for `/images/edits`, so areas outside the edit can't move.
- **Lesson:** An instruction to leave pixels alone isn't enough: verify it.

### 2026-10-30 — Asked to erase a part, Muse Image invented new parts instead
- **What happened:** On the slime remix (`rotting-ghoul-slime-6cc9a424`), two part fixes on `shadow` ("let's remove the shadow altogther. make it blank", "remove this piece altogether") both failed with "The image model moved the parts out of place twice."
- **Evidence (verified):** `/images/edits`, `muse-image-1.0`. Input: one faint shadow on solid magenta. Spark's plan said "Erase the wide central shadow… leaving empty transparent nothing". Muse Image returned an invented ring of armour pieces (helmet, greaves, boots) on one attempt and five purple shards on the other. Layout checks: attached 0.1/0.22 (`job_c7be717b`), 0.2/0.89 with scale 0.235 (`job_0bdac940`). R2 folders `remixes/2026-10-30T13-3*_job_{c7be717b,0bdac940}`.
- **Cost:** 4 image calls + 2 Spark plans, no result. Failed jobs aren't counted against the allowance.
- **Cause:** The part fixer only repaints. "Remove" goes to the image model, which won't return an empty canvas when asked to edit one. It fills the empty square with something.
- **Workaround / status:** Open. A remove request shouldn't call a model: hiding the part (tweak panel "Hide this part") or clearing its region pixels does it.
- **Ask for Meta:** An edit that's told to erase everything should be able to return the background unchanged.
- **Lesson:** Catch removal requests before the model call and handle them without the model.

### 2026-10-29 — Production remixes failed with model_not_found, and the error doesn't say which model
- **What happened:** On rigforge.app, remixes failed and the backend logged `Muse request failed (404) {"error":{"code":"model_not_found","message":"The requested model was not found.","param":null,"type":"invalid_request_error"}}`. Locally everything worked.
- **Evidence:** `POST /v1/chat/completions` with the local key, verified: `muse-spark-1.3` and `muse-spark-1.3-contributor` both answer; `muse-spark-1.3-typo` returns exactly the production error. `GET /v1/models` lists both Spark ids and `muse-image-1.0`. So production sent an id the API doesn't recognise: a wrong or quoted/padded `MUSE_MODEL`/`IMAGE_MODEL`, or a key without access (inferred; production env not checked yet).
- **Cost:** Failed production remixes, plus debugging time.
- **Cause:** Render logs (verified) show every production Spark call, 22 of them from 04:16 UTC, sent `muse-spark-1.3-contributor` with no stray characters and got `model_not_found`. After deploying the startup check (08:02 UTC), `GET /v1/models` with the production key returned 200 with an **empty** model list (verified in the Render log), while the local key lists 9 models. So the production key authenticates but has no model access at all, not just no contributor tier; the cause on Meta's side (credits, project setup) is still unknown. The error body doesn't echo the requested model, and an accepted key with no models gives `model_not_found` rather than an access error, so this took log digging to establish.
- **Workaround / status:** `backend/src/lib/config.ts` strips quotes and whitespace from `MUSE_MODEL`/`IMAGE_MODEL` (and the key); the backend checks `GET /v1/models` at startup and logs any configured model the key can't use; every "request failed" log names the model.
- **Ask for Meta:** Put the requested model id in `model_not_found` errors (e.g. `"The model 'x' was not found."`), as other OpenAI-compatible APIs do. When a key has no model access (e.g. no credits), say so with a 403 and a reason, rather than an empty `/models` list and 404s.
- **Lesson:** Log the model id with every model error, and check configured models at startup.

### 2026-10-28 — Muse Image has no style-reference input, so a reference image has to go through Spark as text
- **What happened:** For "remix from a reference image", the natural design is to give Muse Image the user's image as a style reference. `/images/edits` treats every image in `images` as something to edit: in part fixes it repainted the reference instead of the parts (see the part-fix entry below). So the reference never reaches Muse Image. Muse Spark describes it first (`describeReference`), and only that text goes into the plan and the image prompt.
- **Evidence:** `POST /v1/chat/completions`, `muse-spark-1.3`, system prompt + text + two `image_url` parts (reference at 1024px, one atlas page at 768px), no `response_format`. Verified: it returned clean JSON (`look`, `style`) in 18.5 s and 21.9 s. The look was concrete and paintable (named colours, materials, where they sit). Its style call was right: the test pair (water elemental vs stone golem) really does differ in rendering. Muse Image's lack of a reference input is inferred from the part-fix run, not from the docs.
- **Cost:** One extra Spark call (~20 s) on every reference remix. Some detail is lost because the image becomes text.
- **Cause:** `/images/edits` has no separate field for a style or subject reference.
- **Workaround / status:** `backend/src/v2/lib/meta.ts` (`describeReference`), `backend/src/v2/lib/remix.ts`.
- **Ask for Meta:** A `reference_images` (or `style_image`) field on `/images/edits` that guides style and palette without being edited itself.
- **Lesson:** Vision models read images well. For the image model, turn references into text.

### 2026-10-28 — Muse Spark animated the wrong part and the wrong direction from bone names alone
- **What happened:** rendered with textures, generated animations swung the orc's skull shoulder pad instead of the axe, struck behind the character, and raised arms when it meant to punch forward.
- **Evidence (verified, `POST /chat/completions`, `muse-spark-1.3`; 22 generations plus replays, rendered to video in `backend/data/animation-videos/`, local):** given only text (bone names, positions, directions), Spark named `SH_AC` as the axe (it's the shoulder accessory; the axe is on `ARM_L`/`ARM_L3`/`ARM_L4`). With a labelled rig sheet as an `image_url`, its plan read "faces right, axe handle at ARM_L4" on every run. Separately, relative rotations came out with the wrong sign (an arm keyed to "snap forward" went up); with "aim" keys (screen directions) resolved by our code, posed bones landed within a few degrees of the requested direction, the worst 14° off.
- **Cost:** about 8 generations before the sheet and aim keys, and the user's time.
- **Workaround / status:** fixed: the page draws a rig sheet (`frontend/app/lib/spine-rig-sheet.ts`) and the backend accepts screen-space aim keys (`resolveAims` in `backend/src/lib/animate.ts`).
- **Lesson:** give Spark a picture of anything spatial, and let it state goals in the frame it reasons in (screen directions), converting to the rig's frame in code.

### 2026-10-28 — Muse Spark put stray words inside long JSON replies
- **What happened:** a "rage roar" animation failed twice with "Muse's animation came back unreadable".
- **Evidence (verified, `POST /chat/completions`, `muse-spark-1.3`, ~12,700-character replies, 12–21k completion tokens of which 6–14k reasoning):** both replies were valid JSON except for stray text between values: `…]} credible:1], "drawOrder"…` and `…]} Has mistaken? Actually slot field...], …`. `response_format: {"type": "json_object"}` and `{"type": "json_schema", …}` are both accepted on a small request (returned `{"a": 1}`); whether they prevent this on long replies isn't confirmed yet.
- **Cost:** one failed generation (two Spark calls plus the plan call).
- **Workaround / status:** the keys call now sends `response_format: json_object`, and the parser deletes text from a parse error to the next `,`, `]` or `}` and retries (`parseLooseJson`); both failed replies parse with it.
- **Ask for Meta:** document whether `response_format` constrains decoding on `muse-spark-1.3`, and why reasoning text leaks into the answer.
- **Lesson:** repair-and-retry parsing is cheaper than a second model call.

### 2026-10-28 — Muse Spark's one-shot animations were weak, and it read key eases backwards
- **What happened:** the first version of generated animations asked `muse-spark-1.3` for the keyframes in one call. The user found the results weak: a "jumping slash… make it look epic" and a "one-two punch" on the orc came back small and mushy.
- **Evidence (verified, `POST /chat/completions`, `muse-spark-1.3`, text only; runs in `backend/data/animations/`, local):** replies took 22–45 s. In the jump-slash, about 30 bones were keyed on the same six times (35 distinct key times in total), with a mean rotation of 10° per key against the rig's own Attack swinging the arm through 150°. In the punch, 13 distinct key times. Every curve was smooth. After splitting into a planning call and a keying call with per-key eases: mean rotation 29° and 26°, and 64 and 97 distinct key times. A second problem showed up then: given eases defined as "the move from this key to the next", Spark used `hold` 36 times as if it meant "arrive here and hold", which froze the punch's first 0.4 s.
- **Cost:** five user test runs, about eight Spark calls testing changes in a script, and the user's time.
- **Cause (inferred):** in one call Spark goes straight to the JSON and plays safe (our prompt also told it to keep amplitudes "plausible"). It reads an ease on a key as describing how the motion arrives at that key.
- **Workaround / status:** fixed in `backend/src/lib/animate.ts`: a planning call writes a beat sheet first, eases are defined on arrival (`snap`, `settle`, `smooth`, `linear`; no `hold`), and the prompt asks for bold poses and staggered timing. Checked by drawing the bones at sampled times, not yet with textures in the viewer. Each run now takes 60–116 s.
- **Lesson:** have Spark plan in plain text before it writes structured output, and define every field in the direction the model naturally reads it.

### 2026-10-28 — Muse Code can't be called from the backend
- **What happened:** while planning prompt-generated animations around Muse Code, we found there's no Muse Code model to call.
- **Evidence (verified):** `GET https://api.meta.ai/v1/models` with our key returns `muse-wonder-1.0`, `sam-3.1`, `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1`, `muse-image-1.0` and `muse-voice-transcribe-1.0`. No Muse Code ID.
- **Cost:** a planning detour before any code was written.
- **Cause (inferred):** Muse Code looks like a coding agent for developers, not a model on the API.
- **Workaround / status:** the animation feature will use `muse-spark-1.3` to write keyframes.
- **Ask for Meta:** say in the docs whether Muse Code can be called from an app, and if it can, under which model ID.
- **Lesson:** list `/v1/models` before designing a feature around a model.

### 2026-10-28 — Style changes on "auto" were weak; Spark knew a reference but didn't use it while planning
- **What happened:** "same orc but in an anime art style like black clover style" (`job_5f05df7b`) came back as generic flat cartoon, and "as a watercolor painting" looked like the original with paler colours. Muse Image copies the input's fine texture, and Muse Spark described named references as their genre's generic look.
- **Evidence (verified, 19 `muse-image-1.0` runs plus ~30 `muse-spark-1.3` calls, Orc Berserker, local harness, not stored):**
  - Asked inside the remix plan, Spark described Black Clover as "bold clean black outlines… smooth clean digital finish with no grain", even with the reference named first. Asked about the reference on its own, it answered "thick, rough… dense cross-hatching… harsh, chunky blocks of black".
  - Style descriptions that mention paper, mist or speed lines get painted onto the background: a watercolor run washed every part's box pale cyan, so nothing could be keyed out (`insideBoxes` 0.88, so it passed the layout check). A Black Clover run drew speed lines around the axe.
- **Cost:** 19 test image runs (one of them an accidental duplicate) plus the user's two weak remixes.
- **Workaround / status:** fixed in `backend/src/v2/lib/meta.ts`, `remix.ts` and `textures.ts`.
  - Spark's plan now names the style `reference`.
  - A separate text-only Spark call (`describeStyle`) describes the reference on its own, covering surfaces only: no paper or effects, and in colour unless the medium has none.
  - That description leads the image prompt, which also says the background stays flat.
  - For style changes, Muse Image gets the parts' texture smoothed by a median filter (silhouettes and colours kept), which works as the strength control the API lacks.
  - Results: strong for ukiyo-e, 16-bit pixel art, stained glass, claymation, charcoal, Hollow Knight and Black Clover. Watercolor improved but is still the weakest. Non-style remixes are unchanged (control run: no reference, no smoothing).
- **Ask for Meta:** an edit-strength parameter on `/images/edits`, so we don't have to degrade the input to get a restyle.
- **Lesson:** ask Spark about a reference in isolation. In a planning prompt it describes the contrast with the input, not the reference.

### 2026-10-28 — Muse Image kept the original rendering when asked for a painterly style
- **What happened:** "same orc but give it to me in painterly art style" (`job_72ff8499`, Orc Berserker, style `painterly`, strength 0.6) came back looking like the original: the same crisp dark outlines and fine noisy texture, with only small colour changes (fur, axe grip, tuft) and slight softening. No brush strokes.
- **Evidence (verified, one run):** `POST /images/edits`, `muse-image-1.0`, one 1536×1536 page on cyan. The prompt opened "Paint in loose painterly style with soft broken outlines, thick oil-brush blending…" and ended "keep painterly blending throughout". The rest listed every part's materials as they already were, then our suffix added only `Art style: painterly.` The original is already a detailed hand-painted texture. Output in R2 under `remixes/2026-10-28T12-17-03-853Z_job_72ff8499/`.
- **Cost:** one remix (Spark plan + one image call) that didn't deliver the asked-for style.
- **Cause (inferred):** Muse Image holds on to the input's rendering unless told plainly to replace it, and there's no strength parameter to push it (see Open). A style close to the input's, plus a prompt mostly describing the parts as they are, read as "keep it".
- **Workaround / status:** fixed, tested with 19 image runs across 10 styles (see the 2026-10-28 style-test entry above).
- **Ask for Meta:** an edit-strength or style-strength parameter on `/images/edits`, so a style change doesn't depend on wording.
- **Lesson:** name the rendering to drop, not just the style to add.

### 2026-10-28 — Muse Image drew a repainted head cut off by a straight edge
- **What happened:** a part fix ("give his head some ugly teeth", `job_62c62f80`, Mossy Grove Guardian) came back with the head's right side cut off in a straight vertical line, through the ear, leaves and cheek.
- **Evidence (verified, one run):** `POST /images/edits`, `muse-image-1.0`, 1536×1536, one part (the original skull) centred on cyan. The raw output (`SkeletonWarrior.generated.png`) already has the straight cut, so our steps didn't cause it (the shrink was 0.987). The input has no visible box: every pixel around the part's box is pure cyan, alpha 255. The cut still lies within 6 px of the box's right edge, as the model drew the head larger and further right than the skull. Separately, the head is a mesh weighted to several bones, so it can't be boxed, and 3.2% of the new head falls outside its outline and is hidden in the game. Run in R2 under `remixes/2026-10-28T09-43-30-563Z_job_62c62f80/`.
- **Cost:** one part fix and the user's time.
- **Cause:** not known. Inferred: the model keeps to the original part's frame even when it draws a bigger part.
- **Workaround / status:** partly addressed. Our side now keeps the whole part visible: parts are fitted with a 2% margin inside their box, and inside the mesh outline when the mesh can't be boxed (`shrinkPartsToBoxes`, `uvToPage`). Replaying this run: 0% of the head is hidden by the mesh (was 2.7%), at 79% of its size. The model's own straight cut is still open. Options: ask for every part whole with background all around it, or detect straight cuts and paint again.
- **Lesson:** a part can come back cropped even when the checks pass. Look at the raw output, not only the layout scores.


### 2026-10-28 — Muse Image drew a one-part fix in the middle of the empty square
- **What happened:** a part fix turning the Valkyrie remix's sword into an axe (`job_a502cf78`) failed with "The image model moved the parts out of place twice."
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`, 1536×1536. The only part (a 186×516 sword) was packed at the left of the square, leaving about two thirds of it empty cyan. Attempt 1 drew a good axe in the centre of the image: 21% inside the box. Attempt 2, with the "keep it where it is" note, kept the handle in the box but swung the axe head out to the right: 72%. Run in R2 under `remixes/2026-10-28T09-21-14-603Z_job_a502cf78/`.
- **Cost:** two image calls, one Spark call, and the user's time (failed jobs don't count toward the allowance).
- **Cause:** the same pull toward empty space as the Goblin padding entry, plus a new shape wider than its box. Our check counts any paint outside the box as moved parts.
- **Workaround / status:** part fixes now centre their parts in the square, and judge the result by paint attached to a chosen part (`attachedFit`), not by the box. A part that's too big is shrunk to fit, and the model only paints again if a part would need shrinking below 50%. Replayed offline against this run's saved outputs: both axes now pass (shrunk to 74% and 79%), and the scrambled reference-image run (`job_de86b8ba`) still fails. Not yet checked in a live run.
- **Lesson:** with one or two parts, the model's input is mostly empty space. Put the parts where the model tends to draw, in the middle.


### 2026-10-28 — Muse Spark planned the torso as a helmet, and Muse Image painted a face into it
- **What happened:** a Skeleton Warrior → "female warrior" remix (`job_1a016422`) came out with a second face, wrapped in a scarf, painted into the torso piece. A part fix asking to turn it back into a body (`job_f09c9247`) changed almost nothing.
- **Evidence (verified):** `POST /chat/completions`, `muse-spark-1.3`. On the remix just before (`job_547a07e6`, same rig), Spark's `editPrompt` named the `body` region (a chest piece wrapped in a red scarf) "the cloth-wrapped helm at center". `POST /images/edits`, `muse-image-1.0` then painted a face there. In the part fix, attempt 1 drew a full bust (face plus armoured torso) that grew past the box: `layoutFit` 0.74, rejected. Attempt 2, with the "same size, exactly where it is" retry note, only re-detailed the face. Runs are under `remixes/2026-10-28T09-12-08-725Z_job_f09c9247/` in R2.
- **Cost:** one remix plus one part fix (three image calls, two Spark calls) and the user's time.
- **Cause:** an ambiguous atlas piece; Spark reads it by silhouette, as in the orc jaw entry. In the part fix: the image prompt doesn't say which part is which, Muse Image completes a fragment into a whole object (a bust), and our layout retry pushed it back to the old shape.
- **Workaround / status:** open. Proposed: name each part by its position in the image the model receives, have the layout check ignore paint that's attached to a chosen part, and add a planning rule that torso pieces stay torsos.
- **Lesson:** a part that can be mistaken for a head will be. Say what each part is, in the coordinates of the image the model actually receives.


### 2026-10-28 — Muse Image repainted the reference image instead of the parts to fix
- **What happened:** the first real part fix (Forest Troll Warrior remix: `sward` → an axe, `head` → a troll head) failed with "The image model moved the parts out of place twice."
- **Evidence (verified):** `POST /images/edits`, `muse-image-1.0`, 1536×1536. Image 1 was the two original parts (a sword and a skull) packed on cyan. Image 2 was the remix's other ~25 parts as a style reference, also on cyan. The prompt said image 1 holds the parts to repaint and image 2 only shows the style. Both attempts returned image 2's layout, with every reference part redrawn and a new axe and troll head placed in the reference's top row. Only 53% and 56% of painted pixels fell inside image 1's part boxes (the minimum is 85%). The axe and head themselves looked right. Run in R2 under `remixes/2026-10-28T08-33-26-568Z_job_de86b8ba/`.
- **Cost:** two image calls, one part-fix run, and the user's time.
- **Cause:** with two inputs, Muse Image picked the busier image as the canvas, whatever the prompt said each one was for. The full remix only sends a reference on multi-page rigs, so this hadn't shown up before.
- **Workaround / status:** part fixes now send Muse Image only the parts being fixed (`backend/src/v2/lib/part-fix.ts`). The look came through text instead: at first Muse Spark condensed the remix job's stored `editPrompt` into a style summary. That has since been replaced by `planPartFix`, which sees the packed parts and writes the whole image prompt, ignoring the positions in the stored prompt. Checked once against `muse-spark-1.3` on this run's remix: 5.6 s, a clean two-sentence look with no positions. The next full part fix on the same remix (`remixes/2026-10-28T08-39-43-292Z_job_5b54cf31/`) scored 1.00 inside the boxes on the first attempt.
- **Ask for Meta:** a way to mark which input image is edited and which is reference only, e.g. a separate `reference_images` field on `/images/edits`.
- **Lesson:** don't count on the prompt to say which image is the canvas. Send one image, or make the reference much less like a canvas than the input.


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
- **Node version.** React Router needs Node > 22.22.0; the dev machine's nvm default is 22.20.0. Most frontend commands only warn, but `npm run typecheck` fails outright in `react-router typegen` ("Oops, Node v22.20.0 detected"), which cost a retry on 2026-10-28. Workaround: Homebrew's Node 24 is installed, so run `PATH=/opt/homebrew/bin:$PATH npm run typecheck`, or `nvm install 24` and make it the default. Watch for a quieter failure too: on 2026-10-29 the typegen step bailed on the old Node, and a plain `tsc -b` then passed because the new routes had no generated `+types` yet, so it looked green. After adding a route, check that `.react-router/types/app/routes/+types/<route>.ts` exists. Hit again on 2026-10-30 (home page redesign): an agent ran `npm run typecheck` with the default Node, it failed, and the agent fell back to bare `tsc` before finding this entry. Hit a third time on 2026-11-01 (showcase rework), same fallback, and a fourth on 2026-11-02 (agent names in the remix live view). Read this item first. (2026-10-27)
- **API keys appeared in plain text in chat sessions.** The Meta key and the Cloudflare API token (which the R2 credentials are derived from) are stored in `backend/.env` (gitignored), but rotate both before the repo goes public. The Baseten key (`BASETEN_API_KEY`) was pasted in chat on 2026-10-30 too. Rolling the Cloudflare token changes `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` too. (2026-10-27)

### Log

### 2026-11-01 — Headless Chrome screenshots show Spine players blank
- **What happened:** While checking the showcase rework, headless Chrome screenshots (`--headless=new` with SwiftShader, and playwright-core headless) showed the arena and slideshow stages empty: ground shadows but no characters. It looked like a regression; the original component was blank the same way.
- **Cost:** about five capture runs, plus a revert-and-retest of `ZombieArenaPlayer.tsx` to rule out the change.
- **Cause:** Headless WebGL rarely gets the Spine canvases drawn in time, and offscreen players don't start at all: `SpineRuntime` only takes a live slot while in view, so a full-page screenshot captures stages that never scrolled in.
- **Workaround / status:** Use playwright-core with the system Chrome in headed mode (`chromium.launch({ channel: "chrome", headless: false })`), scroll the section into view, and wait ~8 s before the screenshot. Every player then renders.
- **Lesson:** For anything drawn by `SpineRuntime`, screenshot headed and one section at a time, never one full-page shot.

### 2026-10-31 — Backend broke on a committed migration nobody had applied
- **What happened:** The backend failed with `Database error: column remix_jobs.credits does not exist` after the credits work (`3e008ca feat: credits`) was committed.
- **Cost:** a round-trip with the user, who had to ask for it to be applied.
- **Cause:** `supabase/migrations/20261031000000_remix_job_credits.sql` was in the repo, and the backend code already used the column, but the migration hadn't been run against the Supabase database. The repo has no linked Supabase CLI (`supabase/config.toml`), so nothing applies migrations automatically.
- **Workaround / status:** Applied it, along with `20261031010000_open_asset_categories.sql`, in one transaction through `SUPABASE_DB_URL` (from `backend/.env`) with a throwaway `pg` client outside the repo. Checked that the column and constraint exist, and that the service-role API can select `remix_jobs.credits`.
- **Follow-up:** Installed the Supabase CLI and ran `supabase init`. The database had no `supabase_migrations.schema_migrations`, so a plain `db push` would have re-run `init.sql` against live data. Checked that every migration's tables, columns and constraints exist, then marked all ten as applied with `supabase migration repair`. A dry-run push now reports "up to date". Root scripts `npm run db:push` / `npm run db:migrations` wrap the CLI with `SUPABASE_DB_URL` (see `AGENTS.md`).
- **Lesson:** When a task adds a migration, run `npm run db:push` in the same task, before shipping code that depends on it.

### 2026-10-30 — Part fix drew a sword over neighbours the model couldn't see
- **What happened:** On `ember-fire-knight-7e215105`, "Give him a great sword instead of an axe" (`job_c61a09e7`, region `fuzi`) succeeded, but the sword lost its grip and pommel, and the game showed bits of other parts floating around it.
- **Cause:** The axe's atlas box also holds a kneepad, a chip, a cloth scrap and armour corners. The part fixer erased them to the background colour in the image the models see, so the space looked empty, and Muse Image drew the sword's grip over the kneepad. On save the kneepad's pixels won, and the boxed meshes showed the neighbours.
- **Workaround / status:** The neighbours are now drawn as flat shapes in a second key colour (`pickOffLimits`, the runner-up to the background), and both prompts say to keep new parts off them (`buildPrompt`; Spark rule 8 in `PART_FIX_SYSTEM_PROMPT`). The colour is cleared back to background before the checks (`clearColour`), in `backend/src/{v2,v3}/lib/part-fix.ts`. Checked offline: clearing gives exactly the old input. Not yet tried with a live model run. If Muse Image paints over or restyles the shapes, as it filled the empty canvas in the slime runs, revisit.
- **Follow-up (job_37f11e88, dragon sword):** With the off-limits shapes, Muse Image drew the whole sword around them, but `shrinkPartsToBoxes` then dropped the axe's outline and re-centred the sword in its box, moving it about 65 px onto the kneepad (16.3% of its paint lost). Part fixes with off-limits neighbours now pass `anchor: "part"` (ported to v2), so a part keeps where the model drew it and only moves as far as it must. The outline-dropped branch honours `anchor` too, which also affects the v3 remix. Refitting the same output offline loses 0.8%.
- **Lesson:** Don't hide constraints from the image model: what it can't see, it will draw over. And don't move what the model placed on purpose.

### 2026-10-30 — v3 cut square holes in parts on an atlas with overlapping boxes
- **What happened:** On 20902 Sumuqishi (the only rig whose atlas boxes overlap), the v3 remix (job_7700b27e) came out with rectangular bites out of the visors, helmet and shoulder shell, and a vertical seam through the chest. v2 with the same prompt (job_6b97cb70) was clean.
- **Evidence (verified offline):** the model's square (`round-1/20902_sumuqishi.generated.png`) was whole. Replaying `shrinkPartsToBoxes` on it reproduced the damage exactly; v2's `fitToPage` on the same square didn't.
- **Cost:** a v3 run and its part fixes on that rig, plus the user's time comparing versions.
- **Cause:** two bugs in `shrinkPartsToBoxes` (`backend/src/v3/lib/textures.ts`), both harmless when boxes don't overlap. (1) A shrunk part was pasted back as its whole bounding rectangle, key-colour filler included, so it overwrote any neighbour inside that rectangle. (2) `partOwners` split any blob with over 10% of its pixels in two boxes pixel by pixel, first box winning where they overlap, so the chest (wholly in its own box, half in the axe's) was sliced along the axe box's edge and each half moved on its own.
- **Workaround / status:** fixed. Only a part's own pixels are pasted, all moved parts are lifted out before any is put back, a blob lying (almost) wholly in one box goes to that box whole (the smallest, if several), and overlapping ties go to the nearest box middle. Replay on job_7700b27e's square now matches v2. Not yet run end to end. `backend/test/fit-overlapping-boxes.test.ts` (`npm test`) replays that square through `fitKeyedPage` and fails on the old code.
- **Lesson:** test fitting code on a rig with overlapping atlas boxes; a box-sized rectangle is never safe to paste.

### 2026-10-30 — Cloudflare Workers Build failed: wrangler ran in the monorepo root
- **What happened:** The `rigforge-frontend` Git build ran `npm run build` from the repo root (it built every workspace), and the build never reached a deploy. The pasted dashboard log stopped at "rendering chunks...".
- **Evidence (verified locally):** the root build succeeds. `npx wrangler deploy --dry-run` from the repo root fails with "The Cloudflare application detection logic has been run in the root of a workspace instead of targeting a specific project"; from `frontend/` it succeeds. The full CI log couldn't be fetched: the wrangler OAuth token gets "Authentication error" on the Workers Builds API. That the CI deploy step hit this same error is inferred.
- **Cost:** User time and a failed deploy.
- **Workaround / status:** In the dashboard (Settings → Build), set the deploy command to `cd frontend && npx wrangler deploy` (build `npm run build -w frontend`), or set the root directory to `frontend`.
- **Lesson:** In this monorepo, every wrangler command has to run from `frontend/`.

### 2026-10-28 — Signing in from "Make a copy" landed on raw `.data` output
- **What happened:** A guest clicked "Make a copy", signed in with Google, and was sent to `/assets/<id>.data`, which shows React Router's serialized loader data instead of the page.
- **Cost:** User time.
- **Cause:** React Router form posts go to the route's data URL (`/path.data`, `/_root.data` for `/`). `requireSession` used `request.url` as `?next=`, so the data URL became the post-login destination.
- **Workaround / status:** Fixed in `frontend/app/lib/auth.server.ts`: `requireSession` strips `.data` and `_routes` before building `?next=`. Checked with a guest POST: `next` is now `/assets/<id>`.
- **Lesson:** In an action, `request.url` is the data URL, not the page URL. Normalize it before using it as a link.

### 2026-10-28 — Local Google sign-in landed on rigforge.app instead of localhost
- **What happened:** Signing in with Google on the local dev server sent the user back to `https://rigforge.app` after Google.
- **Cost:** User time, plus a round of debugging.
- **Cause:** The app sends the right `redirect_to` (`http://localhost:5173/auth/callback?next=...`; checked by POSTing to local `/login`), but Supabase ignores any `redirect_to` that isn't on its Redirect URLs allow list and falls back to the project's Site URL (rigforge.app).
- **Workaround / status:** Add `http://localhost:5173/**` under Supabase → Authentication → URL Configuration → Redirect URLs. Keep Site URL as `https://rigforge.app`. Exact entries like `http://localhost:5173/auth/callback` don't work: the callback carries `?next=...`, and Supabase matches the whole URL, query included. Use `/**` (or `/auth/callback**`) for every host.
- **Lesson:** An OAuth redirect to the wrong host with the right `redirect_to` in the request is the Supabase allow list, not app code. Allow-list entries need a `**` wildcard whenever the redirect has a query string.

### 2026-10-28 — Stripe webhook rejected every event: secret retyped with lookalike characters
- **What happened:** The first test checkout on rigforge.app succeeded in Stripe, but the account stayed Free. All 4 webhook deliveries to `https://api.rigforge.app/billing/webhook` failed with 400 "Invalid Stripe signature."
- **Cost:** One failed checkout, plus a round of debugging and a redeploy.
- **Cause:** `STRIPE_WEBHOOK_SECRET` in Render was typed from Stripe's on-screen text and differed from the real secret at two lookalike characters (l/1, 0/o).
- **Workaround / status:** Fixed. Corrected the value in Render, redeployed, and resent the event from Stripe (200, delivered). The account now shows Pro.
- **Lesson:** Copy-paste secrets, never retype them. A 400 "Invalid Stripe signature" on every delivery means a wrong secret, not a code bug.

### 2026-10-28 — Moving the frontend to Cloudflare Workers: three snags
- **What happened:** (1) With `@react-router/node` still installed, React Router picked its Node server entry, which can't run on Workers. (2) Wrangler's generated runtime types redeclare DOM globals such as `Element`, so `tsc` failed on browser code (`document.body.append(host)` in `spine-auto-tweak.ts`). (3) `vite preview` returned 500 on `/` while dev worked.
- **Cost:** Three retries.
- **Cause:** (1) The default entry is chosen by whether `@react-router/node`/`serve`/`express` is a dependency. (2) Worker types and DOM types don't mix in one program. (3) Preview serves the build, whose `vars` (`BACKEND_URL=https://api.rigforge.app`) are fixed at build time, and that host doesn't exist yet. Local `.env` overrides apply only in dev.
- **Workaround / status:** Removed `@react-router/node` and `@react-router/serve`. `frontend/tsconfig.worker.json` typechecks `workers/` with Worker types, and the main tsconfig excludes them. `frontend/.env` sets `BACKEND_URL` and `PUBLIC_SITE_URL` to localhost for dev.
- **Lesson:** To test a production build locally, rebuild with local vars. A 500 in preview may just mean the production backend isn't live.

### 2026-10-28 — tsx scratch scripts fail on top-level await as `.ts`
- **What happened:** A one-off script to test a Muse call (`npx tsx script.ts` outside the backend folder) failed with "Top-level await is currently not supported with the \"cjs\" output format".
- **Cost:** One retry.
- **Cause:** Outside a `"type": "module"` package, tsx compiles a `.ts` file as CommonJS.
- **Workaround / status:** Name scratch scripts `.mts` and pass `--env-file=backend/.env` (from `backend/`: `npx tsx --env-file=.env <script>.mts`).
- **Lesson:** Use `.mts` for throwaway scripts.

### 2026-10-28 — Part fix threw away two good paintings because they didn't fit the old mesh outline
- **What happened:** `job_de04cbc1` ("change the axe into a wrench", `ARM_L2`, steampunk orc) failed with "The image model moved the parts out of place twice", spending two Muse Image calls and the user's remix.
- **Cost:** two image runs (credits) and a used allowance, with nothing to show for it.
- **Cause:** not the model. Both outputs were well placed (`attached` 1.0). `ARM_L2` is a mesh that can't be swapped for a box, so the new art had to fit inside its axe-shaped outline. A wrench can't fit at any size, so the shrink hit its 0.3 floor and was rejected (minimum 0.5). The error message blamed placement.
- **Workaround / status:** fixed. When an outline would shrink a part below 0.5, the part now keeps its size and fits only its atlas region. The game clips it to the old outline until the user grows it (Tweak → Line up parts, or Grow outline), and the run log notes `clippedByOutline` (`backend/src/v2/lib/textures.ts`, `part-fix.ts`). Replaying the saved outputs offline, the first one now passes at 0.886 scale with the whole wrench kept. Still open: the backend could grow the outline in the saved skeleton itself.
- **Lesson:** a check that rejects paid model output should have a fallback that keeps the result. And name the real reason in the error.

### 2026-10-28 — .skel → JSON converter misread deform timelines on the first pass
- **What happened:** the new browser-side converter (`frontend/app/lib/spine-skel-json.ts`), which lets binary `.skel` rigs be tweaked and saved, failed on 7 of the 20 sample rigs in `frontend/public/spine/`. No public converter exists for Spine 4.2 (community tools stop at 2.1 and 3.1; the Spine editor CLI needs a licence), so it mirrors spine-core's `SkeletonBinary`.
- **Cost:** one debugging round.
- **Cause:** in the binary format a deform key's vertices come *after* the curve leading into it, not with its time like every other timeline. A generic key reader got the order wrong and drifted out of step with the bytes. Separately, spine-core's `BinaryInput` reads `data.buffer` from offset 0, so a Node `Buffer` from the shared pool fed it garbage in the test.
- **Workaround / status:** fixed. Deform keys have their own reader. A round-trip test (`.skel` → `SkeletonBinary` vs `.skel` → converter → `SkeletonJson`, deep-compared, curves included) passes on all 20 rigs, as does baking tweaks into each converted rig and reloading it.
- **Lesson:** when mirroring a binary reader, diff the sequence of strings each side reads to find the first divergence. And always hand spine-core a fresh `Uint8Array` copy.

### 2026-10-28 — Couldn't apply or test the asset-copies migration
- **What happened:** Remix copies need two new `assets` columns. The migration was written, but nothing in the dev environment can apply DDL to the hosted Supabase project, so the copy flow and the `?asset=` workspace couldn't be run end to end.
- **Cost:** End-to-end check left to the user; a manual step before deploy.
- **Cause:** Only `SUPABASE_URL` + service-role key are configured (REST only); no Postgres connection string or CLI.
- **Workaround / status:** fixed. `SUPABASE_DB_URL` is now in `backend/.env` and agents apply migrations with a small `pg` script. The dashboard's direct host (`db.<ref>.supabase.co`) is IPv6-only and timed out from the dev machine; the **session pooler** (`postgres.<ref>@aws-0-us-east-1.pooler.supabase.com:5432`) works. Finding the setting also cost the user a detour: the connection string is now under the dashboard's top-bar **Connect** button, not Settings → Database.
- **Lesson:** Check `information_schema` / a `select` of new columns over REST before claiming a schema change is live. Use the pooler URL, not the direct host.

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
