// Writes SpineTweaks into a Spine 4.2 skeleton JSON, so a saved remix downloads with them.
// Mirrors what TweakController does at runtime; keep the two in step.
//
// Not saved (preview only): crossfade, reverse, hold frame, layered animation,
// pixel-crisp filtering and debug overlays.

import { growOutline, QUAD_EDGES, QUAD_TRIANGLES, QUAD_UVS, quadFromMesh } from "~/lib/spine-mesh";
import { PHYSICS_FORCE_SCALE, type SpineTweaks, type TweakBlendMode } from "~/lib/spine-tweaks";

/** The rig's setup pose with the current tweaks applied, read from the live runtime. */
export interface SetupPose {
  /** Largest side of the rig's bounds; part offsets and physics forces are relative to it. */
  rigSize: number;
  /** World transform of each bone, in skeleton order (the order of `bones` in the JSON). */
  bones: BoneWorld[];
}

export interface BoneWorld {
  name: string;
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

export interface BakedSkeleton {
  skeleton: SkeletonJson;
  /** Skin the asset should show, or null to keep its current one. */
  skin: string | null;
}

// The parts of the Spine 4.2 JSON format the bake reads and writes.
interface BoneJson {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}
interface SlotJson {
  name: string;
  bone: string;
  color?: string;
  dark?: string;
  blend?: string;
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
  triangles?: number[];
  hull?: number;
  edges?: number[];
  /** A linked mesh's parent attachment. */
  parent?: string;
}
type SkinAttachments = Record<string, Record<string, AttachmentJson>>;
interface SkinJson {
  name: string;
  attachments?: SkinAttachments;
  bones?: string[];
  ik?: string[];
  transform?: string[];
  path?: string[];
  physics?: string[];
}
interface ColorKey {
  color?: string;
  light?: string;
  dark?: string;
  value?: number;
}
interface SlotTimelines {
  rgba?: ColorKey[];
  rgb?: ColorKey[];
  alpha?: ColorKey[];
  rgba2?: ColorKey[];
  rgb2?: ColorKey[];
}
interface DeformKey {
  offset?: number;
  vertices?: number[];
}
type AttachmentTimelines = Record<string, Record<string, Record<string, { deform?: DeformKey[] }>>>;
interface AnimationJson {
  slots?: Record<string, SlotTimelines>;
  attachments?: AttachmentTimelines;
}
interface IkJson {
  mix?: number;
  bendPositive?: boolean;
}
interface TransformJson {
  mixRotate?: number;
  mixX?: number;
  mixY?: number;
  mixScaleX?: number;
  mixScaleY?: number;
  mixShearY?: number;
}
interface PhysicsJson {
  mix?: number;
  wind?: number;
  gravity?: number;
  strength?: number;
}
export interface SkeletonJson {
  skeleton: Record<string, unknown>;
  bones: BoneJson[];
  slots?: SlotJson[];
  skins?: SkinJson[];
  ik?: IkJson[];
  transform?: TransformJson[];
  physics?: PhysicsJson[];
  animations?: Record<string, AnimationJson>;
}

const DRAWABLE = new Set(["region", "mesh", "linkedmesh"]);

/** True when the tweaks change anything the bake writes. */
export function hasSavableTweaks(t: SpineTweaks) {
  return (
    t.tint.toLowerCase() !== "#ffffff" ||
    t.alpha !== 1 ||
    t.shadow !== null ||
    t.blend !== "rig" ||
    t.flipX ||
    t.scaleX !== 1 ||
    t.scaleY !== 1 ||
    t.skins !== null ||
    t.physicsMix !== 1 ||
    t.wind !== 0 ||
    t.gravity !== 0 ||
    t.stiffness !== 1 ||
    t.ikMix !== 1 ||
    t.ikFlip ||
    t.transformMix !== 1 ||
    Object.keys(t.parts).length > 0 ||
    Object.keys(t.bones).length > 0
  );
}

/** Returns a copy of `raw` with the tweaks written in. Throws if it isn't a Spine skeleton JSON. */
export function bakeTweaks(raw: unknown, tweaks: SpineTweaks, pose: SetupPose): BakedSkeleton {
  if (!isSkeletonJson(raw)) throw new Error("This rig's skeleton isn't a Spine JSON file.");
  const json = structuredClone(raw);
  const skin = combineSkins(json, tweaks.skins);
  bakeBones(json, tweaks);
  bakeConstraints(json, tweaks, pose.rigSize);
  bakeParts(json, tweaks, pose);
  bakeSlotLook(json, tweaks);
  return { skeleton: json, skin };
}

function isSkeletonJson(value: unknown): value is SkeletonJson {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.skeleton === "object" && v.skeleton !== null && Array.isArray(v.bones) && v.bones.length > 0;
}

/** One skin: show it. Several: add a skin that merges them, as `Skin.addSkin` does at runtime. */
function combineSkins(json: SkeletonJson, names: string[] | null): string | null {
  if (!names || names.length === 0) return null;
  const skins = json.skins ?? [];
  const sources = names.map((n) => skins.find((s) => s.name === n)).filter((s): s is SkinJson => s !== undefined);
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0].name;

