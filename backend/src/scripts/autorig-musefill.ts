// Tries the Muse Image fill of a sliced rig's hidden areas (lib/autorig/muse-fill.ts) on fixture
// images, one Muse Image call each. Per image it writes, to test/output/autorig-fill/: the marked
// sheet sent to Muse, Muse's reply, and a comparison row (atlas with the smear, atlas with Muse's
// fill, and the same stress pose with each).
//
//   npx tsx --env-file=.env src/scripts/autorig-musefill.ts knight-front orc-front …
//
// Joints come from the last preview run (test/output/autorig/<name>/joints.json) when it exists.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { keyCutout } from "../lib/autorig/cutout.js";
import { guessJoints } from "../lib/autorig/joints.js";
import { museFillHidden } from "../lib/autorig/muse-fill.js";
import { renderPoses } from "../lib/autorig/render.js";
import { buildRig } from "../lib/autorig/rig.js";
import type { AutoRigView, Cutout, Joints } from "../lib/autorig/types.js";

const FIXTURES = "test/fixtures/autorig";
const OUT = "test/output/autorig-fill";
const FRAME = 360;
await mkdir(OUT, { recursive: true });

const bend = {
  bones: {
    upper_arm_l: { rotate: [{ time: 0 }, { time: 1, value: 70 }] },
    forearm_l: { rotate: [{ time: 0 }, { time: 1, value: 50 }] },
    upper_arm_r: { rotate: [{ time: 0 }, { time: 1, value: -70 }] },
    forearm_r: { rotate: [{ time: 0 }, { time: 1, value: -50 }] },
    head: { rotate: [{ time: 0 }, { time: 1, value: -15 }] },
    foot_target_l: { translate: [{ time: 0 }, { time: 1, x: 60, y: 60 }] },
  },
};

const rows: Buffer[] = [];
for (const name of process.argv.slice(2)) {
  const view: AutoRigView = name.endsWith("-right") ? "right" : "front";
  const cut = await keyCutout(await readFile(path.join(FIXTURES, `${name}.png`)));
  let joints: Joints;
  try {
    joints = JSON.parse(await readFile(`test/output/autorig/${name}/joints.json`, "utf8")) as Joints;
  } catch {
    joints = guessJoints(cut, view);
  }
  const rig = await buildRig(cut, joints, view);
  const t = Date.now();
  const fill = await museFillHidden(rig.pageImage, rig.regions, rig.hidden, new AbortController().signal);
  const painted = fill.pieces.reduce((s, p) => s + p.painted, 0);
  const total = fill.pieces.reduce((s, p) => s + p.hidden, 0);
  console.log(`${name}: ${Date.now() - t} ms, marker ${fill.marker}, painted ${painted} of ${total} hidden pixels (${Math.round((painted / total) * 100)}%)`);
  for (const p of fill.pieces) console.log(`  ${p.name}: shift ${p.dx},${p.dy} mismatch ${p.mismatch}, painted ${p.painted}/${p.hidden}`);

  await writeFile(path.join(OUT, `${name}-sheet.png`), fill.sheet);
  await writeFile(path.join(OUT, `${name}-reply.webp`), fill.reply);
  const skeleton = { ...rig.skeleton, animations: { ...(rig.skeleton.animations as object), bend } };
  const thumb = (page: Cutout) =>
    sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
      .flatten({ background: "#26282e" })
      .resize(FRAME, FRAME, { fit: "contain", background: "#26282e" })
      .png()
      .toBuffer();
  const pose = (page: Cutout) => renderPoses(skeleton, page, rig.regions, [{ animation: "bend", time: 1 }], FRAME);
  const parts = await Promise.all([thumb(rig.pageImage), thumb(fill.page), pose(rig.pageImage), pose(fill.page)]);
  rows.push(
    await sharp({ create: { width: FRAME * 4, height: FRAME, channels: 3, background: "#26282e" } })
      .composite(parts.map((input, i) => ({ input, left: i * FRAME, top: 0 })))
      .png()
      .toBuffer(),
  );
}
await sharp({ create: { width: FRAME * 4, height: FRAME * rows.length, channels: 3, background: "#26282e" } })
  .composite(rows.map((input, i) => ({ input, left: 0, top: i * FRAME })))
  .png()
  .toFile(path.join(OUT, "compare.png"));
console.log(`Compare: ${path.join(OUT, "compare.png")} (smear atlas, Muse atlas, smear pose, Muse pose)`);
