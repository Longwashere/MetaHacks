import sharp from "sharp";
import * as spine from "@esotericsoftware/spine-core";
import { FX_PREFIX, coreBones, stubLoader } from "./animate-fx.js";

// Frames of a generated animation for Muse to look at in the review pass (see reviewAnimation in
// animate.ts). Without the atlas the art can't be drawn, so each attachment is drawn as a filled
// shape: its region quad or its mesh hull, coloured by the limb it hangs from, over a faint
// outline of the rest pose and a ground line. Muse wrote keys blind before this: legs it stretched
// to 150% of their length and bodies it tipped over only showed up once someone watched them.

const FRAMES = 8;
const COLS = 4;
const CELL = 340;
const LEGEND = 44;
/** One hue per limb (a chain hanging off the body); the body itself is grey. */
const PALETTE = [
  "#e4572e", "#17a2b8", "#e6b800", "#5aa02c", "#8e44ad", "#2e86de", "#f39c12", "#d81b60",
  "#16a085", "#7f4f24", "#00e5ff", "#b8e986", "#ff8fab", "#1b3a8a", "#6d6875", "#c6ff00",
];
const BODY = "#8a9099";

type Point = [number, number];
interface Shape {
  points: Point[];
  color: string;
  alpha: number;
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Key times of the animation's bones, thinned to FRAMES, so the hero poses are among the frames. */
function frameTimes(skeleton: Record<string, unknown>, animName: string, duration: number): number[] {
  const times = new Set<number>([0, duration]);
  for (const [bone, timelines] of Object.entries(record(record(record(skeleton.animations)[animName]).bones))) {
    if (bone.startsWith(FX_PREFIX)) continue;
    for (const keys of Object.values(record(timelines))) for (const k of list(keys)) times.add(Math.round(Number(record(k).time ?? 0) * 30) / 30);
  }
  const all = [...times].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  if (all.length <= FRAMES) {
    // Too few keys to show the motion: fill the gaps with evenly spaced times.
    for (let i = 1; all.length < FRAMES && i < FRAMES; i++) all.push(Math.round(((i * duration) / FRAMES) * 30) / 30);
    return [...new Set(all)].sort((a, b) => a - b).slice(0, FRAMES);
  }
  return Array.from({ length: FRAMES }, (_, i) => all[Math.round((i * (all.length - 1)) / (FRAMES - 1))]);
}

/**
 * A JPEG data URL of FRAMES poses of `animName` in a 4 × 2 grid, each labelled with its time, and
 * a legend naming the bone each colour hangs from. Null when the animation or its art is missing.
 */
export async function renderStrip(skeleton: Record<string, unknown>, animName: string): Promise<string | null> {
  const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
  const anim = data.findAnimation(animName);
  if (!anim) return null;
  const sk = new spine.Skeleton(data);
  // Some rigs keep their art in a named skin and leave "default" empty.
  const hasArt = (s: spine.Skin | null) => !!s && s.attachments.some((a) => a && Object.keys(a).length > 0);
  const skin = hasArt(data.defaultSkin) ? null : data.skins.find(hasArt);
  if (skin) {
    sk.setSkin(skin);
    sk.setSlotsToSetupPose();
  }

  // Colour each slot by the limb its bone belongs to: the ancestor that hangs directly off the body.
  const core = new Set(coreBones(skeleton));
  const limbOf = (bone: spine.Bone): string | null => {
    let b: spine.Bone | null = bone;
    while (b && !core.has(b.data.name)) {
      if (!b.parent || core.has(b.parent.data.name)) return b.data.name;
      b = b.parent;
    }
    return null;
  };
  const limbColors = new Map<string, string>();
  const colorOf = (bone: spine.Bone) => {
    const limb = limbOf(bone);
    if (!limb) return BODY;
    if (!limbColors.has(limb)) limbColors.set(limb, PALETTE[limbColors.size % PALETTE.length]);
    return limbColors.get(limb)!;
  };

  const pose = (t: number | null) => {
    sk.setToSetupPose();
    if (skin) sk.setSlotsToSetupPose();
    if (t !== null) anim.apply(sk, 0, t, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    sk.updateWorldTransform(spine.Physics.pose);
  };
  const shapes = (): Shape[] => {
    const out: Shape[] = [];
    for (const slot of sk.drawOrder) {
      const attachment = slot.getAttachment();
      if (!attachment || slot.data.name.startsWith(FX_PREFIX) || slot.color.a < 0.05) continue;
      const bone = slot.bone;
      let points: Point[] = [];
      if (attachment instanceof spine.RegionAttachment) {
        const r = attachment.rotation * (Math.PI / 180);
        const [hw, hh] = [(attachment.width / 2) * attachment.scaleX, (attachment.height / 2) * attachment.scaleY];
        points = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Point[]).map(([x, y]) => {
          const lx = x * Math.cos(r) - y * Math.sin(r) + attachment.x;
          const ly = x * Math.sin(r) + y * Math.cos(r) + attachment.y;
          return [bone.a * lx + bone.b * ly + bone.worldX, bone.c * lx + bone.d * ly + bone.worldY];
        });
      } else if (attachment instanceof spine.MeshAttachment) {
        const verts = new Float32Array(attachment.worldVerticesLength);
        attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, verts, 0, 2);
        const count = (attachment.hullLength || attachment.worldVerticesLength) / 2;
        for (let i = 0; i < count; i++) points.push([verts[i * 2], verts[i * 2 + 1]]);
      }
      if (points.length >= 3 && points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) out.push({ points, color: colorOf(bone), alpha: slot.color.a });
    }
    return out;
  };