  let name = "tweaked";
  for (let i = 2; skins.some((s) => s.name === name); i++) name = `tweaked-${i}`;
  const merged: SkinJson = { name, attachments: {} };
  const union = (key: "bones" | "ik" | "transform" | "path" | "physics") => {
    const all = [...new Set(sources.flatMap((s) => s[key] ?? []))];
    if (all.length > 0) merged[key] = all;
  };
  for (const s of sources) {
    for (const [slot, atts] of Object.entries(s.attachments ?? {})) {
      // Copies, so part edits below don't apply twice to attachments shared with a source skin.
      merged.attachments![slot] = { ...merged.attachments![slot], ...structuredClone(atts) };
    }
  }
  (["bones", "ik", "transform", "path", "physics"] as const).forEach(union);
  skins.push(merged);
  json.skins = skins;

  // Deform timelines are keyed by skin, so the merged skin needs its own copies.
  for (const animation of Object.values(json.animations ?? {})) {
    const byskin = animation.attachments;
    if (!byskin) continue;
    for (const s of sources) {
      for (const [slot, atts] of Object.entries(byskin[s.name] ?? {})) {
        byskin[name] ??= {};
        byskin[name][slot] = { ...byskin[name][slot], ...structuredClone(atts) };
      }
    }
  }
  return name;
}

function bakeBones(json: SkeletonJson, t: SpineTweaks) {
  for (const bone of json.bones) {
    const b = t.bones[bone.name];
    if (!b) continue;
    bone.rotation = round((bone.rotation ?? 0) + b.rotation);
    bone.scaleX = round((bone.scaleX ?? 1) * b.scaleX);
    bone.scaleY = round((bone.scaleY ?? 1) * b.scaleY);
  }
  // The runtime flips and scales the whole skeleton about its origin; in the file that's the
  // root bone. Its position scales too, and a mirror turns its rotation the other way. Exact
  // unless the root is rotated and the scale is non-uniform.
  const root = json.bones.find((b) => !b.parent);
  if (root && (t.flipX || t.scaleX !== 1 || t.scaleY !== 1)) {
    const sx = (t.flipX ? -1 : 1) * t.scaleX;
    const sy = t.scaleY;
    root.x = round((root.x ?? 0) * sx);
    root.y = round((root.y ?? 0) * sy);
    if (sx < 0 && root.rotation) root.rotation = round(-root.rotation);
    root.scaleX = round((root.scaleX ?? 1) * sx);
    root.scaleY = round((root.scaleY ?? 1) * sy);
  }
}

