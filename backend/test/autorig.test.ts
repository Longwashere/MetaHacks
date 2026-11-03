// Auto-rig builder (src/lib/autorig): rigs built from Muse Image's A-pose redraws, sliced into 14
// parts or drawn as one texture, must load in the Spine runtime, weight every vertex fully, cover
// every solid pixel of the character, and draw the art exactly where it was in the setup pose
// (bind coordinates, atlas regions and leg IK agree with the joints). Gear masks (from SAM 3.1 in
// the app) go whole to their part and stay rigid on its bone; a mask nowhere near its part is left.
//
// Run with `npm test -w backend`. `npx tsx src/scripts/autorig-preview.ts` renders every fixture.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as spine from "@esotericsoftware/spine-core";
import { stubLoader } from "../src/lib/animate-fx.js";
import { keyCutout } from "../src/lib/autorig/cutout.js";
import { parseCreateInput } from "../src/lib/autorig/create.js";
import { cleanGear, type GearMask } from "../src/lib/autorig/gear.js";
import { guessJoints } from "../src/lib/autorig/joints.js";
import { buildRig, cutPreview } from "../src/lib/autorig/rig.js";
import { checkJoints } from "../src/lib/autorig/spark-joints.js";
import { PREPARE_FOLDER, RigTrace } from "../src/lib/autorig/trace.js";
import type { AutoRigView, Cutout, Point } from "../src/lib/autorig/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures/autorig");

/** A round mask of radius `r` around `at`, as SAM would return for one piece of gear. */
function disc(cut: Cutout, at: Point, r: number, phrase: string, goesWith: GearMask["goesWith"]): GearMask {
  const mask = new Uint8Array(cut.width * cut.height);
  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) if (Math.hypot(x - at.x, y - at.y) <= r && cut.rgba[(y * cut.width + x) * 4 + 3] >= 128) mask[y * cut.width + x] = 1;
  }
  return { phrase, goesWith, confidence: 0.9, mask };
}

