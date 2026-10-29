import type * as spine from "@esotericsoftware/spine-core";
import { type Drawing, type PartCoverage, MASK_STEP } from "./render.js";

// Writes part tweaks (move, scale, turn) into a Spine 4.x skeleton JSON, for the tweak step at the
// end of the v3 loop (remix.ts). The units match auto-tweak and the tweak panel: moves are a share
// of the rig's size in the drawn pose, +y up; rotate is degrees counter-clockwise. This is a small
// server-side cousin of frontend/app/lib/spine-tweak-bake.ts (bakeParts). Meshes are moved in
// world space at the drawn pose; deform keys are offsets, so they keep their size when a mesh is
// scaled.

/** A part's total change from the untweaked remix. */
export interface PartTransform {
  /** Percent of the rig's size, in the drawn pose; +x right, +y up. */
  x: number;
  y: number;
  /** Multiplier; 1 is unchanged. */
  scale: number;
  /** Degrees counter-clockwise. */
  rotate: number;
}

export const IDENTITY: PartTransform = { x: 0, y: 0, scale: 1, rotate: 0 };

/** Why a slot's attachment wasn't (fully) tweaked. */
export interface SkippedTweak {
  slot: string;
  attachment: string;
  reason: "linked mesh" | "no bone" | "bad mesh";
}

interface AttachmentJson {
  type?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  vertices?: number[];
  uvs?: number[];
}
interface SkinJson {
  name: string;
  attachments?: Record<string, Record<string, AttachmentJson>>;
}
interface SlotJson {
  name: string;
  bone: string;
}

/**
 * Returns a copy of `skeletonJson` with `tweaks` (by slot name) applied to every drawable
 * attachment of those slots, in every skin. `posed` is the rig in the pose the tweaks were judged
 * in (see render.ts loadRig), for each bone's world transform; `rigSize` is that pose's longest
 * side in skeleton units (Drawing.rigSize).
 */
export function applyTweaks(
  skeletonJson: unknown,
  tweaks: Record<string, PartTransform>,
  posed: spine.Skeleton,
  rigSize: number,
): { skeleton: unknown; skipped: SkippedTweak[] } {
  const json = structuredClone(skeletonJson) as { slots?: SlotJson[]; skins?: SkinJson[] | Record<string, unknown> };
  const skipped: SkippedTweak[] = [];
  // Spine 4.x stores skins as an array; 3.x as an object, which spine-core 4.2 can't read anyway.
  const skins = Array.isArray(json.skins) ? json.skins : [];
  for (const [slotName, t] of Object.entries(tweaks)) {
    if (t.x === 0 && t.y === 0 && t.scale === 1 && t.rotate === 0) continue;
    const bone = posed.findSlot(slotName)?.bone;
    for (const skin of skins) {
      for (const [name, att] of Object.entries(skin.attachments?.[slotName] ?? {})) {
        const type = att.type ?? "region";
        if (type !== "region" && type !== "mesh" && type !== "linkedmesh") continue;
        if (!bone) {
          skipped.push({ slot: slotName, attachment: name, reason: "no bone" });
          continue;
        }
        // The move in the slot bone's local space: the inverse of its world matrix.
        const det = bone.a * bone.d - bone.b * bone.c;
        if (Math.abs(det) < 1e-9) {
          skipped.push({ slot: slotName, attachment: name, reason: "no bone" });
          continue;
        }
        const wx = (t.x / 100) * rigSize, wy = (t.y / 100) * rigSize;
        const lx = (bone.d * wx - bone.b * wy) / det;
        const ly = (-bone.c * wx + bone.a * wy) / det;
        // A mirrored bone turns the other way.
        const turn = (det < 0 ? -t.rotate : t.rotate);

        if (type === "region") {
          att.x = round((att.x ?? 0) + lx);
          att.y = round((att.y ?? 0) + ly);
          att.scaleX = round((att.scaleX ?? 1) * t.scale);
          att.scaleY = round((att.scaleY ?? 1) * t.scale);
          att.rotation = round((att.rotation ?? 0) + turn);
          continue;
        }
        if (type === "linkedmesh") {
          // It shares its parent mesh's vertices, which this loop moves if the parent is in this slot.
          skipped.push({ slot: slotName, attachment: name, reason: "linked mesh" });
          continue;
        }
        const { vertices, uvs } = att;
        if (!vertices || !uvs || !moveMesh(vertices, uvs.length / 2, bone, posed, t, wx, wy)) {
          skipped.push({ slot: slotName, attachment: name, reason: "bad mesh" });
        }
      }
    }
  }
  return { skeleton: json, skipped };
}

