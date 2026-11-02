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

1. **Upload.** One PNG, JPG or WebP image of up to 8 MB. The user picks a view, **Front** (the default) or **Facing right**, and a name. Only Pro users and admins can use `/autoRig`. Free users see an upgrade card, like `/upload`, and the backend answers `403`.
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
- `_l` and `_r` are the character's own left and right. In both views the character's right (`_r`) is on the left of the image, and in a "Facing right" rig `_r` is the near side.
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

## Slicing (2026-11-02, built: code fill)

Hand-made Spine art is cut into parts with the hidden areas painted in. The auto-rig does the same:

1. **Cut 14 parts** by the body-part map: `head`, `torso`, and `upper_arm`, `forearm`, `hand`, `thigh`, `shin`, `foot` per side. Each is its own atlas region, slot and mesh, named after its bone.
2. **Top and bottom at each joint.** Draw order decides which part is on top at each joint (forearm over upper arm, upper arm over torso, torso over thigh…). The top part is cut exactly on the boundary and its end is weighted toward the bottom part's bone, so it stretches to stay attached when the joint bends. The bottom part is filled in under the top part around the joint, out to about the limb's width, so moving the top part reveals art, not a hole.
3. **Filling:** first in code (colours smeared in from the part's own edge). Then, if a test shows it works, a Muse Image pass that paints the hidden areas properly, with the alignment check from remixes after it.
4. **Packing:** the parts are packed onto one atlas page, so the download looks like a hand-cut Spine project.

Status: built in `rig.ts` (`slicedParts`, the default; `{ slice: false }` gives the one-texture rig) and `slice.ts` (`fillAndPack`). The `/autoRig` page makes sliced rigs. The fill smears colour from each part's solid interior pixels, then blurs it lightly; the setup pose looks the same as the original. A Muse Image fill test painted good detail but redrew the whole sheet and added a second face to the torso (FRICTION_LOG.md, 2026-11-02), so Muse filling would need to keep our pixels, copy Muse's only inside the hidden areas, align each piece, and check for invented content. Not built.

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
| `src/lib/autorig/pose.ts` | Calls Muse Image with the pose prompt (front or facing right), keys the result, pads and trims it, and checks it isn't cut off. |
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
| `POST /me/autorig` | `{ image (data URL), view: "front" \| "right", name, skipPose? }`. With `skipPose`, the image must be a PNG with transparency; it's trimmed and padded, and no model is called. | `201 AutoRigJob`: `posedUrl`, `cutoutUrl`. Synchronous, about 15–35 s. `403` for free users. |
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
| `app/components/AutoRigUpload.tsx` | Drop zone, view choice (Front or Facing right) and name. |
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