for (const [name, view, slice, withGear, withCape] of [
  ["skeleton-front", "front", true, false, false],
  ["orc-right", "right", true, false, false],
  ["knight-front", "front", true, false, false],
  ["knight-front", "front", true, true, false],
  ["knight-front", "front", true, false, true],
  ["orc-front", "front", false, false, false],
] as [string, AutoRigView, boolean, boolean, boolean][]) {
  test(`auto-rig of ${name} (${slice ? "sliced" : "one texture"}${withGear ? ", with gear" : ""}${withCape ? ", with a cape" : ""}) loads, is fully weighted, covers the art and binds in place`, async () => {
    const cut = await keyCutout(await readFile(path.join(FIXTURES, `${name}.png`)));
    const joints = guessJoints(cut, view);
    // A kneepad across the left knee, and a "foot" piece on the head that must be left alone.
    const padRadius = cut.height * 0.05;
    const gear = withGear ? [disc(cut, joints.knee_l, padRadius, "knee pad", "shin"), disc(cut, joints.head, cut.height * 0.04, "boot", "foot")] : [];
    // A cape hanging beside the left leg: its own piece, behind everything, on three bones.
    const capeAt = { x: 2 * joints.hip_l.x - joints.pelvis.x, y: (joints.pelvis.y + joints.knee_l.y) / 2 };
    if (withCape) gear.push(disc(cut, capeAt, cut.height * 0.1, "cape", "cape"));
    const rig = await buildRig(cut, joints, view, { slice, gear });
    if (withCape) {
      assert.deepEqual(rig.stats.gear.map((g) => [g.phrase, g.part]), [["cape", "cape"]]);
      const skeleton = rig.skeleton as { slots: { name: string }[]; bones: { name: string; parent?: string }[]; animations: { idle: { bones: Record<string, unknown> } } };
      assert.equal(skeleton.slots[0].name, "cape", "the cape is drawn behind everything");
      assert.deepEqual(
        skeleton.bones.filter((b) => b.name.startsWith("cape")).map((b) => [b.name, b.parent]),
        [
          ["cape_1", "chest"],
          ["cape_2", "cape_1"],
          ["cape_3", "cape_2"],
        ],
      );
      assert.ok(skeleton.animations.idle.bones.cape_3, "the idle sways the cape");
    }
    if (withGear) {
      assert.deepEqual(
        rig.stats.gear.map((g) => [g.phrase, g.part]),
        [
          ["knee pad", "shin_l"],
          ["boot", null],
        ],
      );
    }

    const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(rig.skeleton));
    assert.ok(data.findAnimation("idle"), "has an idle animation");
    assert.equal(data.ikConstraints.length, 2);
    const sk = new spine.Skeleton(data);
    sk.setToSetupPose();
    sk.updateWorldTransform(spine.Physics.pose);

    // Spine space: x from the pelvis, y up from the ground line the builder chose.
    const originX = joints.pelvis.x;
    const originY = Math.max(joints.toe_l.y, joints.toe_r.y, joints.ankle_l.y, joints.ankle_r.y);
    const covered = new Uint8Array(cut.width * cut.height);
    let meshes = 0;
    let worstBind = 0;
    for (const slot of sk.drawOrder) {
      const mesh = slot.getAttachment();
      if (!(mesh instanceof spine.MeshAttachment)) continue;
      meshes++;
      // Weights sum to 1 for every vertex. The runtime keeps each vertex's bone count and bone
      // indices in `bones`, and an x, y, weight triple per bone in `vertices`.
      assert.ok(mesh.bones, `${slot.data.name} is weighted`);
      const v = mesh.vertices;
      for (let i = 0, w = 0; i < mesh.bones.length; ) {
        const n = mesh.bones[i++];
        let sum = 0;
        for (let k = 0; k < n; k++, i++, w += 3) sum += v[w + 2];
        assert.ok(Math.abs(sum - 1) < 0.01, `${slot.data.name}: weights sum to ${sum}`);
      }
      // Vertices well inside the kneepad move with the shin alone, so the pad doesn't bend.
      if (withGear && slot.data.name === "shin_l") {
        const shin = data.findBone("shin_l")!.index;
        const region = rig.regions.find((r) => r.name === mesh.path)!;
        let inside = 0;
        for (let i = 0, vi = 0; i < mesh.bones.length; vi++) {
          const n = mesh.bones[i];
          const bones: number[] = mesh.bones.slice(i + 1, i + 1 + n);
          i += n + 1;
          const x: number = region.srcX + mesh.regionUVs[vi * 2] * region.width;
          const y: number = region.srcY + mesh.regionUVs[vi * 2 + 1] * region.height;
          if (Math.hypot(x - joints.knee_l.x, y - joints.knee_l.y) > padRadius * 0.6) continue;
          inside++;
          assert.deepEqual(bones, [shin], `a kneepad vertex at ${Math.round(x)},${Math.round(y)} is weighted to more than the shin`);
        }
        assert.ok(inside > 0, "the kneepad has vertices");
      }
      // The setup pose puts every vertex where its UV says it came from.
      const world = new Float32Array(mesh.worldVerticesLength);
      mesh.computeWorldVertices(slot, 0, mesh.worldVerticesLength, world, 0, 2);
      const region = rig.regions.find((r) => r.name === mesh.path);
      assert.ok(region, `${mesh.path} has an atlas region`);
      // A UV inside the mesh's region, back in cutout pixels.
      const uvs = Array.from(mesh.regionUVs, (v, i) => (i % 2 ? region.srcY + v * region.height : region.srcX + v * region.width));
      for (let i = 0; i < world.length; i += 2) {
        const x = uvs[i] - originX;
        const y = originY - uvs[i + 1];
        worstBind = Math.max(worstBind, Math.hypot(world[i] - x, world[i + 1] - y));
      }
      // Mark the pixels the triangles cover (in image space, from the UVs).
      const t = mesh.triangles;
      for (let k = 0; k < t.length; k += 3) {
        const p = [t[k], t[k + 1], t[k + 2]].map((j) => ({ x: uvs[j * 2], y: uvs[j * 2 + 1] }));
        markTriangle(covered, cut.width, cut.height, p);
      }
    }
    assert.equal(meshes, slice ? (withCape ? 15 : 14) : 6, "one mesh per body part");
    assert.ok(worstBind < 0.5, `setup pose moves a vertex by ${worstBind.toFixed(2)} px`);

    let solid = 0;
    let missed = 0;
    for (let i = 0; i < covered.length; i++) {
      if (cut.rgba[i * 4 + 3] < 128) continue;
      solid++;
      if (!covered[i]) missed++;
    }
    assert.ok(missed / solid < 0.003, `${missed} of ${solid} solid pixels aren't drawn by any mesh`);
  });
}

function markTriangle(out: Uint8Array, width: number, height: number, [a, b, c]: { x: number; y: number }[]) {
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (!area) return;
  for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))); y <= Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))); x <= Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x))); x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
      const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
      if (w0 >= -0.02 && w1 >= -0.02 && 1 - w0 - w1 >= -0.02) out[y * width + x] = 1;
    }
  }
}