  const duration = anim.duration;
  pose(null);
  const rest = shapes();
  if (rest.length === 0) return null;
  const times = frameTimes(skeleton, animName, duration);
  const frames = times.map((t) => {
    pose(t);
    return shapes();
  });

  // One camera for every frame, so travel and size changes show.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of [rest, ...frames].flat()) {
    for (const [x, y] of s.points) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const ground = Math.min(...rest.flatMap((s) => s.points.map((p) => p[1])));
  const scale = Math.min((CELL * 0.9) / Math.max(x1 - x0, 1), (CELL * 0.82) / Math.max(y1 - y0, 1));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const rows = Math.ceil(FRAMES / COLS);
  const width = CELL * COLS;
  const height = CELL * rows + LEGEND;
  const parts: string[] = [`<rect width="${width}" height="${height}" fill="#ffffff"/>`];
  frames.forEach((frame, i) => {
    const ox = (i % COLS) * CELL;
    const oy = Math.floor(i / COLS) * CELL;
    const sx = (x: number) => (ox + CELL / 2 + (x - cx) * scale).toFixed(1);
    const sy = (y: number) => (oy + CELL / 2 + 10 - (y - cy) * scale).toFixed(1);
    const poly = (s: Shape) => s.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ");
    parts.push(`<rect x="${ox + 0.5}" y="${oy + 0.5}" width="${CELL - 1}" height="${CELL - 1}" fill="none" stroke="#d0d4da"/>`);
    parts.push(`<line x1="${ox + 8}" y1="${sy(ground)}" x2="${ox + CELL - 8}" y2="${sy(ground)}" stroke="#555" stroke-width="1.5"/>`);
    for (const s of rest) parts.push(`<polygon points="${poly(s)}" fill="none" stroke="#c4c8ce" stroke-width="1"/>`);
    for (const s of frame) parts.push(`<polygon points="${poly(s)}" fill="${s.color}" fill-opacity="${(0.85 * s.alpha).toFixed(2)}" stroke="#222" stroke-width="0.8"/>`);
    parts.push(`<text x="${ox + 10}" y="${oy + 24}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#111">${i + 1}. ${times[i].toFixed(2)} s</text>`);
  });
  let lx = 10;
  const legend = [["body", BODY], ...limbColors] as [string, string][];
  for (const [name, color] of legend) {
    parts.push(`<rect x="${lx}" y="${height - LEGEND + 12}" width="18" height="18" fill="${color}" stroke="#222"/>`);
    parts.push(`<text x="${lx + 24}" y="${height - LEGEND + 27}" font-family="sans-serif" font-size="15" fill="#111">${esc(name)}</text>`);
    lx += 34 + name.length * 8.5;
    if (lx > width - 60) break;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
