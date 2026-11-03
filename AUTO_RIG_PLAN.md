# Auto-rig plan

A user uploads one image of a humanoid character and gets a Spine 4.2 rig they can play, animate with Muse Spark and download. It lives at **`/autoRig`**.

Status: plan, not built. Written 2026-11-02; submission is due Wed 2026-11-04, 9:00 PM ET.

## What we tested

Muse Image (`POST /v1/images/edits`, `muse-image-1.0`, 1024×1024) redrew 4 rig renders (an orc, a skeleton warrior, a chibi covered by floating guns, a pixel-art knight behind a lance and shield) in a rig-ready pose on flat magenta. Each call took 13–33 s.

- **Front A-pose:** all 4 usable. The character still looked like itself, props were removed, and hidden bodies were drawn in. The arms came out about 20–30° down instead of the 45° asked for.
- **Facing right (three-quarter):** all 4 turned right, but only about 15–30°, with all four limbs still visible and a wide stance. The arms came out nearly horizontal.
- **Background:** the magenta varies by about 1 level out of 255, and edge pixels that mix magenta and art are about 0.25% of the image, so it keys out cleanly.
- **Framing:** asked for 80% of the height, got 86–94%, and one character touched the side edges. Pad the result in code.
- **Not tested:** photos of real people.

Details are in `FRICTION_LOG.md` (2026-11-02, "Muse Image under-does pose instructions").

## User flow

1. **Upload.** One PNG, JPG or WebP image of up to 8 MB. The user picks a view, **Front** (the default), **Facing right** or **Side** (a strict 90° profile facing right, for side-on games), and a name. Only Pro users and admins can use `/autoRig`. Free users see an upgrade card, like `/upload`, and the backend answers `403`.
2. **Pose.** If the upload is a PNG with a transparent background, the page also offers **Rig my image as-is**, which skips Muse and goes straight to step 3. This works best when the character is already in an A-pose with a gap between each limb and the body. Otherwise Muse Image redraws the character in that pose on magenta (about 15–35 s). The page shows the original next to the redraw, with **Use this**, **Try again** (each try costs credits) and **Start over**.
3. **Joints.** The page shows the redraw with about 17 joints placed automatically. The user drags any that are wrong. A **Mirror** button copies one side's joints to the other for front views.
4. **Rig.** The backend builds the bones and weighted meshes and returns a preview that plays a generated idle animation. **Adjust joints** goes back to step 3 and rebuilds.
5. **Save.** Saving creates a private asset in the user's library (category `character`). It works with the player, Animate (Muse Spark animations), tweaks, versions and download, like any uploaded rig.

## How the rig is built

### Bones (named the same on every rig)

```
root (between the feet, on the ground)
└─ hips
   ├─ spine → chest → neck → head
   │          chest → upper_arm_l → forearm_l → hand_l   (same for _r)
   ├─ thigh_l → shin_l → foot_l                          (same for _r)
foot_target_l, foot_target_r   (children of root; IK targets)
```

- There are two IK constraints, `leg_l` and `leg_r` (thigh to shin, aimed at the foot target), so the feet can stay planted. The arms have no IK, because the animation keys aim them directly.
- `_l` and `_r` are the character's own left and right. In every view the character's right (`_r`) is on the left of the image, and in a "Facing right" or "Side" rig `_r` is the near side. The side pose puts the near arm and leg back (image left) and the far ones forward (image right) so this holds. Untested on Muse Image so far.
- Every bone gets its position and direction from the joints. Image y points down and Spine y points up, so y is flipped and the root sits at the lowest foot.
- Using the same names on every rig means the animation generator's rig description, `clampReach` (which pulls IK feet back into reach) and trails work without changes.

### Art: one texture, one mesh per body part