// Muse Spark's joints are checked before use (src/lib/autorig/spark-joints.ts): extremities stay
// with the silhouette, mirrored sides are swapped back, and a joint off the body or a limb folded
// back on itself falls back to the silhouette's guess and is flagged.
test("Spark joints: mirrored sides are swapped back, bad joints fall back and are flagged", async () => {
  const cut = await keyCutout(await readFile(path.join(FIXTURES, "skeleton-front.png")));
  const guess = guessJoints(cut, "front");
  const shift = (p: { x: number; y: number }, dx: number) => ({ x: p.x + dx, y: p.y });

  // Every pair mirrored, everything else nudged 3 px: sides come back, nudges are kept.
  const mirrored: Partial<typeof guess> = {};
  for (const [j, p] of Object.entries(guess) as [keyof typeof guess, { x: number; y: number }][]) {
    const other = j.endsWith("_l") ? (j.replace(/_l$/, "_r") as keyof typeof guess) : j.endsWith("_r") ? (j.replace(/_r$/, "_l") as keyof typeof guess) : j;
    mirrored[other] = shift(p, 3);
  }
  const fixed = checkJoints(cut, guess, mirrored);
  assert.deepEqual(fixed.joints.elbow_l, shift(guess.elbow_l, 3));
  assert.deepEqual(fixed.joints.hand_l, guess.hand_l, "extremities stay with the silhouette");

  // A shoulder out in the empty background, and an elbow folded back past the shoulder.
  const bad = { ...guess, shoulder_r: { x: 2, y: 2 }, elbow_l: shift(guess.shoulder_l, -(guess.wrist_l.x - guess.shoulder_l.x)) };
  const checked = checkJoints(cut, guess, bad);
  assert.ok(checked.flagged.includes("shoulder_r"));
  assert.deepEqual(checked.joints.shoulder_r, guess.shoulder_r);
  assert.ok(checked.flagged.includes("elbow_l"));
  assert.deepEqual(checked.joints.elbow_l, guess.elbow_l);
});

// Gear lists come from Spark's reply and back from the page, so they're cleaned before use.
test("gear lists are cleaned: valid parts, plain short phrases, no duplicates or hands, at most 6", () => {
  const gear = cleanGear([
    { phrase: "  Red   Cape ", goesWith: "torso" },
    { phrase: "red cape", goesWith: "torso" },
    { phrase: "hand", goesWith: "hand" },
    { phrase: "knee pad", goesWith: "knee" },
    { phrase: "<script>", goesWith: "head" },
    { phrase: "a".repeat(41), goesWith: "head" },
    { phrase: "plume", goesWith: "head" },
    ...["a", "b", "c", "d", "e", "f"].map((p) => ({ phrase: `pad ${p}`, goesWith: "shin" })),
  ]);
  assert.deepEqual(gear.map((g) => g.phrase), ["red cape", "plume", "pad a", "pad b", "pad c", "pad d"]);
  assert.deepEqual(cleanGear("cape"), []);
});

// Every model call is traced (src/lib/autorig/trace.ts), including ones that throw, so a run can be
// debugged and priced from its prepare.json / autorig.json.
test("rig traces record each call's time, usage and outcome, and failures too", async () => {
  const trace = new RigTrace("create");
  const value = await trace.call("gear", "sam-3.1", "red cape", async (record) => {
    record.usage = { images_processed: 1 };
    record.detail = { matches: 1 };
    return 42;
  });
  assert.equal(value, 42);
  await assert.rejects(trace.call("fill", "muse-image-1.0", undefined, async () => Promise.reject(new Error("503"))), /503/);
  trace.set("build", { ms: 5 });
  const json = trace.toJSON() as { calls: { ok: boolean; error?: string; usage?: unknown; label?: string }[]; byModel: Record<string, { calls: number; failed: number }>; steps: Record<string, unknown> };
  assert.deepEqual(json.calls.map((c) => [c.label, c.ok, c.error]), [
    ["red cape", true, undefined],
    [undefined, false, "503"],
  ]);
  assert.deepEqual(json.calls[0].usage, { images_processed: 1 });
  assert.deepEqual([json.byModel["sam-3.1"].calls, json.byModel["sam-3.1"].failed, json.byModel["muse-image-1.0"].failed], [1, 0, 1]);
  assert.deepEqual(json.steps.build, { ms: 5 });
  assert.ok(PREPARE_FOLDER.test("2026-11-02T21-51-49-211Z_autorig-prep_f3ceacdf"));
  assert.ok(!PREPARE_FOLDER.test("../2026-11-02T21-51-49-211Z_autorig-prep_f3ceacdf"));
});