/**
 * Moves, scales and turns a mesh's vertices in place, in world space at the drawn pose: about the
 * middle of its world vertices, then by (wx, wy). Unweighted vertices are in the slot bone's space.
 * A weighted vertex is a weighted sum of one copy per bone; giving each copy the same world move,
 * in its own bone's space, moves the vertex by exactly that, since the weights add up to 1.
 * Returns false when the vertices don't parse.
 */
function moveMesh(vertices: number[], count: number, slotBone: spine.Bone, posed: spine.Skeleton, t: PartTransform, wx: number, wy: number): boolean {
  const weighted = vertices.length !== count * 2;
  // Each vertex's influences: [bone, index of its local x in `vertices`, weight].
  const influences: { bone: spine.Bone; at: number; weight: number }[][] = [];
  if (!weighted) {
    for (let v = 0; v < count; v++) influences.push([{ bone: slotBone, at: v * 2, weight: 1 }]);
  } else {
    for (let i = 0; i < vertices.length && influences.length < count; ) {
      const n = vertices[i++];
      const list: { bone: spine.Bone; at: number; weight: number }[] = [];
      for (let k = 0; k < n; k++, i += 4) {
        const bone = posed.bones[vertices[i]];
        if (!bone || i + 3 >= vertices.length) return false;
        list.push({ bone, at: i + 1, weight: vertices[i + 3] });
      }
      influences.push(list);
    }
    if (influences.length !== count) return false;
  }
  const world = influences.map((list) =>
    list.reduce(
      ([x, y], { bone: b, at, weight }) => [
        x + weight * (b.a * vertices[at] + b.b * vertices[at + 1] + b.worldX),
        y + weight * (b.c * vertices[at] + b.d * vertices[at + 1] + b.worldY),
      ],
      [0, 0],
    ),
  );
  const cx = world.reduce((n, p) => n + p[0], 0) / count;
  const cy = world.reduce((n, p) => n + p[1], 0) / count;
  const r = (t.rotate * Math.PI) / 180;
  const cos = Math.cos(r) * t.scale, sin = Math.sin(r) * t.scale;
  for (const [v, list] of influences.entries()) {
    const [px, py] = world[v];
    const dx = px - cx, dy = py - cy;
    const mx = cx + dx * cos - dy * sin + wx - px;
    const my = cy + dx * sin + dy * cos + wy - py;
    for (const { bone: b, at } of list) {
      const det = b.a * b.d - b.b * b.c;
      if (Math.abs(det) < 1e-9) return false;
      vertices[at] = round(vertices[at] + (b.d * mx - b.b * my) / det);
      vertices[at + 1] = round(vertices[at + 1] + (-b.c * mx + b.a * my) / det);
    }
  }
  return true;
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

// Measured fixes: the original and the untweaked remix are drawn in the same pose and place (see
// render.ts drawRig), so comparing where each part's pixels landed says how far the repaint drifted.

/**
 * How a part's fix was found. "measured": same shape, so its move and scale back to the original
 * are measured exactly. "shrunk": it was shrunk to fit its atlas box, so it's scaled back up by
 * the same factor, keeping its middle where it is. "reshaped": a new shape on purpose (a goblin
 * head for a skull), so nothing can be measured. "aligned": it already matches. "unmeasured":
 * too few pixels to tell.
 */
export type PartStatus = "measured" | "shrunk" | "reshaped" | "aligned" | "unmeasured";

export interface MeasuredPart {
  status: PartStatus;
  /** The fix, as a total tweak, for "measured" and "shrunk" parts. */
  fix: PartTransform | null;
}

/** Fewer covered pixels than this, in either drawing, and a part can't be measured. */
const MIN_MEASURE_PIXELS = 40;
/** Area ratio and bounding-box aspect change within which a part counts as the same shape. */
const SAME_SHAPE_AREA = [0.6, 1.6];
const SAME_SHAPE_ASPECT = 0.2;
/**
 * Smaller fixes than these are noise: the part is "aligned". Keying trims a pixel or two off every
 * repainted part's edge, so remix parts measure a little small: on job_909e5229 nine parts that
 * fit fine all measured scale 1.04–1.09 with moves under 0.4%.
 */
const MIN_FIX_MOVE = 0.5;
const MIN_FIX_SCALE = 0.1;
/** Bounds on a measured fix; a bigger difference is a reshaped part, not drift. */
const MEASURED_LIMITS = { move: 8, scaleMin: 0.8, scaleMax: 1.25 };
/** Most a shrunk part is scaled back up. */
const MAX_UNSHRINK = 1.6;

/**
 * Each drawn slot's fix from comparing `original` and `remix` (both drawn with `measure`, same
 * skeleton and pose). `shrunk` maps slots to the scale they were shrunk by to fit their box.
 */
export function measureFixes(original: Drawing, remix: Drawing, shrunk: Map<string, number>): Map<string, MeasuredPart> {
  const out = new Map<string, MeasuredPart>();
  const pct = (px: number) => Math.round((px / remix.pxPerUnit / remix.rigSize) * 10000) / 100;
  for (const part of remix.parts) {
    if (out.has(part.slot)) continue;
    const o = original.coverage.get(part.slot);
    const r = remix.coverage.get(part.slot);
    const s = shrunk.get(part.slot);
    if (!r || r.count < MIN_MEASURE_PIXELS || (!s && (!o || o.count < MIN_MEASURE_PIXELS))) {
      out.set(part.slot, { status: "unmeasured", fix: null });
      continue;
    }
    // Scaling happens about the attachment's middle (see applyTweaks), so the move makes up for it:
    // the part's covered middle c ends up at target t when move = t - p - k(c - p).
    const moveFor = (k: number, tx: number, ty: number) => ({ x: pct(tx - part.x - k * (r.cx - part.x)), y: -pct(ty - part.y - k * (r.cy - part.y)) });
    if (s) {
      const k = Math.round(Math.min(MAX_UNSHRINK, 1 / s) * 100) / 100;
      out.set(part.slot, { status: "shrunk", fix: { ...moveFor(k, r.cx, r.cy), scale: k, rotate: 0 } });
      continue;
    }
    if (!o || !sameShape(o, r)) {
      out.set(part.slot, { status: "reshaped", fix: null });
      continue;
    }
    const k = Math.round(Math.sqrt(o.count / r.count) * 100) / 100;
    const move = moveFor(k, o.cx, o.cy);
    if (Math.abs(move.x) > MEASURED_LIMITS.move || Math.abs(move.y) > MEASURED_LIMITS.move || k < MEASURED_LIMITS.scaleMin || k > MEASURED_LIMITS.scaleMax) {
      out.set(part.slot, { status: "reshaped", fix: null });
      continue;
    }
    if (Math.hypot(move.x, move.y) < MIN_FIX_MOVE && Math.abs(k - 1) < MIN_FIX_SCALE) {
      out.set(part.slot, { status: "aligned", fix: null });
      continue;
    }
    out.set(part.slot, { status: "measured", fix: { ...move, scale: k, rotate: 0 } });
  }
  return out;
}

function sameShape(a: PartCoverage, b: PartCoverage): boolean {
  const area = a.count / b.count;
  const aspect = (c: PartCoverage) => (c.maxX - c.minX + 1) / (c.maxY - c.minY + 1);
  return area >= SAME_SHAPE_AREA[0] && area <= SAME_SHAPE_AREA[1] && Math.abs(aspect(a) / aspect(b) - 1) <= SAME_SHAPE_ASPECT;
}

/**
 * The damage check: for each of `slots` (the tweaked ones), the neighbours it touched in `before`
 * (the untweaked remix) but no longer touches in `after`. A tweak that pulls a part off its joint
 * shows up here; one that closes a gap or grows a part doesn't. Both drawings need `measure`.
 */
export function lostContacts(before: Drawing, after: Drawing, slots: string[]): Map<string, string[]> {
  const lost = new Map<string, string[]>();
  for (const slot of slots) {
    const was = contacts(before, slot);
    const now = new Set(contacts(after, slot));
    const gone = was.filter((n) => !now.has(n));
    if (gone.length > 0) lost.set(slot, gone);
  }
  return lost;
}

/** Slots whose mask touches `slot`'s, within one mask cell. */
function contacts(d: Drawing, slot: string): string[] {
  const a = d.coverage.get(slot);
  if (!a || a.count === 0) return [];
  const w = Math.ceil(d.width / MASK_STEP), h = Math.ceil(d.height / MASK_STEP);
  const box = (c: PartCoverage) => [Math.floor(c.minX / MASK_STEP), Math.floor(c.minY / MASK_STEP), Math.floor(c.maxX / MASK_STEP), Math.floor(c.maxY / MASK_STEP)];
  const [ax0, ay0, ax1, ay1] = box(a);
  const out: string[] = [];
  for (const [other, b] of d.coverage) {
    if (other === slot || b.count === 0) continue;
    const [bx0, by0, bx1, by1] = box(b);
    if (bx0 > ax1 + 1 || bx1 < ax0 - 1 || by0 > ay1 + 1 || by1 < ay0 - 1) continue;
    let touching = false;
    for (let y = Math.max(ay0, by0 - 1); y <= Math.min(ay1, by1 + 1) && !touching; y++) {
      for (let x = Math.max(ax0, bx0 - 1); x <= Math.min(ax1, bx1 + 1) && !touching; x++) {
        if (!a.mask[y * w + x]) continue;
        for (let dy = -1; dy <= 1 && !touching; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && b.mask[ny * w + nx]) {
              touching = true;
              break;
            }
          }
        }
      }
    }
    if (touching) out.push(other);
  }
  return out;
}