function bakeConstraints(json: SkeletonJson, t: SpineTweaks, rigSize: number) {
  if (t.physicsMix !== 1 || t.wind !== 0 || t.gravity !== 0 || t.stiffness !== 1) {
    const force = rigSize * PHYSICS_FORCE_SCALE;
    for (const pc of json.physics ?? []) {
      pc.mix = round((pc.mix ?? 1) * t.physicsMix);
      pc.wind = round((pc.wind ?? 0) + t.wind * force);
      pc.gravity = round((pc.gravity ?? 0) + t.gravity * force);
      pc.strength = round((pc.strength ?? 100) * t.stiffness);
    }
  }
  if (t.ikMix !== 1 || t.ikFlip) {
    for (const ik of json.ik ?? []) {
      ik.mix = round((ik.mix ?? 1) * t.ikMix);
      if (t.ikFlip) ik.bendPositive = !(ik.bendPositive ?? true);
    }
  }
  if (t.transformMix !== 1) {
    const m = t.transformMix;
    for (const tc of json.transform ?? []) {
      // Defaults follow SkeletonJson: mixY falls back to mixX, mixScaleY to mixScaleX.
      const mixX = tc.mixX ?? 1;
      const mixScaleX = tc.mixScaleX ?? 1;
      tc.mixY = round((tc.mixY ?? mixX) * m);
      tc.mixScaleY = round((tc.mixScaleY ?? mixScaleX) * m);
      tc.mixRotate = round((tc.mixRotate ?? 1) * m);
      tc.mixX = round(mixX * m);
      tc.mixScaleX = round(mixScaleX * m);
      tc.mixShearY = round((tc.mixShearY ?? 1) * m);
    }
  }
}

/** Hides parts by removing their attachments, shows their full texture or grows their outline, and moves, scales and rotates them. */
function bakeParts(json: SkeletonJson, t: SpineTweaks, pose: SetupPose) {
  for (const slot of json.slots ?? []) {
    const part = t.parts[slot.name];
    if (!part) continue;
    const boneIndex = json.bones.findIndex((b) => b.name === slot.bone);
    const moved = part.dx !== 0 || part.dy !== 0 || part.scale !== 1 || part.rotation !== 0;

    for (const skin of json.skins ?? []) {
      const atts = skin.attachments?.[slot.name];
      if (!atts) continue;
      for (const [name, att] of Object.entries(atts)) {
        const type = att.type ?? "region";
        if (!DRAWABLE.has(type)) continue;
        const deforms = deformKeys(json, skin.name, slot.name, name);
        if (part.hidden) {
          delete atts[name];
          // Deform timelines must not point at a missing attachment, or the file won't load.
          for (const animation of Object.values(json.animations ?? {})) {
            delete animation.attachments?.[skin.name]?.[slot.name]?.[name];
          }
          continue;
        }
        // Before the nudge, so the nudge moves the box or grown outline. A box already covers the region.
        const boxed = part.fullTexture && type === "mesh" && boxMesh(json, slot.name, name, att, deforms);
        if (part.grow > 0 && type === "mesh" && !boxed) growMesh(att, part.grow, pose, boneIndex);
        if (moved && boneIndex >= 0) {
          const nudge = partNudge(pose, boneIndex, part.dx, part.dy, part.scale, part.rotation);
          if (type === "region") nudgeRegion(att, nudge);
          else if (type === "mesh") nudgeMesh(att, deforms, nudge, pose, boneIndex);
          // Linked meshes share their parent's vertices, which is in this slot too.
        }
      }
    }
  }
}

/**
 * Swaps a rigid mesh for a box over its whole region, the same as TweakController does live.
 * Leaves weighted, deformed, linked and distorted meshes alone.
 */
function boxMesh(json: SkeletonJson, slot: string, name: string, att: AttachmentJson, deforms: DeformKey[]): boolean {
  if (!att.uvs || !att.vertices || att.vertices.length !== att.uvs.length || deforms.length > 0) return false;
  const linked = (json.skins ?? []).some((skin) =>
    Object.values(skin.attachments?.[slot] ?? {}).some((a) => a.type === "linkedmesh" && a.parent === name),
  );
  const quad = linked ? null : quadFromMesh(att.uvs, att.vertices);
  if (!quad) return false;
  att.uvs = [...QUAD_UVS];
  att.vertices = quad;
  att.triangles = [...QUAD_TRIANGLES];
  att.hull = 4;
  att.edges = [...QUAD_EDGES];
  return true;
}

