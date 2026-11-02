// Builds auto-rigs from images of characters on magenta and writes, per image: the rig files
// (skeleton JSON, atlas, page), the joints drawn on the cutout, the atlas page, and frames of the
// rest pose, the idle and two stress poses. A sheet of every rig goes to <out>/sheet.png. Rigs are
// sliced into parts; set NO_SLICE=1 for one-texture rigs. With SPARK=1 (and the backend .env loaded,
// `npx tsx --env-file=.env …`), Muse Spark places the inner joints.
//
//   npx tsx src/scripts/autorig-preview.ts [images dir] [out dir]
//
// Defaults: test/fixtures/autorig → test/output/autorig. Joints come from guessJoints unless
// <images dir>/joints.json has hand-placed ones for that image (keyed by file name, no extension).
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { keyCutout } from "../lib/autorig/cutout.js";
import { guessJoints } from "../lib/autorig/joints.js";
import { sparkJoints } from "../lib/autorig/spark-joints.js";
import { renderJoints, renderPoses } from "../lib/autorig/render.js";
import { buildRig } from "../lib/autorig/rig.js";
import type { AutoRigView, Joints } from "../lib/autorig/types.js";

const dir = process.argv[2] ?? "test/fixtures/autorig";
const out = process.argv[3] ?? "test/output/autorig";
const FRAME = 300;

let overrides: Record<string, Joints> = {};
try {
  overrides = JSON.parse(await readFile(path.join(dir, "joints.json"), "utf8")) as Record<string, Joints>;
} catch {
  // No hand-placed joints.
}

const rows: Buffer[] = [];
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".png")).sort()) {
  const name = file.replace(/\.png$/, "");
  const view: AutoRigView = name.endsWith("-right") ? "right" : "front";
  const started = Date.now();
  const cut = await keyCutout(await readFile(path.join(dir, file)));
  let joints = overrides[name] ?? guessJoints(cut, view);
  if (process.env.SPARK && !overrides[name]) {
    // Muse Spark places the inner joints (one call per image; needs META_API_KEY).
    const t = Date.now();
    const spark = await sparkJoints(cut, view, joints, new AbortController().signal);
    joints = spark.joints;
    console.log(`${name}: Spark joints in ${Date.now() - t} ms; flagged ${spark.flagged.join(", ") || "none"}. ${spark.notes}`);
  }
  const rig = await buildRig(cut, joints, view, { slice: !process.env.NO_SLICE });
  const built = Date.now() - started;

  const skeleton = { ...rig.skeleton, animations: { ...(rig.skeleton.animations as object), test: stressAnimation(cut.height) } };
  const target = path.join(out, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, `${name}.json`), JSON.stringify(rig.skeleton));
  await writeFile(path.join(target, `${name}.atlas`), rig.atlas);
  await writeFile(path.join(target, "body.png"), rig.page);
  const pageThumb = await sharp(rig.page).resize(FRAME, FRAME, { fit: "contain", background: "#26282e" }).png().toBuffer();
  await writeFile(path.join(target, "joints.json"), JSON.stringify(joints, null, 1));

  const overlay = await sharp(await renderJoints(cut, joints)).resize(FRAME, FRAME, { fit: "contain", background: "#26282e" }).png().toBuffer();
  const frames = await renderPoses(
    skeleton,
    rig.pageImage,
    rig.regions,
    [
      { animation: null, time: 0 },
      { animation: "idle", time: 1.2 },
      { animation: "test", time: 1 },
      { animation: "test", time: 2 },
    ],
    FRAME,
  );
  await writeFile(path.join(target, "joints.png"), overlay);
  await writeFile(path.join(target, "frames.png"), frames);
  rows.push(
    await sharp({ create: { width: FRAME * 6, height: FRAME, channels: 3, background: "#26282e" } })
      .composite([{ input: overlay, left: 0, top: 0 }, { input: pageThumb, left: FRAME, top: 0 }, { input: frames, left: FRAME * 2, top: 0 }])
      .png()
      .toBuffer(),
  );
  const parts = rig.stats.parts.map((p) => `${p.name} ${p.vertices}v/${p.triangles}t`).join(", ");
  console.log(`${name}: ${cut.width}x${cut.height}, built in ${built} ms; ${parts}`);
}

await sharp({ create: { width: FRAME * 6, height: FRAME * rows.length, channels: 3, background: "#26282e" } })
  .composite(rows.map((input, i) => ({ input, left: 0, top: i * FRAME })))
  .png()
  .toFile(path.join(out, "sheet.png"));
console.log(`Sheet: ${path.join(out, "sheet.png")}`);

/** Two exaggerated poses (at 1 s and 2 s) that bend every joint, to show tearing and bad weights. */
function stressAnimation(height: number) {
  const r = (a: number, b: number) => ({ rotate: [{ time: 0 }, { time: 1, value: a }, { time: 2, value: b }] });
  const step = height * 0.1;
  return {
    bones: {
      upper_arm_l: r(70, -45),
      forearm_l: r(50, -60),
      upper_arm_r: r(45, -70),
      forearm_r: r(60, -50),
      chest: r(8, -8),
      head: r(-12, 12),
      hips: { translate: [{ time: 0 }, { time: 1, y: -height * 0.04 }, { time: 2, y: -height * 0.04 }] },
      foot_target_l: { translate: [{ time: 0 }, { time: 1, x: step, y: step }, { time: 2 }] },
      foot_target_r: { translate: [{ time: 0 }, { time: 1 }, { time: 2, x: -step, y: step }] },
    },
  };
}