1. **Cutout.** Key out the magenta, reusing the keying in `textures.ts`, then trim and pad. The result is one atlas page with a single `body` region.
2. **Body-part map.** Label each pixel of the character with its nearest bone, measured as a path through the silhouette rather than a straight line. A straight-line distance would let a leg pick up pixels from the other leg, or an arm from the torso.
3. **One mesh per part:** `head`, `torso`, and an arm and a leg on each side. Each part is a weighted mesh in its own slot, drawn from the same `body` region. Neighbouring parts overlap in a band around each joint and share the same weights there, so the seams can't open.
4. **Triangulation.** Trace the outline, simplify it, and add interior points on a grid, with extra points along the bones near joints so they bend smoothly. Run Delaunay triangulation with the `delaunator` package and drop triangles that fall outside the silhouette.
5. **Weights.** Each vertex takes up to 3 bones, by inverse distance along the silhouette, normalised and blended across joints. The head and hands are kept nearly rigid.
6. **Draw order:** far limbs, then the torso and head, then near limbs. Separate slots mean the existing animation features that change draw order or tint and swap slots also work on these rigs.

Splitting into parts rather than using one mesh lets a limb move in front of the body, which a single mesh can't do.

### Animation and output

- **Idle animation.** A procedural `idle` loop (breathing in the chest, a slight head bob and arm sway) is added so the rig moves as soon as it's built. Spark can generate more from the Animate tab.
- **Files.** The outputs are the skeleton JSON, the `.atlas` and the page `.png`. Before saving, the rig is loaded with `@esotericsoftware/spine-core` to check it, the same way uploads are checked.

## Rig style: smooth by default, parts optional (decided 2026-11-02)

Slicing one drawing gives pieces that are only what was visible: diagonal cuts, stair-stepped edges, and nothing drawn behind them. They hold up for small moves but not for walks, attacks or big arm swings. The one-image rig (`buildRig` with `slice: false`) bends the whole picture with six overlapping weighted meshes on the same bones. It has no seams or fill and makes no model calls, and it looked much better for gentle motion.

So the build step offers both, with **Smooth** as the default:
- **Smooth** builds the one-image rig.
- **Separate parts** is the sliced rig described below, with its cut preview in the joint editor.

Prepare still runs SAM for every pose, so the parts preview is ready if the user switches. A smooth rig doesn't use it (about 2–4 s and 1–2¢ unused). The open idea for better parts is drawing them instead of cutting them: Muse Image draws a parts sheet with each part complete. It's untested.

## Slicing (2026-11-02, built: code fill + Muse fill)

Hand-made Spine art is cut into parts with the hidden areas painted in. The auto-rig does the same:

1. **Cut 14 parts** by the body-part map: `head`, `torso`, and `upper_arm`, `forearm`, `hand`, `thigh`, `shin`, `foot` per side. Each is its own atlas region, slot and mesh, named after its bone.
2. **Top and bottom at each joint.** Draw order decides which part is on top at each joint (forearm over upper arm, upper arm over torso, torso over thigh…). The top part is cut exactly on the boundary and its end is weighted toward the bottom part's bone, so it stretches to stay attached when the joint bends. The bottom part is filled in under the top part around the joint, out to about the limb's width, so moving the top part reveals art, not a hole.
3. **Filling:** first in code (colours smeared in from the part's own edge). Then, if a test shows it works, a Muse Image pass that paints the hidden areas properly, with the alignment check from remixes after it.
4. **Packing:** the parts are packed onto one atlas page, so the download looks like a hand-cut Spine project.

Status: built in `rig.ts` (`slicedParts`, the default; `{ slice: false }` gives the one-texture rig) and `slice.ts` (`fillAndPack`). The `/autoRig` page makes sliced rigs. The fill smears colour from each part's solid interior pixels, then blurs it lightly; the setup pose looks the same as the original. A Muse Image fill test painted good detail but redrew the whole sheet and added a second face to the torso (FRICTION_LOG.md, 2026-11-02), so Muse filling would need to keep our pixels, copy Muse's only inside the hidden areas, align each piece, and check for invented content. Not built.

Muse fill, built (2026-11-02) in `muse-fill.ts` and run by `POST /me/autorig` after slicing: the hidden areas go to Muse Image painted in a flat marker colour the art doesn't use (on magenta), each piece is lined up with Muse's redraw on its own pixels, and a hidden pixel takes Muse's colour only if that colour already occurs in the piece's own art. On three test characters, 91–97% of hidden pixels were painted; the rest, and everything if the call fails, keep the smear. Try it with `npx tsx --env-file=.env src/scripts/autorig-musefill.ts <fixture> …`. Known gap: Muse sometimes paints a head-like shape in the torso's neck area, which only shows if the head turns far.

### Gear masks with SAM 3.1 (built 2026-11-02)

**Problem.** Each pixel goes to the bone nearest it through the body (`nearestBone` in `rig.ts`). That works on bare limbs, but the code doesn't know what clothing is, so gear gets cut wherever the distances fall. On a knight rigged on 2026-11-02:
- The cape was split between the torso, the left thigh and the left hand, so `hand_l` was mostly cape.
- Each shoulder pad went to the upper arm, leaving the torso a narrow strip with straight cuts down both sides.
- Each kneepad was cut in half at the knee.

**Fix.** SAM 3.1 (`sam-3.1` on the Meta Model API; our key lists it) takes a short phrase and returns a pixel-exact mask for every match. Each piece of gear moves to one part as a whole. Cuts along bare limbs stay as they are.

1. **Muse Spark lists the gear in the call it already makes for the joints.** `spark-joints.ts` asks for up to 6 items as `{ phrase, goesWith }`:
   - `phrase` is a short noun phrase, such as "red cape", "shoulder armor" or "knee pad".
   - `goesWith` is a bone type without a side: `head`, `torso`, `upper_arm`, `forearm`, `hand`, `thigh`, `shin` or `foot`.
   - The rules for the prompt:
     - Pads that cross a joint go with the lower part: kneepad with the shin, elbow pad with the forearm.
     - Shoulder pads go with the upper arm.
     - Loose cloth (cape, long skirt, scarf ends) goes with the torso.
     - Headgear goes with the head.

   This adds no extra Spark call. `"hand"` is always added, so the wrist cut follows the cuff.
2. **The SAM calls run during Build rig (`createAutoRig`), before `buildRig`.** There is one call per phrase, and all of them are sent at once.
   - **Why not in prepare:** prepare's wait stays the same, and the page doesn't have to carry masks between calls.
   - **How the list reaches Build rig:** prepare returns the gear list beside the joints, and the page sends it back with Build rig.
   - **Masks dropped before use:** under 0.3% of the figure, over 40% of it (a phrase like "armor" grabbing the whole body), or below SAM's score threshold.
   - **If SAM fails:** the rig is built as it is today.
3. **Slicing uses the masks.** Each mask that's kept is matched to its part:
   - **Side:** decided per match, by which side's bones are nearer, so "knee pad" gives both kneepads.
   - **The rest is unchanged:** the current labels hold everywhere outside the masks. Hidden fill at the joints still comes from the labels, so the seams follow the new outlines on their own.
   - **Weights:** a mask's pixels are weighted fully to its own part's bone, so a pad stays rigid instead of bending at the joint.
4. **Later:** the cape becomes its own `cape` part on a short bone chain off `chest`, so it can sway. That's a separate step.

**Cost.**
- **Calls:** each rig adds 1–6 SAM calls (one phrase each) and no Muse calls.
- **Price:** third-party lists give $2.50 per 1,000 images, so a rig adds at most about 1.5¢. This is unconfirmed against Meta's pricing page.
- **Time:** the calls run at once, so the wait should be about one call. Not measured yet.

**Test first.** Write `src/scripts/autorig-sam.ts` and run it on the knight fixture and the 2026-11-02 knight with fixed phrases. It saves the masks over the image and records:
- the request and response format, which we haven't checked against Meta's docs;
- time and usage per call;
- whether one call can take several phrases.

Build steps 1–3 only if the masks are clean. Log what the test finds in FRICTION_LOG.md.

**Test results (2026-11-02):** `autorig-sam.ts`, output in `test/output/autorig-sam/`. Details are in FRICTION_LOG.md.
- **The call:** `POST /responses` with `model: "sam-3.1"`. Masks are decoded with `@meta-sam/parser`, now a backend dependency.
- **Cost and speed:** each call is billed as 1 image with 0 tokens, so a rig adds about $0.0025 per phrase. Calls take 1.5–3.4 s each, and 5 sent at once finish in 2.3–3.4 s.
- **Several phrases in one call don't work** (0–1 matches), so it's one call per phrase.
- **The 2026-11-02 knight:**
  - Clean masks: cape (with the scarf), both kneepads, both hands (cut at the cuff) and the plume.
  - "Shoulder armor": one pauldron whole, the other only partly.
- **The pixel-art knight fixture:**
  - Clean masks: cape and both hands.
  - "Knee pad" and "helmet plume" found nothing.
  - "Shoulder armor" matched two small gems.
- **Conclusion:** the masks are clean where SAM finds the item, but fixed phrases don't fit every character. Muse Spark has to write the phrases for each character, as step 1 plans. Because a mask can be partial, we keep the confidence floor and the size checks.

**Built (2026-11-02):**
- **SAM calls:** `gear.ts` (`cleanGear`, `gearMasks`, `segment`).
- **Gear list:** Muse Spark returns it in the joints call (`spark-joints.ts`), and its prompt asks for plain words.
- **Slicing:** `applyGear` in `rig.ts` gives each mask's cells to its part; smaller pieces win where masks overlap. Gear vertices are weighted to their own part's bones only.
- **Wiring:** `createAutoRig` runs SAM before `buildRig`, and the page sends `gear` back with Build rig.
- **Matching a side:** a sided piece goes to the side whose bone is nearer. It's skipped if under 15% of it already sits on that part or a part joined to it (`GEAR_MIN_HOME`).
- **Fallback phrase:** a pad phrase that finds nothing is retried once under its plain name ("shoulder pad", "elbow pad", "knee pad"). "Knee armor" had missed both kneepads that "knee pad" found.
- **Test script:** `src/scripts/autorig-gear.ts` runs Spark and SAM and draws the parts with and without gear. Output is in `test/output/autorig-gear/`.
- **Results:**
  - The 2026-11-02 knight: cape, scarf, both pauldrons, both kneepads and both hands kept whole.
  - The pixel-art knight: the cape is whole and the plume stays with the head instead of the arm.
  - The orc: the loincloth is no longer split between the thighs.
- **Known gaps:**
  - The same phrase can match on one run and miss on the next ("plume").
  - Unusual gear (the orc's skull pauldrons) isn't found.
  - Draw order is unchanged, so a thigh still draws over its own shin's kneepad when the knee bends.

**Fixes after the first live build (2026-11-02, from its traces):**
- **The cape's outline went with the limbs.** SAM's masks stop just inside the art's black outline, so the cape's border stayed with the nearest thigh and arm and swung with them as a thin ghost line. Each mask now grows up to 2 cells (`GEAR_GROW`) into cells it partly covers or that lie on the character's outer edge.
- **Hidden fill took the cape's shape.** With the cape in the torso, the thigh's fill under the hip took in cape pixels. Hidden fill now stays within 1.15× the part's own width of its bones (`HIDDEN_WIDTH_SLACK`; the width is the 90th percentile of the part's own non-gear cells). The left thigh's fill fell from 16,456 to 10,334 px.
- **Tried and dropped: filling a limb all along any gear over it.** Gear beside a limb may be behind it (this cape flows behind the arm), and the picture doesn't say which, so the arm got a cape-shaped fill.

### Tracing (built 2026-11-02)

Every auto-rig request saves a trace (`trace.ts`, `RigTrace`) to storage, even when it fails, so a run can be debugged and priced afterwards. The server logs alone vanish when the terminal scrolls.

- **Prepare** saves to `remixes/<time>_autorig-prep_<id>/`:
  - `prepare.json`: the input, the cutout size, and the Muse Image and Muse Spark calls (time, `usage`, prompt or raw reply, attempts, errors). It also records the joints, flagged joints and gear list.
  - `pose.webp`: Muse's redraw.

  Its folder name goes back to the page as `traceId`.
- **Build rig** saves `autorig.json` beside the rig. It records:
  - the joints and gear it was given, and a link to the prepare trace;
  - every SAM call: phrase, time, usage, and the matches' boxes and confidences;
  - which masks were kept or dropped, and where each piece went;
  - the build time, the Muse fill call and its result;
  - the asset id, or the error.
- **Each trace sums the time and calls per model** (`byModel`). That's the data for setting the Pro price.
- **No user data:** traces hold no user ids or emails, because storage is public like the rig files.

### Tears at the joints (planned 2026-11-02, not built)

On the 22:14 knight build (`remixes/2026-11-02T22-14-28-052Z_autorig_46fb1707/`, three-quarter view), posing it showed three kinds of tear:
- **Smear streaks.** These were most visible at the neck and shoulders.
- **Straight, stair-stepped cut edges.** These showed when an arm lifted or a leg stepped.
- **Torn far limbs.** The far arm and leg tore where they come out from behind the torso.

The trace explains the streaks. Muse painted only 39% of the hidden areas. The torso, with 22.6k of the 60k hidden pixels, got nothing, because Muse redrew it too differently to line up (`mismatch` 125, limit 90). So its smear stayed.

**Bad joints cause most of the tearing (checked after the first write-up).** Rebuilding that run from its traces and measuring each piece against its pivot showed this:
- **Hips placed at knee height.** Muse Spark put both hips almost at knee height. In its grid: pelvis at y 683, hips at 748, knees at 790.
- **Thighs mostly above their pivot:** 87–91% of each thigh piece sat above its hip pivot, so stepping swings the whole upper leg around a point at the knee.
- **Proportions far off the other runs:** the thighs came out at 0.32–0.47× the shin length, with the hips 67 px below the pelvis. Every other run and test character falls between 0.6 and 2.1×, with the hips within 37 px of the pelvis.
- **The checks don't catch it:** `checkJoints` only catches joints off the body and limbs folded back. So these hips passed, weren't outlined, and the user didn't move them.
- **Upper arms:** 31–40% of each upper arm sits behind its shoulder pivot. That's mostly the pauldrons, by the gear rule.

So joints come first:

0a. ✅ (built 2026-11-02) **Proportion checks in `checkJoints`.**
   - Rules: a thigh at least 0.55× its shin (`MIN_THIGH_TO_SHIN`); an upper arm between 0.5× and 2× its forearm; the hips within about a third of a thigh's length of the pelvis height.
   - On failure: move the hip up to pelvis height (keeping Spark's x), or fall back to the silhouette's guess. Flag the joint so the page outlines it.
0b. ✅ (built 2026-11-02: `cutPreview` in `rig.ts`, `POST /me/autorig/preview`, the `overlay` on `JointEditor`. Prepare returns the first preview and saves `cutout.png` to its trace folder, so previews work after a restart) **Show the cuts while joints are checked.** The joint editor would colour the parts, as in the debug pictures, and update as joints are dragged, so a bad hip is obvious before Build rig. A fast preview call would return the part map from the cutout and joints (slicing alone takes under a second).

0c. ✅ (built 2026-11-02) **A pivot rule for limbs.** `labelParts` in `rig.ts` gives limb cells more than 2% of the character's height behind their own joint to the parent part (`PIVOT_MARGIN_SHARE`). This covers upper arm → torso, forearm → upper arm, thigh → torso and shin → thigh. Hands and feet are left alone, because heels sit behind the ankle. Gear is exempt. On the 22:31 knight, the thighs went from 54% to 25–27% behind their hips: the belt and pouch now stay with the torso.

0d. ✅ (built 2026-11-02) **The cape is its own piece.**
- **Spark** marks capes and cloaks `goesWith: "cape"`.
- **The piece:** a 15th piece drawn behind everything. Its hidden fill reaches a little under the body (`CAPE_HIDDEN_SHARE`).
- **Bones:** `capeChain` lays three bones (`cape_1`–`cape_3`) from the cape's point nearest the neck to its far tip. They hang from `chest`, and the idle sways them.
- **Duplicate masks:** a body-part mask that's more than 80% inside the cape is dropped as the same cloth. On the 22:31 knight, SAM returned the same mask for "red cape" and "red scarf".
- **SAM timing:** SAM now runs in prepare, and its masks are saved with the pose (`gear.json` and `gear.png`), so the cut preview shows the gear and the build reuses it.

Then the fill and edges:

1. **Measure tears first.** A script poses each rig in a fixed set of stress poses: arms up, arms down, a step, a head turn. For each part it counts:
   - visible hidden fill that Muse didn't paint (smear);
   - holes: background showing inside the posed figure.

   It runs on the fixtures, and on any real build replayed from its traces (`pose.webp` plus `autorig.json`). That gives one number to compare each change against, instead of judging screenshots.
2. **Retry failed pieces alone.** When a piece fails alignment, it goes back to Muse Image on its own, cropped and enlarged, in one more call. Only the failed pieces are sent, and only when some fail (about 20 s more). Alignment also tries a small range of scales, not just shifts.
3. **Round joint caps.** At each joint, the piece underneath gets a disc of hidden fill around the joint, with a radius of the limb's half-width there. The disc may go past the original outline. Muse paints it like the other hidden areas. A bend then reveals a rounded end, as in hand-cut Spine art, not a straight cut or a gap.
4. **Smoother cut edges.** Cuts follow the 300-cell grid, so the seams step in 3–4 px stairs. Two options:
   - cut on a finer grid near the joints;
   - feather the top piece's cut edge with about 2 px of alpha.
5. **Default to the front view.** In the three-quarter view, the torso hides the far arm and leg, and most of this run's big tears are on that side. Default the view toggle to **Front**, and say that it rigs more cleanly.

## Finding the joints

Status (2026-11-02): built as below in `joints.ts` (silhouette) and `spark-joints.ts` (Spark, `checkJoints`), and used by `/autoRig`. On the 8 test images Spark took 15–33 s and about 2.5–3.8k tokens per call (`reasoning_effort: "low"`, `muse-spark-1.3-contributor`), no joint failed the checks, and it fixed the cases the silhouette got wrong: the knight's shoulder pulled into its plume, and hips placed too low and too wide under belts and armour. If the Spark call fails, the silhouette's guess is used and every inner joint is outlined for the user.

The pose step leaves the character in a clean pose with a gap at every joint, so:

- **From the silhouette, in code:** the top of the head, the hands (the farthest points out on each side), the feet (the lowest points on each side) and the crotch (the top of the gap between the legs).
- **Muse Spark (vision):** the neck, shoulders, elbows, hips and knees, returned as image coordinates in JSON.
- **Checks:** every joint is moved inside the silhouette, and limb proportions are checked. A joint that fails is placed from the silhouette and outlined for the user to fix.

The first build step tests this on the 8 test images. If Spark's points are poor, we place everything from the silhouette and rely on the drag editor. MediaPipe is the backup option; it's trained on photos, so it isn't the first choice for drawn characters.

## Where the code goes

### Backend (`backend/`)

| File | What it does |
| --- | --- |
| `src/lib/autorig/pose.ts` | Calls Muse Image with the pose prompt (front, facing right or side), keys the result, pads and trims it, and checks it isn't cut off. |
| `src/lib/autorig/joints.ts` | Places joints from the silhouette, calls Spark for the rest, and runs the checks. |
| `src/lib/autorig/mesh.ts` | Builds the body-part map, outlines, triangles and weights. |
| `src/lib/autorig/skeleton.ts` | Writes the Spine 4.2 JSON (bones, IK, slots, weighted meshes, the idle animation) and the `.atlas`. |
| `src/lib/autorig/jobs.ts` | Handles `autorig_jobs` rows, credit metering and storage paths (`autorig/<id>/source.png`, `posed.png`, `cutout.png`). |
| `src/routes/me.ts` | Adds the endpoints below. |
| `test/autorig.test.ts` + `test/fixtures/autorig/` | Builds rigs from the 8 test images and checks they load in the runtime, have weights that sum to 1, and have no triangles outside the silhouette. |

New dependency: `delaunator` (`-w backend`).

**Endpoints** (all require sign-in):

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /me/autorig` | `{ image (data URL), view: "front" \| "right" \| "side", name, skipPose? }`. With `skipPose`, the image must be a PNG with transparency; it's trimmed and padded, and no model is called. | `201 AutoRigJob`: `posedUrl`, `cutoutUrl`. Synchronous, about 15–35 s. `403` for free users. |
| `POST /me/autorig/:id/pose` | `{}` | The same job with a new pose (Try again). |
| `POST /me/autorig/:id/joints` | `{}` | `{ joints: Record<JointName, {x, y}>, flagged: JointName[] }` |
| `POST /me/autorig/:id/rig` | `{ joints, name, visibility }` | `201 SpineAsset` (files under `remixes/<time>_autorig_<id>/`, fingerprinted like uploads). Calling it again with new joints rebuilds and replaces the job's asset. |

**Migration:** `supabase/migrations/<ts>_autorig_jobs.sql` creates the `autorig_jobs` table: id, user_id, status, view, source/posed/cutout paths, joints, asset_id, cost_usd, credits, and timestamps, with row-level security like `animation_jobs`. Apply it with `npm run db:push` in the same task.

**Metering (no charge yet):** each Muse Image and Spark call is recorded with `recordUsage` and priced at `MUSE_RATES`. The job row keeps the call count, the token counts per model and `cost_usd`, but the user is charged **0 credits** for now. Once test runs show what a rig really costs, we'll set the price and charge like animation jobs (a minimum, failed calls free). While doing this, fix `recordUsage` to read Muse Image's `input_tokens` / `output_tokens` (it reads only the chat field names today, so image calls are stored as 0).

### Frontend (`frontend/`)

| File | What it does |
| --- | --- |
| `app/routes.ts` | Adds `route("autoRig", "routes/auto-rig.tsx")` and `route("api/autorig", "routes/api.autorig.ts")`. |
| `app/routes/auto-rig.tsx` | The page: signed-in only, with a `meta` export. The step and job id live in the URL (`?job=…&step=joints`). Its action handles the intents `pose`, `retry`, `joints` and `rig`. |
| `app/routes/api.autorig.ts` | A resource route that streams the image upload to the backend, like `api.upload.ts`. |
| `app/components/AutoRigUpload.tsx` | Drop zone, view choice (Front, Facing right or Side) and name. |
| `app/components/PoseReview.tsx` | The original and the redraw side by side, with Use this, Try again and Start over. |
| `app/components/JointEditor.tsx` | An SVG layer over the image with draggable joints (pointer events, works with touch), a bone overlay, flagged joints outlined, and Mirror. |
| `app/lib/api.server.ts`, `app/lib/types.ts` | `createAutoRig`, `retryAutoRigPose`, `detectAutoRigJoints` and `buildAutoRig`; the `AutoRigJob` and `JointName` types. |
| `app/components/SiteHeader.tsx` | Adds an "Auto-rig" link. |
| `frontend/BACKEND.md` | Adds an **Auto-rig** section with the endpoints. |

The rig preview reuses `SpineRuntime` / `AssetPlayer`.

## Build order

1. **Rig builder alone.** ✅ Done 2026-11-02: `backend/src/lib/autorig/` (`cutout.ts`, `joints.ts`, `rig.ts`, `render.ts`), the preview script `src/scripts/autorig-preview.ts` and `test/autorig.test.ts`. About 250 ms per rig. Joints from the silhouette alone are good on the skeleton, orc and chibi; the knight's plume pulls one shoulder off, which is step 2's job. Take a cutout and joints placed by hand, then `mesh.ts` + `skeleton.ts` produce a rig to load in the player. This is the riskiest part, so it goes first. Done when the 8 test images play idle without tearing.
(2026-11-02) Steps 3 and 4 were done before step 2, so the page could be tried: `POST /me/autorig/prepare` and `POST /me/autorig` (`lib/autorig/pose.ts`, `create.ts`), and `/autoRig` with `JointEditor`, linked in the header. They're simpler than planned: no `autorig_jobs` table or metering yet (the page holds the cutout between calls, and Muse Image usage is only logged), no rig preview before saving, and no Mirror button.

2. ✅ **Joint detection** on the 8 test images, to choose between Spark and the silhouette as described above.
3. **Backend endpoints**, the migration, metering and storage.
4. **The `/autoRig` page:** upload, pose review, joint editor, preview, save.
5. **Make sure Animate works on an auto-rig.** Generate a walk and an attack on two characters and fix what the animation prompts assume about the rig.
6. **Polish:** header link, empty and error states, BACKEND.md, friction log entries.

If time runs out, steps 1, 3 and 4 with joints placed only from the silhouette and the drag editor are enough for the demo.

## Open decisions

Decided (2026-11-02):
- **Access:** Pro users and admins only.
- **Price:** not charged yet. Costs are recorded per job, and the price is set after test runs.
- **Rigging the original image:** allowed when the upload is a PNG with a transparent background (**Rig my image as-is**).

Still open:
- **Default visibility:** private like uploads, with a public option at save time.