// Spark once put both hips at knee height on a knight in a cape: every check above passed, and each
// thigh piece pivoted at the knee. Proportion checks lift such hips to the pelvis and flag them.
test("Spark joints: hips at knee height are lifted to the pelvis and flagged; good joints pass", async () => {
  const cut = await keyCutout(await readFile(path.join(FIXTURES, "knight-front.png")));
  const guess = guessJoints(cut, "front");
  assert.deepEqual(checkJoints(cut, guess, guess).flagged.filter((j) => j.startsWith("hip")), []);
  const low = { ...guess, hip_l: { x: guess.hip_l.x, y: guess.knee_l.y - 10 }, hip_r: { x: guess.hip_r.x, y: guess.knee_r.y - 10 } };
  const checked = checkJoints(cut, guess, low);
  assert.ok(checked.flagged.includes("hip_l") && checked.flagged.includes("hip_r"), `flagged ${checked.flagged.join(", ")}`);
  assert.equal(checked.joints.hip_l.y, guess.pelvis.y);
  assert.equal(checked.joints.hip_l.x, guess.hip_l.x);
});

// The joint editor shows where the rig will cut (POST /me/autorig/preview).
test("cut preview is the cutout's size and colours every solid pixel", async () => {
  const cut = await keyCutout(await readFile(path.join(FIXTURES, "orc-front.png")));
  const png = await cutPreview(cut, guessJoints(cut, "front"), "front");
  const { data, info } = await (await import("sharp")).default(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [cut.width, cut.height, 4]);
  let solid = 0;
  let coloured = 0;
  const colours = new Set<string>();
  for (let p = 0; p < cut.width * cut.height; p++) {
    if (cut.rgba[p * 4 + 3] < 250) continue;
    solid++;
    if (data[p * 4 + 3] >= 250) {
      coloured++;
      colours.add(`${data[p * 4]},${data[p * 4 + 1]},${data[p * 4 + 2]}`);
    }
  }
  assert.ok(coloured / solid > 0.995, `${solid - coloured} of ${solid} solid pixels uncoloured`);
  assert.equal(colours.size, 14, "one colour per part");
});

// A limb piece turns about its own joint, so it mustn't reach far behind it (a thigh carrying the
// side of the belt swings it away from the torso).
test("limb pieces stay in front of their own joints", async () => {
  for (const name of ["knight-front", "orc-front", "skeleton-front"]) {
    const cut = await keyCutout(await readFile(path.join(FIXTURES, `${name}.png`)));
    const joints = guessJoints(cut, "front");
    const rig = await buildRig(cut, joints, "front");
    for (const [part, a, b] of [
      ["thigh_l", "hip_l", "knee_l"],
      ["thigh_r", "hip_r", "knee_r"],
      ["upper_arm_l", "shoulder_l", "elbow_l"],
      ["upper_arm_r", "shoulder_r", "elbow_r"],
    ] as const) {
      const r = rig.regions.find((x) => x.name === part)!;
      const [dx, dy] = [joints[b].x - joints[a].x, joints[b].y - joints[a].y];
      const len = Math.hypot(dx, dy);
      let deepest = 0;
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const p = (r.y + y) * rig.pageImage.width + r.x + x;
          if (rig.hidden[p] || rig.pageImage.rgba[p * 4 + 3] < 128) continue;
          deepest = Math.max(deepest, -((r.srcX + x - joints[a].x) * dx + (r.srcY + y - joints[a].y) * dy) / len);
        }
      }
      // The margin (2% of the height) plus a grid cell or two of rounding.
      assert.ok(deepest < cut.height * 0.035, `${name} ${part} reaches ${Math.round(deepest)} px behind its joint`);
    }
  }
});

// Smooth (one image) is the default rig style; parts only when the page asks for them.
test("rig style: smooth unless slice is true", async () => {
  const cut = await keyCutout(await readFile(path.join(FIXTURES, "orc-front.png")));
  const sharp = (await import("sharp")).default;
  const cutout = `data:image/png;base64,${(await sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }).png().toBuffer()).toString("base64")}`;
  const body = { name: "Orc", view: "front", visibility: "private", cutout, joints: guessJoints(cut, "front") };
  const parsed = (extra: object) => {
    const r = parseCreateInput({ ...body, ...extra });
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r.input.slice;
  };
  assert.equal(parsed({}), false);
  assert.equal(parsed({ slice: "yes" }), false);
  assert.equal(parsed({ slice: true }), true);
});