/**
 * Pushes a mesh's outline toward its region's edges, the same as TweakController does live.
 * Deform keys in the file are offsets from the setup shape, so they still fit. Linked meshes
 * share the shape, so they grow with it.
 */
function growMesh(att: AttachmentJson, grow: number, pose: SetupPose, slotBone: number) {
  const { uvs, vertices, triangles } = att;
  if (!uvs || !vertices || !triangles || !att.hull) return;
  const hullLength = att.hull * 2;

  // Unweighted vertices are in the slot bone's space.
  if (vertices.length === uvs.length) {
    if (!pose.bones[slotBone]) return;
    const grown = growOutline(uvs, vertices, triangles, hullLength, grow);
    att.uvs = grown.uvs.map(round);
    att.vertices = vertices.map((v, i) => round(v + grown.moves[i]));
    return;
  }

  // Weighted: work out each outline point's move in world space at the setup pose, then hand it
  // to every bone that pulls on the point, so it lands there whatever the weights.
  const world: number[] = [];
  const influences: { bone: BoneWorld; at: number; vertex: number }[] = [];
  for (let i = 0; i < vertices.length; ) {
    const count = vertices[i++];
    let x = 0;
    let y = 0;
    for (let j = 0; j < count; j++, i += 4) {
      const bone = pose.bones[vertices[i]];
      if (!bone) return;
      const weight = vertices[i + 3];
      x += (bone.a * vertices[i + 1] + bone.b * vertices[i + 2] + bone.x) * weight;
      y += (bone.c * vertices[i + 1] + bone.d * vertices[i + 2] + bone.y) * weight;
      influences.push({ bone, at: i + 1, vertex: world.length / 2 });
    }
    world.push(x, y);
  }
  if (world.length !== uvs.length) return;
  const grown = growOutline(uvs, world, triangles, hullLength, grow);
  for (const { bone, at, vertex } of influences) {
    const move = toLocal(bone, grown.moves[vertex * 2], grown.moves[vertex * 2 + 1]);
    if (!move) continue;
    vertices[at] = round(vertices[at] + move.x);
    vertices[at + 1] = round(vertices[at + 1] + move.y);
  }
  att.uvs = grown.uvs.map(round);
}

interface Nudge {
  /** Offset in the bone's local space. */
  tx: number;
  ty: number;
  /** Offset in world space. */
  ox: number;
  oy: number;
  scale: number;
  /** Degrees, local. */
  degrees: number;
  /** Radians, as seen in world space (reflected bones turn the other way). */
  worldRadians: number;
}

/** The same transform TweakController.offsetPart applies, expressed for the setup pose. */
function partNudge(pose: SetupPose, boneIndex: number, dx: number, dy: number, scale: number, degrees: number): Nudge {
  const m = pose.bones[boneIndex];
  const det = m.a * m.d - m.b * m.c;
  const unit = Math.sqrt(Math.abs(det)) || 1;
  const ux = (dx / 100) * pose.rigSize;
  const uy = (dy / 100) * pose.rigSize;
  return {
    tx: ux / unit,
    ty: uy / unit,
    ox: (m.a * ux + m.b * uy) / unit,
    oy: (m.c * ux + m.d * uy) / unit,
    scale,
    degrees,
    worldRadians: ((degrees * Math.PI) / 180) * (det < 0 ? -1 : 1),
  };
}

