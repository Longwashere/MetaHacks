// Tries gear-aware slicing (AUTO_RIG_PLAN.md, "Gear masks with SAM 3.1") on fixture images: Muse
// Spark places the joints and lists the gear (one call), SAM 3.1 masks it (one call per phrase),
// and the rig is sliced with and without the masks. Per image it writes, to
// test/output/autorig-gear/: the rest pose with each part in its own colour, without gear masks on
// the left and with them on the right. No Muse Image fill, so it's cheap.
//
//   npx tsx --env-file=.env src/scripts/autorig-gear.ts knight-front orc-front some/cutout.png …
//
// A name that isn't a fixture is read as a PNG with a transparent background.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { alphaCutout, keyCutout } from "../lib/autorig/cutout.js";
import { gearMasks } from "../lib/autorig/gear.js";
import { guessJoints } from "../lib/autorig/joints.js";
import { renderPoses } from "../lib/autorig/render.js";
import { buildRig, type BuiltRig } from "../lib/autorig/rig.js";
import { sparkJoints } from "../lib/autorig/spark-joints.js";
import type { AutoRigView, Cutout } from "../lib/autorig/types.js";

const FIXTURES = "test/fixtures/autorig";
const OUT = "test/output/autorig-gear";
const FRAME = 520;
const COLOURS: Record<string, [number, number, number]> = {
  head: [255, 255, 255],
  torso: [120, 120, 120],
  upper_arm_l: [0, 200, 0],
  forearm_l: [0, 255, 160],
  hand_l: [160, 255, 0],
  upper_arm_r: [255, 140, 0],
  forearm_r: [255, 60, 0],
  hand_r: [255, 220, 0],
  thigh_l: [0, 120, 255],
  shin_l: [0, 220, 255],
  foot_l: [120, 0, 255],
  thigh_r: [255, 0, 120],
  shin_r: [255, 120, 200],
  foot_r: [180, 0, 60],
};
await mkdir(OUT, { recursive: true });
const signal = new AbortController().signal;

/** The rest pose with every part tinted its own colour. */
function tinted(rig: BuiltRig): Promise<Buffer> {
  const { width, height, rgba } = rig.pageImage;
  const page = Buffer.from(rgba);
  for (const r of rig.regions) {
    const c = COLOURS[r.name] ?? [0, 0, 0];
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const o = (y * width + x) * 4;
        for (let k = 0; k < 3; k++) page[o + k] = Math.round(page[o + k] * 0.35 + c[k] * 0.65);
      }
    }
  }
  return renderPoses(rig.skeleton, { width, height, rgba: page }, rig.regions, [{ animation: null, time: 0 }], FRAME);
}

for (const name of process.argv.slice(2)) {
  const label = path.basename(name, ".png");
  const view: AutoRigView = label.endsWith("-right") ? "right" : label.endsWith("-side") ? "side" : "front";
  const fixture = await readFile(path.join(FIXTURES, `${name}.png`)).catch(() => null);
  const cut: Cutout = fixture ? await keyCutout(fixture) : await alphaCutout(await readFile(name));

  let t = Date.now();
  const spark = await sparkJoints(cut, view, guessJoints(cut, view), signal);
  console.log(`${label}: Spark ${Date.now() - t} ms, gear ${JSON.stringify(spark.gear)}`);
  t = Date.now();
  const gear = await gearMasks(cut, spark.gear, signal);
  console.log(`  SAM ${Date.now() - t} ms, ${gear.length} masks kept`);

  const before = await buildRig(cut, spark.joints, view);
  const after = await buildRig(cut, spark.joints, view, { gear });
  for (const g of after.stats.gear) console.log(`  ${g.phrase} → ${g.part ?? "skipped"}${g.part ? ` (${g.cells} cells)` : ""}`);
  const [a, b] = await Promise.all([tinted(before), tinted(after)]);
  await sharp({ create: { width: FRAME * 2, height: FRAME, channels: 3, background: "#26282e" } })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: b, left: FRAME, top: 0 },
    ])
    .png()
    .toFile(path.join(OUT, `${label}.png`));
  await writeFile(path.join(OUT, `${label}-gear.json`), JSON.stringify({ gear: spark.gear, joints: spark.joints }, null, 1));
  console.log(`  wrote ${path.join(OUT, `${label}.png`)} (left: by distance, right: with gear)`);
}
