import * as spine from "@esotericsoftware/spine-core";
import sharp from "sharp";
import { stubLoader } from "../animate-fx.js";
import type { PackedRegion } from "./slice.js";
import type { Cutout, Joints, Point } from "./types.js";

// Draws an auto-rig with its texture, posed by any of its animations, without a browser: each
// mesh's triangles are posed by the Spine runtime and filled by sampling its region of the page. Used to check
// rigs (tests, the preview script) and for thumbnails.

type Json = Record<string, unknown>;

export interface PoseRequest {
  animation: string | null;
  time: number;
}

const BACKGROUND = [38, 40, 46];

/** Renders each pose into a square frame, side by side, at one shared scale. Returns a PNG. */
export async function renderPoses(skeleton: Json, page: Cutout, regions: PackedRegion[], poses: PoseRequest[], frame = 360): Promise<Buffer> {
  const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
  const sk = new spine.Skeleton(data);

  const posed = poses.map(({ animation, time }) => {
    sk.setToSetupPose();
    if (animation) {
      const anim = data.findAnimation(animation);
      if (!anim) throw new Error(`No animation ${animation}`);
      anim.apply(sk, 0, time, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    }
    sk.updateWorldTransform(spine.Physics.pose);
    const meshes: { world: Float32Array; uvs: ArrayLike<number>; triangles: ArrayLike<number>; region: PackedRegion }[] = [];
    for (const slot of sk.drawOrder) {
      const a = slot.getAttachment();
      if (!(a instanceof spine.MeshAttachment)) continue;
      const world = new Float32Array(a.worldVerticesLength);
      a.computeWorldVertices(slot, 0, a.worldVerticesLength, world, 0, 2);
      const region = regions.find((r) => r.name === a.path);
      if (region) meshes.push({ world, uvs: a.regionUVs, triangles: a.triangles, region });
    }
    return meshes;
  });

  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const meshes of posed) {
    for (const { world } of meshes) {
      for (let i = 0; i < world.length; i += 2) {
        x0 = Math.min(x0, world[i]);
        x1 = Math.max(x1, world[i]);
        y0 = Math.min(y0, world[i + 1]);
        y1 = Math.max(y1, world[i + 1]);
      }
    }
  }
  const scale = (frame * 0.9) / Math.max(x1 - x0, y1 - y0, 1);
  const out = new Float32Array(frame * poses.length * frame * 3);
  const stride = frame * poses.length;
  for (let i = 0; i < out.length; i += 3) out.set(BACKGROUND, i);

  posed.forEach((meshes, f) => {
    const toScreen = (x: number, y: number): Point => ({
      x: f * frame + frame / 2 + (x - (x0 + x1) / 2) * scale,
      y: frame / 2 - (y - (y0 + y1) / 2) * scale,
    });
    for (const { world, uvs, triangles, region } of meshes) {
      for (let t = 0; t < triangles.length; t += 3) {
        const idx = [triangles[t], triangles[t + 1], triangles[t + 2]];
        const p = idx.map((i) => toScreen(world[i * 2], world[i * 2 + 1]));
        const uv = idx.map((i) => ({ x: region.x + uvs[i * 2] * region.width, y: region.y + uvs[i * 2 + 1] * region.height }));
        fillTriangle(out, stride, frame * poses.length, frame, p, uv, page, f * frame, (f + 1) * frame);
      }
    }
  });

  const bytes = Buffer.alloc(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = Math.min(Math.max(Math.round(out[i]), 0), 255);
  return sharp(bytes, { raw: { width: stride, height: frame, channels: 3 } }).png().toBuffer();
}

function fillTriangle(out: Float32Array, stride: number, width: number, height: number, p: Point[], uv: Point[], cut: Cutout, clipX0: number, clipX1: number) {
  const [a, b, c] = p;
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(area) < 1e-6) return;
  const minX = Math.max(Math.floor(Math.min(a.x, b.x, c.x)), clipX0, 0);
  const maxX = Math.min(Math.ceil(Math.max(a.x, b.x, c.x)), clipX1 - 1, width - 1);
  const minY = Math.max(Math.floor(Math.min(a.y, b.y, c.y)), 0);
  const maxY = Math.min(Math.ceil(Math.max(a.y, b.y, c.y)), height - 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
      const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const [r, g, bl, al] = sample(cut, w0 * uv[0].x + w1 * uv[1].x + w2 * uv[2].x, w0 * uv[0].y + w1 * uv[1].y + w2 * uv[2].y);
      if (al <= 0) continue;
      const o = (y * stride + x) * 3;
      out[o] = r + out[o] * (1 - al);
      out[o + 1] = g + out[o + 1] * (1 - al);
      out[o + 2] = bl + out[o + 2] * (1 - al);
    }
  }
}

/** Bilinear sample, premultiplied: [r·a, g·a, b·a, a] with a in 0–1. */
function sample(cut: Cutout, u: number, v: number): [number, number, number, number] {
  const x = Math.min(Math.max(u - 0.5, 0), cut.width - 1);
  const y = Math.min(Math.max(v - 0.5, 0), cut.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, cut.width - 1);
  const y1 = Math.min(y0 + 1, cut.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const acc = [0, 0, 0, 0];
  for (const [px, py, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ]) {
    const i = (py * cut.width + px) * 4;
    const a = (cut.rgba[i + 3] / 255) * w;
    acc[0] += cut.rgba[i] * a;
    acc[1] += cut.rgba[i + 1] * a;
    acc[2] += cut.rgba[i + 2] * a;
    acc[3] += a;
  }
  return [acc[0], acc[1], acc[2], acc[3]];
}

const OVERLAY_LINKS: [keyof Joints, keyof Joints][] = [
  ["head", "neck"],
  ["neck", "pelvis"],
  ["neck", "shoulder_l"],
  ["neck", "shoulder_r"],
  ["shoulder_l", "elbow_l"],
  ["elbow_l", "wrist_l"],
  ["wrist_l", "hand_l"],
  ["shoulder_r", "elbow_r"],
  ["elbow_r", "wrist_r"],
  ["wrist_r", "hand_r"],
  ["pelvis", "hip_l"],
  ["pelvis", "hip_r"],
  ["hip_l", "knee_l"],
  ["knee_l", "ankle_l"],
  ["ankle_l", "toe_l"],
  ["hip_r", "knee_r"],
  ["knee_r", "ankle_r"],
  ["ankle_r", "toe_r"],
];

/** The cutout with its joints drawn on it (left side green, right side orange), as PNG. */
export async function renderJoints(cut: Cutout, joints: Joints): Promise<Buffer> {
  const r = Math.max(3, cut.height / 150);
  const colour = (name: string) => (name.endsWith("_l") ? "#3ddc84" : name.endsWith("_r") ? "#ff9f43" : "#4cc9f0");
  const lines = OVERLAY_LINKS.map(([a, b]) => `<line x1="${joints[a].x}" y1="${joints[a].y}" x2="${joints[b].x}" y2="${joints[b].y}" stroke="${colour(b)}" stroke-width="${r * 0.6}"/>`);
  const dots = Object.entries(joints).map(([n, p]) => `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${colour(n)}" stroke="black" stroke-width="${r * 0.3}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cut.width}" height="${cut.height}">${lines.join("")}${dots.join("")}</svg>`;
  return sharp({ create: { width: cut.width, height: cut.height, channels: 4, background: { r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2], alpha: 1 } } })
    .composite([{ input: cut.rgba, raw: { width: cut.width, height: cut.height, channels: 4 } }, { input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