function nudgeRegion(att: AttachmentJson, n: Nudge) {
  // A region's x/y is its centre, so turning and scaling it about its centre is just these fields.
  // Exact when the bone's scale is uniform; a region can't hold the skew a non-uniform one adds.
  att.x = round((att.x ?? 0) + n.tx);
  att.y = round((att.y ?? 0) + n.ty);
  att.rotation = round((att.rotation ?? 0) + n.degrees);
  att.scaleX = round((att.scaleX ?? 1) * n.scale);
  att.scaleY = round((att.scaleY ?? 1) * n.scale);
}

function nudgeMesh(att: AttachmentJson, deforms: DeformKey[], n: Nudge, pose: SetupPose, slotBone: number) {
  const vertices = att.vertices;
  const uvs = att.uvs;
  if (!vertices || !uvs) return;

  // Unweighted vertices are in the slot bone's space: the same as one influence of weight 1.
  if (vertices.length === uvs.length) {
    const weighted: number[] = [];
    for (let i = 0; i < vertices.length; i += 2) weighted.push(1, slotBone, vertices[i], vertices[i + 1], 1);
    nudgeWeighted(weighted, deforms, n, pose);
    for (let i = 0, j = 0; i < vertices.length; i += 2, j += 5) {
      vertices[i] = weighted[j + 2];
      vertices[i + 1] = weighted[j + 3];
    }
    return;
  }
  nudgeWeighted(vertices, deforms, n, pose);
}

function nudgeWeighted(vertices: number[], deforms: DeformKey[], n: Nudge, pose: SetupPose) {
  // Weighted: each vertex is a sum of positions in several bones' spaces. Apply the world-space
  // transform to each bone's contribution; since weights sum to 1 the vertex moves exactly as
  // the runtime moves it at the setup pose.
  interface Influence {
    bone: BoneWorld;
    at: number;
    weight: number;
  }
  const vertexInfluences: Influence[][] = [];
  for (let i = 0; i < vertices.length; ) {
    const count = vertices[i++];
    const list: Influence[] = [];
    for (let j = 0; j < count; j++, i += 4) {
      const bone = pose.bones[vertices[i]];
      if (!bone) return;
      list.push({ bone, at: i + 1, weight: vertices[i + 3] });
    }
    vertexInfluences.push(list);
  }
  const world = (inf: Influence) => ({
    x: inf.bone.a * vertices[inf.at] + inf.bone.b * vertices[inf.at + 1] + inf.bone.x,
    y: inf.bone.c * vertices[inf.at] + inf.bone.d * vertices[inf.at + 1] + inf.bone.y,
  });
  let cx = 0;
  let cy = 0;
  for (const list of vertexInfluences) {
    for (const inf of list) {
      const p = world(inf);
      cx += p.x * inf.weight;
      cy += p.y * inf.weight;
    }
  }
  cx /= vertexInfluences.length;
  cy /= vertexInfluences.length;

  const cos = Math.cos(n.worldRadians) * n.scale;
  const sin = Math.sin(n.worldRadians) * n.scale;
  const influences = vertexInfluences.flat();
  for (const inf of influences) {
    const p = world(inf);
    const x = p.x - cx;
    const y = p.y - cy;
    const local = toLocal(inf.bone, cx + n.ox + x * cos - y * sin - inf.bone.x, cy + n.oy + x * sin + y * cos - inf.bone.y);
    if (!local) continue;
    vertices[inf.at] = round(local.x);
    vertices[inf.at + 1] = round(local.y);
  }
  // Weighted deform offsets are per influence, in that bone's space: M⁻¹ · L · M.
  for (const key of deforms) {
    mapDeform(key, influences.length * 2, (pair) => {
      const m = influences[pair].bone;
      const det = m.a * m.d - m.b * m.c;
      if (Math.abs(det) < 1e-9) return [1, 0, 0, 1];
      // L · M
      const la = cos * m.a - sin * m.c;
      const lb = cos * m.b - sin * m.d;
      const lc = sin * m.a + cos * m.c;
      const ld = sin * m.b + cos * m.d;
      // M⁻¹ · (L · M)
      return [(m.d * la - m.b * lc) / det, (m.d * lb - m.b * ld) / det, (-m.c * la + m.a * lc) / det, (-m.c * lb + m.a * ld) / det];
    });
  }
}

