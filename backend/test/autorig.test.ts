// Auto-rig builder (src/lib/autorig): rigs built from Muse Image's A-pose redraws must load in the
// Spine runtime, weight every vertex fully, cover every solid pixel of the character, and draw the
// art exactly where it was in the setup pose (bind coordinates and leg IK agree with the joints).
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
import { guessJoints } from "../src/lib/autorig/joints.js";
import { buildRig } from "../src/lib/autorig/rig.js";
import type { AutoRigView } from "../src/lib/autorig/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures/autorig");

for (const [name, view] of [
  ["skeleton-front", "front"],
  ["orc-right", "right"],
  ["knight-front", "front"],
] as [string, AutoRigView][]) {
  test(`auto-rig of ${name} loads, is fully weighted, covers the art and binds in place`, async () => {
    const cut = await keyCutout(await readFile(path.join(FIXTURES, `${name}.png`)));
    const joints = guessJoints(cut, view);
    const rig = await buildRig(cut, joints, view);

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
      // The setup pose puts every vertex where its UV says it came from.
      const world = new Float32Array(mesh.worldVerticesLength);
      mesh.computeWorldVertices(slot, 0, mesh.worldVerticesLength, world, 0, 2);
      const uvs = mesh.regionUVs;
      for (let i = 0; i < world.length; i += 2) {
        const x = uvs[i] * cut.width - originX;
        const y = originY - uvs[i + 1] * cut.height;
        worstBind = Math.max(worstBind, Math.hypot(world[i] - x, world[i + 1] - y));
      }
      // Mark the pixels the triangles cover (in image space, from the UVs).
      const t = mesh.triangles;
      for (let k = 0; k < t.length; k += 3) {
        const p = [t[k], t[k + 1], t[k + 2]].map((j) => ({ x: uvs[j * 2] * cut.width, y: uvs[j * 2 + 1] * cut.height }));
        markTriangle(covered, cut.width, cut.height, p);
      }
    }
    assert.equal(meshes, 6, "one mesh per body part");
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
