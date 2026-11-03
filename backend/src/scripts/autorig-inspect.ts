// Inspects a saved auto-rig from its traces (lib/autorig/trace.ts), to see why it tears. It prints
// the run's model calls, joints, gear and fill, and how far each limb piece reaches back past its
// pivot (a piece mostly behind its pivot swings around the wrong point and tears). It writes
// test/output/autorig-inspect/<folder>.png: the saved rig in test poses (top row), the rig rebuilt
// with the current code in the same poses (second row, smear fill, no Muse), and the rebuilt pieces
// in their own colours with the joints, beside the saved atlas.
//
//   npx tsx --env-file=.env src/scripts/autorig-inspect.ts [rig folder, e.g. 2026-11-02T22-31-55-804Z_autorig_9990deef]
//
// Without a folder it takes the newest rig. The rig is rebuilt from the saved cutout, joints and gear
// masks; a pose saved before the masks were runs SAM again (a few cents). NO_SAM=1 skips the gear;
// CAPE=1 makes capes their own piece on runs from before Spark marked them.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { keyCutout } from "../lib/autorig/cutout.js";
import { gearMasks, loadGearMasks, type GearItem, type GearMask } from "../lib/autorig/gear.js";
import { renderPoses } from "../lib/autorig/render.js";
import { buildRig } from "../lib/autorig/rig.js";
import type { PackedRegion } from "../lib/autorig/slice.js";
import type { AutoRigView, Cutout, JointName, Joints } from "../lib/autorig/types.js";
import { getFile, listR2 } from "../lib/storage.js";

const OUT = "test/output/autorig-inspect";
const FRAME = 420;
type Json = Record<string, unknown>;

const folder = process.argv[2] ?? (await listR2("remixes/2", "/")).filter((k) => /_autorig_[0-9a-f]{8}\/$/.test(k)).sort().at(-1)!.replace(/^remixes\/|\/$/g, "");
const json = async (dir: string, name: string) => JSON.parse((await getFile(dir, name)).toString("utf8")) as Json;
const create = await json(folder, "autorig.json");
const steps = create.steps as Json;
const input = steps.input as { view: AutoRigView; joints: Joints; gear: GearItem[]; prepareTrace: string | null };
const prepFolder = input.prepareTrace?.replace(/^remixes\/|\/prepare\.json$/g, "") ?? null;
const prepare = prepFolder ? await json(prepFolder, "prepare.json").catch(() => null) : null;

console.log(`${folder}: ${create.totalMs} ms, outcome ${JSON.stringify(steps.outcome)}`);
for (const trace of [prepare, create]) {
  for (const c of ((trace?.calls ?? []) as Json[])) console.log(`  ${c.step} ${c.model}${c.label ? ` "${c.label}"` : ""}: ${c.ms} ms ${c.ok ? "ok" : `FAILED ${c.error}`}`);
}
const prepOutcome = (prepare?.steps as Json | undefined)?.outcome as { joints?: Joints; flagged?: string[] } | undefined;
if (prepOutcome?.joints) {
  const moved = (Object.keys(input.joints) as JointName[]).filter((j) => Math.hypot(input.joints[j].x - prepOutcome.joints![j].x, input.joints[j].y - prepOutcome.joints![j].y) > 1);
  console.log(`  joints flagged by the checks: ${prepOutcome.flagged?.join(", ") || "none"}; moved by the user: ${moved.join(", ") || "none"}`);
}
console.log(`  gear: ${((steps.build as Json)?.gear as Json[] | undefined)?.map((g) => `${g.phrase} → ${g.part ?? "skipped"}`).join(", ") || "none"}`);
const fill = steps.fill as { painted?: number; hidden?: number; error?: string; pieces?: Json[] } | undefined;
if (fill?.pieces) {
  console.log(`  Muse fill: painted ${fill.painted} of ${fill.hidden} hidden px (${Math.round(((fill.painted ?? 0) / Math.max(1, fill.hidden ?? 1)) * 100)}%)`);
  for (const p of fill.pieces) if ((p.painted as number) < 0.5 * (p.hidden as number)) console.log(`    ${p.name}: painted ${p.painted} of ${p.hidden}${(p.mismatch as number) > 90 ? ` (skipped: Muse's redraw didn't line up, mismatch ${p.mismatch})` : ""}`);
} else if (fill?.error) console.log(`  Muse fill failed: ${fill.error}`);