function toLocal(m: BoneWorld, wx: number, wy: number) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (m.d * wx - m.b * wy) / det, y: (-m.c * wx + m.a * wy) / det };
}

/** Applies a 2×2 matrix (per vertex pair) to a deform key's offsets and stores them compactly. */
function mapDeform(key: DeformKey, length: number, matrixFor: (pair: number) => [number, number, number, number]) {
  if (!key.vertices) return;
  const full = new Array<number>(length).fill(0);
  const offset = key.offset ?? 0;
  key.vertices.forEach((v, i) => {
    if (offset + i < length) full[offset + i] = v;
  });
  for (let i = 0; i < length; i += 2) {
    const [a, b, c, d] = matrixFor(i / 2);
    const x = full[i];
    const y = full[i + 1];
    full[i] = round(a * x + b * y);
    full[i + 1] = round(c * x + d * y);
  }
  const first = full.findIndex((v) => v !== 0);
  if (first === -1) {
    delete key.vertices;
    delete key.offset;
    return;
  }
  let last = length - 1;
  while (full[last] === 0) last--;
  key.offset = first;
  key.vertices = full.slice(first, last + 1);
}

function deformKeys(json: SkeletonJson, skin: string, slot: string, attachment: string): DeformKey[] {
  return Object.values(json.animations ?? {}).flatMap((a) => a.attachments?.[skin]?.[slot]?.[attachment]?.deform ?? []);
}

/** Tint, opacity, shadow color and blend mode, written into each slot and its color timelines. */
function bakeSlotLook(json: SkeletonJson, t: SpineTweaks) {
  const tint = rgb(t.tint);
  for (const slot of json.slots ?? []) {
    const part = t.parts[slot.name];
    const partTint = part?.color ? rgb(part.color) : [1, 1, 1];
    const mul: Rgb = [tint[0] * partTint[0], tint[1] * partTint[1], tint[2] * partTint[2]];
    const alpha = t.alpha;
    const tinted = mul.some((v) => v !== 1) || alpha !== 1;
    const shadow = part?.shadow ?? t.shadow;
    const timelines = Object.values(json.animations ?? {}).flatMap((a) => a.slots?.[slot.name] ?? []);

    if (tinted) {
      slot.color = multiplyHex(slot.color ?? "ffffffff", mul, alpha);
      for (const tl of timelines) {
        for (const k of tl.rgba ?? []) if (k.color) k.color = multiplyHex(k.color, mul, alpha);
        for (const k of tl.rgb ?? []) if (k.color) k.color = multiplyHex(k.color, mul, 1);
        for (const k of tl.alpha ?? []) k.value = round((k.value ?? 1) * alpha);
        for (const k of tl.rgba2 ?? []) if (k.light) k.light = multiplyHex(k.light, mul, alpha);
        for (const k of tl.rgb2 ?? []) if (k.light) k.light = multiplyHex(k.light, mul, 1);
      }
    }
    if (shadow) {
      const dark = shadow.replace("#", "").slice(0, 6).toLowerCase();
      slot.dark = dark;
      for (const tl of timelines) {
        for (const k of tl.rgba2 ?? []) k.dark = dark;
        for (const k of tl.rgb2 ?? []) k.dark = dark;
      }
    }
    const blend: TweakBlendMode = part && part.blend !== "rig" ? part.blend : t.blend;
    if (blend !== "rig") slot.blend = blend;
  }
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

/** Multiplies an "rrggbb" or "rrggbbaa" color, keeping its length. */
function multiplyHex(hex: string, mul: Rgb, alpha: number) {
  const h = hex.replace("#", "");
  const byte = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  const out = [byte(0) * mul[0], byte(2) * mul[1], byte(4) * mul[2]];
  if (h.length >= 8) out.push(byte(6) * alpha);
  return out.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

function round(v: number) {
  return Math.round(v * 10000) / 10000;
}