// The saved rig, posed.
const files = (await listR2(`remixes/${folder}/`)).map((k) => k.split("/").at(-1)!);
const skeletonName = files.find((f) => f.endsWith(".json") && f !== "autorig.json")!;
const skeleton = await json(folder, skeletonName);
const atlas = (await getFile(folder, skeletonName.replace(/\.json$/, ".atlas"))).toString("utf8");
const pageImg = await sharp(await getFile(folder, "body.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const page: Cutout = { width: pageImg.info.width, height: pageImg.info.height, rgba: pageImg.data };
const regions: PackedRegion[] = [...atlas.matchAll(/^(\w+)\nbounds: (\d+), (\d+), (\d+), (\d+)/gm)].map((m) => ({ name: m[1], x: +m[2], y: +m[3], width: +m[4], height: +m[5], srcX: 0, srcY: 0 }));
const turn = (v: number) => [{ time: 0, value: v }];
const poses: Record<string, Json> = {
  "arms up": { bones: { upper_arm_l: { rotate: turn(60) }, forearm_l: { rotate: turn(50) }, upper_arm_r: { rotate: turn(-60) }, forearm_r: { rotate: turn(-50) } } },
  "arms down": { bones: { upper_arm_l: { rotate: turn(-35) }, forearm_l: { rotate: turn(-30) }, upper_arm_r: { rotate: turn(35) }, forearm_r: { rotate: turn(30) } } },
  step: { bones: { foot_target_l: { translate: [{ time: 0, x: 70, y: 90 }] }, foot_target_r: { translate: [{ time: 0, x: -60, y: 0 }] }, hips: { rotate: turn(-8) } } },
  "head turn": { bones: { head: { rotate: turn(-20) }, chest: { rotate: turn(10) } } },
};
const posed = { ...skeleton, animations: { ...(skeleton.animations as Json), ...poses } };
const shots = await Promise.all([null, ...Object.keys(poses)].map((a) => renderPoses(posed, page, regions, [{ animation: a, time: 0 }], FRAME)));

// The pieces, rebuilt from the saved cutout (or Muse's redraw) and the joints used.
let cut: Cutout;
const cutoutPng = prepFolder ? await getFile(prepFolder, "cutout.png").catch(() => null) : null;
if (cutoutPng) {
  const { data, info } = await sharp(cutoutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  cut = { width: info.width, height: info.height, rgba: data };
} else {
  cut = await keyCutout(await sharp(await getFile(prepFolder!, "pose.webp")).resize(1024, 1024, { fit: "inside" }).png().toBuffer());
}
const saved = prepFolder ? await loadGearMasks((name) => getFile(prepFolder, name)).catch(() => null) : null;
let gear: GearMask[] = process.env.NO_SAM ? [] : (saved ?? (await gearMasks(cut, input.gear, new AbortController().signal)));
// CAPE=1 makes capes and cloaks their own piece, for runs from before Spark marked them so.
if (process.env.CAPE) gear = gear.map((g) => (/cape|cloak/.test(g.phrase) ? { ...g, goesWith: "cape" } : g));
const rig = await buildRig(cut, input.joints, input.view, { gear });
console.log(`  rebuilt: ${rig.stats.parts.length} pieces; gear ${rig.stats.gear.map((g) => `${g.phrase} → ${g.part ?? "skipped"}`).join(", ") || "none"}`);
const rebuilt = { ...rig.skeleton, animations: { ...(rig.skeleton.animations as Json), ...poses } };
const rebuiltShots = await Promise.all([null, ...Object.keys(poses)].map((a) => renderPoses(rebuilt, rig.pageImage, rig.regions, [{ animation: a, time: 0 }], FRAME)));
const COLOURS: Record<string, [number, number, number]> = { cape: [146, 64, 14], head: [235, 235, 235], torso: [140, 140, 150], upper_arm_l: [34, 197, 94], forearm_l: [45, 212, 191], hand_l: [163, 230, 53], thigh_l: [59, 130, 246], shin_l: [34, 211, 238], foot_l: [139, 92, 246], upper_arm_r: [249, 115, 22], forearm_r: [239, 68, 68], hand_r: [250, 204, 21], thigh_r: [236, 72, 153], shin_r: [244, 114, 182], foot_r: [190, 18, 60] };
const owner = new Int16Array(cut.width * cut.height).fill(-1);
const tinted = Buffer.alloc(cut.width * cut.height * 4);
rig.regions.forEach((r, ri) => {
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const p = (r.y + y) * rig.pageImage.width + r.x + x;
      const [cx, cy] = [r.srcX + x, r.srcY + y];
      if (rig.hidden[p] || rig.pageImage.rgba[p * 4 + 3] < 128 || cx >= cut.width || cy >= cut.height) continue;
      const o = cy * cut.width + cx;
      owner[o] = ri;
      for (let k = 0; k < 3; k++) tinted[o * 4 + k] = Math.round(cut.rgba[o * 4 + k] * 0.3 + COLOURS[r.name][k] * 0.7);
      tinted[o * 4 + 3] = 255;
    }
  }
});
console.log("  piece          share behind its pivot (a limb piece should be near 0%; pauldrons on upper arms add some)");
const chains: [string, JointName, JointName][] = [["head", "neck", "head"]];
for (const s of ["l", "r"] as const) {
  chains.push([`upper_arm_${s}`, `shoulder_${s}`, `elbow_${s}`], [`forearm_${s}`, `elbow_${s}`, `wrist_${s}`], [`thigh_${s}`, `hip_${s}`, `knee_${s}`], [`shin_${s}`, `knee_${s}`, `ankle_${s}`]);
}
const j = input.joints;
for (const [name, a, b] of chains) {
  const ri = rig.regions.findIndex((r) => r.name === name);
  const [dx, dy] = [j[b].x - j[a].x, j[b].y - j[a].y];
  const len = Math.hypot(dx, dy);
  let [n, behind] = [0, 0];
  for (let p = 0; p < owner.length; p++) {
    if (owner[p] !== ri) continue;
    n++;
    if (((p % cut.width) - j[a].x) * dx + (Math.floor(p / cut.width) - j[a].y) * dy < 0) behind++;
  }
  console.log(`  ${name.padEnd(13)} ${String(Math.round((behind / Math.max(1, n)) * 100)).padStart(3)}%  (bone ${Math.round(len)} px)`);
}
const dots = Object.entries(j).map(([k, p]) => `<circle cx="${p.x}" cy="${p.y}" r="7" fill="${k.endsWith("_l") ? "#22c55e" : k.endsWith("_r") ? "#f97316" : "#38bdf8"}" stroke="black" stroke-width="3"/>`);
const pieces = await sharp(tinted, { raw: { width: cut.width, height: cut.height, channels: 4 } })
  .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cut.width}" height="${cut.height}">${dots.join("")}</svg>`) }])
  .flatten({ background: "#26282e" })
  .png()
  .toBuffer();
const piecesThumb = await sharp(pieces).resize(FRAME * 2, FRAME * 2, { fit: "contain", background: "#26282e" }).png().toBuffer();
const atlasThumb = await sharp(await getFile(folder, "body.png")).resize(FRAME * 2, FRAME * 2, { fit: "contain", background: "#26282e" }).png().toBuffer();

await mkdir(OUT, { recursive: true });
const out = path.join(OUT, `${folder}.png`);
await sharp({ create: { width: FRAME * 5, height: FRAME * 4, channels: 3, background: "#26282e" } })
  .composite([
    ...shots.map((input, i) => ({ input, left: i * FRAME, top: 0 })),
    ...rebuiltShots.map((input, i) => ({ input, left: i * FRAME, top: FRAME })),
    { input: piecesThumb, left: 0, top: FRAME * 2 },
    { input: atlasThumb, left: FRAME * 2 + FRAME / 2, top: FRAME * 2 },
  ])
  .png()
  .toFile(out);
console.log(`  wrote ${out} (rows: saved rig posed; rebuilt rig posed; rebuilt pieces with joints, saved atlas)`);
