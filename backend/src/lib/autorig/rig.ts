import * as spine from "@esotericsoftware/spine-core";
import Delaunator from "delaunator";
import sharp from "sharp";
import { stubLoader } from "../animate-fx.js";
import { fillAndPack, type PackedRegion, type PartCut } from "./slice.js";
import type { AutoRigView, Cutout, Joints, Point } from "./types.js";

// Builds a Spine 4.2 rig from a cutout and its joints (AUTO_RIG_PLAN.md, "How the rig is built").
//
// Every rig gets the same bones (root, hips, spine, chest, neck, head, and upper_arm / forearm /
// hand, thigh / shin / foot with foot_target IK on each side), so Muse Spark's animations and the
// checks in animate.ts treat them alike. The art is one texture drawn by six weighted meshes, one
// per body part (head, torso, two arms, two legs), each in its own slot so draw order can change.
//
// Each pixel is given to its nearest bone by distance *through the silhouette* (geodesic), so a
// leg never takes pixels from the other leg across the gap between them, and an arm doesn't take
// the torso it hangs beside. Parts overlap in a band around each joint and their vertices are
// weighted by the same function of position, so seams stay closed when a joint bends.

type Json = Record<string, unknown>;

/** Cells across the larger side of the image for the body-part map and distance fields. */
const GRID = 300;
/** Width of the blend between two bones at a joint, as a share of the character's height. */
const BLEND_SHARE = 0.032;
/** How far a part reaches past its own territory, in blend widths (one-texture rigs). */
const OVERLAP = 2.2;
/** How far a sliced part's hidden fill reaches from a joint, in limb half-widths there. */
const HIDDEN_REACH = 1.5;
/** Spacing of interior mesh points, as a share of the character's height. */
const SPACING_SHARE = 0.035;
/** Bones per vertex. */
const MAX_INFLUENCES = 3;
const MIN_WEIGHT = 0.02;
/** Spine version written to the skeleton (the runtime and uploads expect 4.2). */
const SPINE_VERSION = "4.2.43";
/** Name of the atlas page and its single region. */
export const PAGE_NAME = "body";
/** Length of the generated idle loop. */
export const IDLE_SECONDS = 2.4;

type Side = "l" | "r";
const SIDES: Side[] = ["l", "r"];

interface BoneDef {
  name: string;
  parent: string | null;
  /** World position and direction in image pixels; the tail only sets the direction and length. */
  head: Point;
  tail: Point | null;
  /** Bones that skin the art (all but root, hips and the IK targets). */
  skin: boolean;
}

interface PartDef {
  name: string;
  bones: string[];
  /** The slot's bone; weighted meshes ignore it, but it says what the slot belongs to. */
  slotBone: string;
}

export interface BuiltRig {
  skeleton: Json;
  atlas: string;
  /** The atlas page as PNG, and as pixels. */
  page: Buffer;
  pageImage: Cutout;
  /** The page's regions and where each came from in the cutout. */
  regions: PackedRegion[];
  stats: { parts: { name: string; vertices: number; triangles: number }[] };
}

export interface RigOptions {
  /** Cut the art into 14 parts with their hidden areas filled (default), or draw it as one texture. */
  slice?: boolean;
}

export async function buildRig(cut: Cutout, joints: Joints, view: AutoRigView, { slice = true }: RigOptions = {}): Promise<BuiltRig> {
  const bones = boneDefs(joints);
  const parts = partDefs();
  const byName = new Map(bones.map((b) => [b.name, b]));

  // Spine space: y up, the root on the ground under the pelvis.
  const originX = joints.pelvis.x;
  const originY = Math.max(joints.toe_l.y, joints.toe_r.y, joints.ankle_l.y, joints.ankle_r.y);
  const toSpine = (p: Point): Point => ({ x: p.x - originX, y: originY - p.y });
  const world = new Map(
    bones.map((b) => {
      const h = toSpine(b.head);
      const t = b.tail ? toSpine(b.tail) : null;
      const rotation = t && (t.x !== h.x || t.y !== h.y) ? deg(Math.atan2(t.y - h.y, t.x - h.x)) : 0;
      return [b.name, { x: h.x, y: h.y, rotation, length: t ? Math.hypot(t.x - h.x, t.y - h.y) : 0 }];
    }),
  );
  // The hips point along the spine so bending them tilts the whole upper body.
  world.get("hips")!.rotation = world.get("spine")!.rotation;

  const map = new BodyMap(cut, bones.filter((b) => b.skin));
  const height = map.figureHeight;
  const sigma = (height * BLEND_SHARE) / map.cell;

  const spacing = (height * SPACING_SHARE) / map.cell;
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));

  /** A vertex's weights over `allowed` bones by distance through the silhouette, as Spine's weighted vertex entries. */
  const weigh = (p: Point, allowed: string[]): number[] => {
    const d = allowed.map((name) => map.distance(name, p));
    const nearest = Math.min(...d);
    const weighted = d
      .map((di, i) => ({ name: allowed[i], w: Math.exp(-(((di - nearest) / sigma) ** 2)) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_INFLUENCES)
      .filter((x) => x.w >= MIN_WEIGHT);
    const total = weighted.reduce((s, x) => s + x.w, 0);
    const out = [weighted.length];
    const s = toSpine(p);
    for (const { name, w } of weighted) {
      const b = world.get(name)!;
      const r = rad(-b.rotation);
      const dx = s.x - b.x;
      const dy = s.y - b.y;
      out.push(boneIndex.get(name)!, round(dx * Math.cos(r) - dy * Math.sin(r)), round(dx * Math.sin(r) + dy * Math.cos(r)), round(w / total, 4));
    }
    return out;
  };

  const attachments: Record<string, Json> = {};
  const stats: BuiltRig["stats"]["parts"] = [];
  let order: string[];
  let slotBones: Map<string, string>;
  let pageImage: Cutout;
  let regions: PackedRegion[];

  if (!slice) {
    // One texture, six meshes that overlap at the joints.
    for (const part of parts) {
      const region = map.partRegion(part.bones, sigma * OVERLAP);
      const mesh = triangulate(map, region, part.bones.map((n) => byName.get(n)!), spacing);
      if (!mesh.triangles.length) continue;
      attachments[part.name] = {
        [part.name]: {
          type: "mesh",
          path: PAGE_NAME,
          uvs: mesh.points.flatMap((p) => [round(p.x / cut.width, 5), round(p.y / cut.height, 5)]),
          triangles: mesh.triangles,
          vertices: mesh.points.flatMap((p) => weigh(p, map.boneNames)),
          hull: mesh.hull,
          width: cut.width,
          height: cut.height,
        },
      };
      stats.push({ name: part.name, vertices: mesh.points.length, triangles: mesh.triangles.length / 3 });
    }
    // Far limbs first. In a turned view the character's right side is nearer.
    order = view === "right" ? ["arm_l", "leg_l", "leg_r", "torso", "head", "arm_r"] : ["leg_r", "leg_l", "torso", "head", "arm_r", "arm_l"];
    slotBones = new Map(parts.map((p) => [p.name, p.slotBone]));
    pageImage = cut;
    regions = [{ name: PAGE_NAME, x: 0, y: 0, width: cut.width, height: cut.height, srcX: 0, srcY: 0 }];
  } else {
    // Fourteen parts, each with its own region. See AUTO_RIG_PLAN.md, "Slicing".
    const sliced = slicedParts(view);
    order = sliced.order;
    slotBones = new Map(sliced.parts.map((p) => [p.name, p.slotBone]));
    const partOfBone = new Map(sliced.parts.flatMap((p, i) => p.bones.map((b) => [map.boneNames.indexOf(b), i] as const)));
    const label = new Int16Array(map.mask.length).fill(-1);
    for (let c = 0; c < label.length; c++) if (map.mask[c]) label[c] = partOfBone.get(map.nearestBone(c)) ?? -1;
    const depth = map.depth();
    const rank = (name: string) => order.indexOf(name);

    const cuts: PartCut[] = [];
    const meshes: { part: PartDef; mesh: PartMesh; own: Uint8Array; allowed: string[] }[] = [];
    sliced.parts.forEach((part, pi) => {
      const own = new Uint8Array(label.length);
      for (let c = 0; c < label.length; c++) if (label[c] === pi) own[c] = 1;
      // Hidden areas: around each joint where another part is drawn over this one.
      const hidden = new Uint8Array(label.length);
      const allowed = [...part.bones];
      for (const j of sliced.joints) {
        if (j.parts[0] !== part.name && j.parts[1] !== part.name) continue;
        const other = j.parts[0] === part.name ? j.parts[1] : j.parts[0];
        const otherIndex = sliced.parts.findIndex((p) => p.name === other);
        if (rank(other) > rank(part.name)) {
          const at = map.toCell(joints[j.at]);
          const radius = Math.max(depth[map.cellAt(joints[j.at])], 2) * HIDDEN_REACH;
          for (let c = 0; c < label.length; c++) {
            if (label[c] !== otherIndex) continue;
            const x = c % map.gw;
            if (Math.hypot(x - at.x, (c - x) / map.gw - at.y) <= radius) hidden[c] = 1;
          }
        } else {
          // On top here: this part's end bends with the part under it.
          allowed.push(...sliced.parts[otherIndex].bones);
        }
      }
      // The mesh reaches a cell past the cut into its neighbours (drawn clear there), so the
      // triangles along the cut aren't dropped and every own pixel is covered.
      const region = map.pad(grow(own.map((v, c) => v | hidden[c]), map.gw, map.gh).map((v, c) => v & map.mask[c]));
      if (!region.some((v) => v)) return;
      // Pixels: own cells (and the soft edge beside them) keep their art; hidden cells get filled.
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let c = 0; c < region.length; c++) {
        if (!region[c]) continue;
        const x = c % map.gw;
        const y = (c - x) / map.gw;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const px0 = Math.max(0, Math.floor(x0 * map.cell));
      const py0 = Math.max(0, Math.floor(y0 * map.cell));
      const px1 = Math.min(cut.width, Math.ceil((x1 + 1) * map.cell));
      const py1 = Math.min(cut.height, Math.ceil((y1 + 1) * map.cell));
      const kind = new Uint8Array((px1 - px0) * (py1 - py0));
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          let c = Math.floor(y / map.cell) * map.gw + Math.floor(x / map.cell);
          if (!region[c]) continue;
          if (!map.mask[c]) c = map.nearestSolidOf(c);
          kind[(y - py0) * (px1 - px0) + x - px0] = c >= 0 && own[c] ? 1 : c >= 0 && hidden[c] ? 2 : 0;
        }
      }
      cuts.push({ name: part.name, x0: px0, y0: py0, x1: px1, y1: py1, kind });
      const mesh = triangulate(map, region, part.bones.map((n) => byName.get(n)!), spacing);
      if (mesh.triangles.length) meshes.push({ part, mesh, own, allowed });
    });

    const packed = fillAndPack(cut, cuts);
    pageImage = packed.page;
    regions = packed.regions;
    for (const { part, mesh, own, allowed } of meshes) {
      const r = regions.find((x) => x.name === part.name)!;
      attachments[part.name] = {
        [part.name]: {
          type: "mesh",
          path: part.name,
          uvs: mesh.points.flatMap((p) => [round((p.x - r.srcX) / r.width, 5), round((p.y - r.srcY) / r.height, 5)]),
          triangles: mesh.triangles,
          // Hidden fill moves only with its own part; its own art may also bend with the part beneath.
          vertices: mesh.points.flatMap((p) => {
            let c = map.cellAt(p);
            if (!map.mask[c]) c = map.nearestSolidOf(c);
            return weigh(p, c >= 0 && own[c] ? allowed : part.bones);
          }),
          hull: mesh.hull,
          width: r.width,
          height: r.height,
        },
      };
      stats.push({ name: part.name, vertices: mesh.points.length, triangles: mesh.triangles.length / 3 });
    }
  }

  // Bones in parent space.
  const boneJson = bones.map((b) => {
    const w = world.get(b.name)!;
    const out: Json = { name: b.name };
    if (b.parent) {
      const p = world.get(b.parent)!;
      const r = rad(-p.rotation);
      const dx = w.x - p.x;
      const dy = w.y - p.y;
      out.parent = b.parent;
      setIf(out, "length", round(w.length));
      setIf(out, "x", round(dx * Math.cos(r) - dy * Math.sin(r)));
      setIf(out, "y", round(dx * Math.sin(r) + dy * Math.cos(r)));
      setIf(out, "rotation", round(wrap(w.rotation - p.rotation)));
    }
    return out;
  });

  const slots = order.filter((n) => attachments[n]).map((n) => ({ name: n, bone: slotBones.get(n)!, attachment: n }));

  const skeleton: Json = {
    skeleton: { spine: SPINE_VERSION, x: round(-originX), y: round(originY - cut.height), width: cut.width, height: cut.height, fps: 30 },
    bones: boneJson,
    slots,
    ik: SIDES.map((s, i) => ({ name: `leg_${s}`, order: i, bones: [`thigh_${s}`, `shin_${s}`], target: `foot_target_${s}` })),
    skins: [{ name: "default", attachments }],
    animations: { idle: idleAnimation(world.get("chest")!.length + world.get("spine")!.length) },
  };
  fixBendDirections(skeleton, (name) => world.get(name)!);

  const atlas =
    `${PAGE_NAME}.png\nsize: ${pageImage.width}, ${pageImage.height}\nfilter: Linear, Linear\n` +
    regions.map((r) => `${r.name}\nbounds: ${r.x}, ${r.y}, ${r.width}, ${r.height}\n`).join("");
  const page = await sharp(pageImage.rgba, { raw: { width: pageImage.width, height: pageImage.height, channels: 4 } }).png().toBuffer();
  return { skeleton, atlas, page, pageImage, regions, stats: { parts: stats } };
}

/**
 * The sliced parts, the joints between them and the draw order (back to front). At each joint the
 * part drawn later is on top; the part under it gets its hidden area filled there.
 */
function slicedParts(view: AutoRigView): { parts: PartDef[]; joints: { at: keyof Joints; parts: [string, string] }[]; order: string[] } {
  const parts: PartDef[] = [{ name: "head", bones: ["neck", "head"], slotBone: "head" }, { name: "torso", bones: ["spine", "chest"], slotBone: "chest" }];
  for (const s of SIDES) {
    for (const b of [`upper_arm_${s}`, `forearm_${s}`, `hand_${s}`, `thigh_${s}`, `shin_${s}`, `foot_${s}`]) parts.push({ name: b, bones: [b], slotBone: b });
  }
  const joints: { at: keyof Joints; parts: [string, string] }[] = [{ at: "neck", parts: ["head", "torso"] }];
  for (const s of SIDES) {
    joints.push(
      { at: `shoulder_${s}`, parts: [`upper_arm_${s}`, "torso"] },
      { at: `elbow_${s}`, parts: [`forearm_${s}`, `upper_arm_${s}`] },
      { at: `wrist_${s}`, parts: [`hand_${s}`, `forearm_${s}`] },
      { at: `hip_${s}`, parts: [`thigh_${s}`, "torso"] },
      { at: `knee_${s}`, parts: [`shin_${s}`, `thigh_${s}`] },
      { at: `ankle_${s}`, parts: [`foot_${s}`, `shin_${s}`] },
    );
  }
  // Within a limb: thigh over shin over foot, hand over forearm over upper arm. Torso over the
  // thighs, arms over the torso. In a turned view the far (left) arm and leg go behind everything.
  const leg = (s: Side) => [`foot_${s}`, `shin_${s}`, `thigh_${s}`];
  const arm = (s: Side) => [`upper_arm_${s}`, `forearm_${s}`, `hand_${s}`];
  const order =
    view === "right"
      ? [...arm("l"), ...leg("l"), ...leg("r"), "torso", "head", ...arm("r")]
      : [...leg("r"), ...leg("l"), "torso", "head", ...arm("r"), ...arm("l")];
  return { parts, joints, order };
}

function boneDefs(j: Joints): BoneDef[] {
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const mid = lerp(j.pelvis, j.neck, 0.45);
  const headBase = lerp(j.neck, j.head, 0.25);
  const defs: BoneDef[] = [
    { name: "root", parent: null, head: { x: j.pelvis.x, y: Math.max(j.toe_l.y, j.toe_r.y, j.ankle_l.y, j.ankle_r.y) }, tail: null, skin: false },
    { name: "hips", parent: "root", head: j.pelvis, tail: null, skin: false },
    { name: "spine", parent: "hips", head: j.pelvis, tail: mid, skin: true },
    { name: "chest", parent: "spine", head: mid, tail: j.neck, skin: true },
    { name: "neck", parent: "chest", head: j.neck, tail: headBase, skin: true },
    { name: "head", parent: "neck", head: headBase, tail: j.head, skin: true },
  ];
  for (const s of SIDES) {
    defs.push(
      { name: `upper_arm_${s}`, parent: "chest", head: j[`shoulder_${s}`], tail: j[`elbow_${s}`], skin: true },
      { name: `forearm_${s}`, parent: `upper_arm_${s}`, head: j[`elbow_${s}`], tail: j[`wrist_${s}`], skin: true },
      { name: `hand_${s}`, parent: `forearm_${s}`, head: j[`wrist_${s}`], tail: j[`hand_${s}`], skin: true },
    );
  }
  for (const s of SIDES) {
    defs.push(
      { name: `thigh_${s}`, parent: "hips", head: j[`hip_${s}`], tail: j[`knee_${s}`], skin: true },
      { name: `shin_${s}`, parent: `thigh_${s}`, head: j[`knee_${s}`], tail: j[`ankle_${s}`], skin: true },
    );
  }
  for (const s of SIDES) {
    // The foot hangs off its IK target, so a planted foot stays flat while the leg bends.
    defs.push(
      { name: `foot_target_${s}`, parent: "root", head: j[`ankle_${s}`], tail: null, skin: false },
      { name: `foot_${s}`, parent: `foot_target_${s}`, head: j[`ankle_${s}`], tail: j[`toe_${s}`], skin: true },
    );
  }
  return defs;
}

function partDefs(): PartDef[] {
  return [
    { name: "head", bones: ["neck", "head"], slotBone: "head" },
    { name: "torso", bones: ["spine", "chest"], slotBone: "chest" },
    ...SIDES.map((s) => ({ name: `arm_${s}`, bones: [`upper_arm_${s}`, `forearm_${s}`, `hand_${s}`], slotBone: `upper_arm_${s}` })),
    ...SIDES.map((s) => ({ name: `leg_${s}`, bones: [`thigh_${s}`, `shin_${s}`, `foot_${s}`], slotBone: `thigh_${s}` })),
  ];
}

/**
 * Spine bends a two-bone IK chain one of two ways. Pose the setup with each and keep the one that
 * leaves the knee where the joints put it.
 */
function fixBendDirections(skeleton: Json, worldOf: (name: string) => { x: number; y: number }) {
  const iks = skeleton.ik as Json[];
  for (const ik of iks) {
    const knee = worldOf((ik.bones as string[])[1]);
    const error = (bendPositive: boolean) => {
      ik.bendPositive = bendPositive;
      const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
      const sk = new spine.Skeleton(data);
      sk.setToSetupPose();
      sk.updateWorldTransform(spine.Physics.pose);
      const shin = sk.findBone((ik.bones as string[])[1])!;
      return Math.hypot(shin.worldX - knee.x, shin.worldY - knee.y);
    };
    if (error(true) <= error(false)) ik.bendPositive = true;
    else ik.bendPositive = false;
    if (ik.bendPositive) delete ik.bendPositive;
  }
}

/** A gentle breathing loop: the chest rises, the head and arms follow a beat later. */
function idleAnimation(torsoLength: number): Json {
  const dur = IDLE_SECONDS;
  const half = dur / 2;
  const wave = (amount: number) =>
    [0, half, dur].map((t, i) => {
      const value = i === 1 ? amount : 0;
      const next = i === 0 ? amount : 0;
      const key: Json = { time: round(t, 3) };
      if (value) key.value = value;
      if (i < 2) key.curve = [round(t + half * 0.45, 3), value, round(t + half * 0.55, 3), next];
      return key;
    });
  const bob = round(torsoLength * 0.025);
  return {
    bones: {
      hips: {
        translate: [0, half, dur].map((t, i) => {
          const y = i === 1 ? -bob : 0;
          const next = i === 0 ? -bob : 0;
          const key: Json = { time: t };
          if (y) key.y = y;
          if (i < 2) key.curve = [round(t + half * 0.45, 3), 0, round(t + half * 0.55, 3), 0, round(t + half * 0.45, 3), y, round(t + half * 0.55, 3), next];
          return key;
        }),
      },
      chest: { rotate: wave(1.5) },
      head: { rotate: wave(-2) },
      upper_arm_l: { rotate: wave(3) },
      upper_arm_r: { rotate: wave(-3) },
      forearm_l: { rotate: wave(2) },
      forearm_r: { rotate: wave(-2) },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Body map: the silhouette on a coarse grid, with a distance field per skinning bone.

class BodyMap {
  readonly cell: number;
  readonly gw: number;
  readonly gh: number;
  readonly mask: Uint8Array;
  readonly figureHeight: number;
  readonly boneNames: string[];
  private readonly fields: Float64Array[];
  /** For each cell off the silhouette, the nearest cell on it (-1 when there is none). */
  private readonly nearestSolid: Int32Array;
  private readonly segments: [Point, Point][];

  constructor(cut: Cutout, bones: BoneDef[]) {
    this.cell = Math.max(cut.width, cut.height) / GRID;
    this.gw = Math.ceil(cut.width / this.cell);
    this.gh = Math.ceil(cut.height / this.cell);
    this.mask = new Uint8Array(this.gw * this.gh);
    let [top, bottom] = [Infinity, -Infinity];
    for (let y = 0; y < cut.height; y++) {
      for (let x = 0; x < cut.width; x++) {
        if (cut.rgba[(y * cut.width + x) * 4 + 3] < 128) continue;
        this.mask[Math.floor(y / this.cell) * this.gw + Math.floor(x / this.cell)] = 1;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    this.figureHeight = Math.max(bottom - top, 1);
    this.boneNames = bones.map((b) => b.name);
    this.segments = bones.map((b) => [this.toCell(b.head), this.toCell(b.tail ?? b.head)]);
    this.fields = this.segments.map((seg) => this.geodesic(seg));
    this.nearestSolid = this.nearestSolidCells();
  }

  toCell(p: Point): Point {
    return { x: p.x / this.cell - 0.5, y: p.y / this.cell - 0.5 };
  }

  toPixel(cx: number, cy: number): Point {
    return { x: (cx + 0.5) * this.cell, y: (cy + 0.5) * this.cell };
  }

  cellAt(p: Point): number {
    const cx = Math.min(Math.max(Math.round(p.x / this.cell - 0.5), 0), this.gw - 1);
    const cy = Math.min(Math.max(Math.round(p.y / this.cell - 0.5), 0), this.gh - 1);
    return cy * this.gw + cx;
  }

  /** Distance from a point (image pixels) to a bone, in cells, through the silhouette. */
  distance(bone: string, p: Point): number {
    const b = this.boneNames.indexOf(bone);
    let c = this.cellAt(p);
    if (!this.mask[c]) c = this.nearestSolid[c];
    const straight = segmentDistance(this.toCell(p), this.segments[b]);
    if (c < 0) return straight + GRID;
    const d = this.fields[b][c];
    // Cells a bone can't reach (a separate piece) fall back to straight-line distance, behind
    // any bone that can reach them.
    return Number.isFinite(d) ? d : straight + GRID;
  }

  /** The cells a part covers: its own territory plus `overlap` cells into its neighbours, padded off the silhouette. */
  partRegion(partBones: string[], overlap: number): Uint8Array {
    const own = partBones.map((n) => this.boneNames.indexOf(n));
    const region = new Uint8Array(this.gw * this.gh);
    for (let c = 0; c < region.length; c++) {
      if (!this.mask[c]) continue;
      let best = Infinity;
      let mine = Infinity;
      for (let b = 0; b < this.fields.length; b++) {
        const d = this.fieldAt(b, c);
        best = Math.min(best, d);
        if (own.includes(b)) mine = Math.min(mine, d);
      }
      if (mine - best <= overlap) region[c] = 1;
    }
    return this.pad(region);
  }

  /** Pads a region two cells off the silhouette, so its mesh covers the soft edge. */
  pad(region: Uint8Array): Uint8Array {
    const padded = Uint8Array.from(region);
    for (let pass = 0; pass < 2; pass++) {
      const prev = Uint8Array.from(padded);
      for (let y = 0; y < this.gh; y++) {
        for (let x = 0; x < this.gw; x++) {
          const c = y * this.gw + x;
          if (prev[c] || this.mask[c]) continue;
          for (const [dx, dy] of NEIGHBOURS_8) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < this.gw && ny < this.gh && prev[ny * this.gw + nx]) {
              padded[c] = 1;
              break;
            }
          }
        }
      }
    }
    return padded;
  }

  /** The index (in boneNames) of the bone nearest a cell through the silhouette. */
  nearestBone(c: number): number {
    let best = 0;
    for (let b = 1; b < this.fields.length; b++) if (this.fieldAt(b, c) < this.fieldAt(best, c)) best = b;
    return best;
  }

  /** The nearest cell on the silhouette to a cell off it (the cell itself when it's on it; -1 if none). */
  nearestSolidOf(c: number): number {
    return this.nearestSolid[c];
  }

  /** Each cell's distance to the nearest cell off the silhouette, in cells (about half the limb's width at a joint). */
  depth(): Float64Array {
    const depth = new Float64Array(this.mask.length).fill(Infinity);
    const heap = new MinHeap();
    for (let c = 0; c < this.mask.length; c++) {
      if (!this.mask[c]) {
        depth[c] = 0;
        heap.push(c, 0);
      }
    }
    while (heap.size) {
      const [c, d] = heap.pop();
      if (d > depth[c]) continue;
      const x = c % this.gw;
      const y = (c - x) / this.gw;
      for (const [dx, dy] of NEIGHBOURS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const n = ny * this.gw + nx;
        const nd = d + (dx && dy ? Math.SQRT2 : 1);
        if (nd < depth[n]) {
          depth[n] = nd;
          heap.push(n, nd);
        }
      }
    }
    return depth;
  }

  private fieldAt(b: number, c: number): number {
    const d = this.fields[b][c];
    if (Number.isFinite(d)) return d;
    const x = c % this.gw;
    return segmentDistance({ x, y: (c - x) / this.gw }, this.segments[b]) + GRID;
  }

  /** Dijkstra over the silhouette from the cells a bone passes through. */
  private geodesic([a, b]: [Point, Point]): Float64Array {
    const dist = new Float64Array(this.gw * this.gh).fill(Infinity);
    const heap = new MinHeap();
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let i = 0; i <= steps; i++) {
      const c = this.cellAt(this.toPixel(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps));
      if (this.mask[c] && dist[c] !== 0) {
        dist[c] = 0;
        heap.push(c, 0);
      }
    }
    if (!heap.size) {
      // The bone misses the silhouette: start from the cell nearest to it.
      let best = -1;
      let bestD = Infinity;
      for (let c = 0; c < this.mask.length; c++) {
        if (!this.mask[c]) continue;
        const x = c % this.gw;
        const d = segmentDistance({ x, y: (c - x) / this.gw }, [a, b]);
        if (d < bestD) [best, bestD] = [c, d];
      }
      if (best < 0) return dist;
      dist[best] = bestD;
      heap.push(best, bestD);
    }
    while (heap.size) {
      const [c, d] = heap.pop();
      if (d > dist[c]) continue;
      const x = c % this.gw;
      const y = (c - x) / this.gw;
      for (const [dx, dy] of NEIGHBOURS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const n = ny * this.gw + nx;
        if (!this.mask[n]) continue;
        const nd = d + (dx && dy ? Math.SQRT2 : 1);
        if (nd < dist[n]) {
          dist[n] = nd;
          heap.push(n, nd);
        }
      }
    }
    return dist;
  }

  private nearestSolidCells(): Int32Array {
    const nearest = new Int32Array(this.gw * this.gh).fill(-1);
    const queue: number[] = [];
    for (let c = 0; c < this.mask.length; c++) {
      if (this.mask[c]) {
        nearest[c] = c;
        queue.push(c);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const x = c % this.gw;
      const y = (c - x) / this.gw;
      for (const [dx, dy] of NEIGHBOURS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const n = ny * this.gw + nx;
        if (nearest[n] < 0) {
          nearest[n] = nearest[c];
          queue.push(n);
        }
      }
    }
    return nearest;
  }
}

// ---------------------------------------------------------------------------------------------
// Meshing a part's region.

export interface PartMesh {
  /** Image pixels; the first `hull` points are the outline, in order. */
  points: Point[];
  triangles: number[];
  hull: number;
}

function triangulate(map: BodyMap, region: Uint8Array, bones: BoneDef[], spacing: number): PartMesh {
  const { gw, gh } = map;
  const inRegion = (p: Point) => region[map.cellAt(p)] === 1;
  const points: Point[] = [];
  const taken = new Set<string>();
  const minGap = map.cell * 0.9;
  const add = (p: Point, force = false) => {
    const key = `${Math.round(p.x / minGap)},${Math.round(p.y / minGap)}`;
    if (!force && taken.has(key)) return;
    taken.add(key);
    points.push(p);
  };

  // Outlines of each piece of the region; the largest is the hull.
  const pieces = components(region, gw, gh);
  pieces.sort((a, b) => b.length - a.length);
  let hull = 0;
  pieces.forEach((piece, i) => {
    const outline = simplifyClosed(traceOutline(region, gw, gh, piece[0]).map((c) => map.toPixel(c % gw, Math.floor(c / gw))), map.cell * 0.4);
    for (const p of outline) add(p, i === 0);
    if (i === 0) hull = points.length;
  });
  if (!hull) return { points: [], triangles: [], hull: 0 };

  // Interior points on a staggered grid.
  const step = Math.max(3, Math.round(spacing));
  for (let y = 0, row = 0; y < gh; y += step, row++) {
    for (let x = row % 2 ? Math.floor(step / 2) : 0; x < gw; x += step) {
      if (region[y * gw + x]) add(map.toPixel(x, y));
    }
  }
  // Denser along each bone and across each joint, where the mesh bends.
  const fine = (step * map.cell) / 2;
  for (const b of bones) {
    const tail = b.tail ?? b.head;
    const len = Math.hypot(tail.x - b.head.x, tail.y - b.head.y);
    const n = Math.max(1, Math.ceil(len / fine));
    for (let i = 0; i <= n; i++) {
      const p = { x: b.head.x + ((tail.x - b.head.x) * i) / n, y: b.head.y + ((tail.y - b.head.y) * i) / n };
      if (inRegion(p)) add(p);
    }
    if (!len) continue;
    const across = { x: -(tail.y - b.head.y) / len, y: (tail.x - b.head.x) / len };
    for (const j of [b.head, tail]) {
      for (const dir of [1, -1]) {
        for (let k = 1; k <= 6; k++) {
          const p = { x: j.x + across.x * fine * k * dir, y: j.y + across.y * fine * k * dir };
          if (!inRegion(p)) break;
          add(p);
        }
      }
    }
  }

  // Delaunay, keeping triangles that lie inside the region. Edges may graze a cell past it: the
  // simplified outline cuts across small concave notches, and dropping those triangles would
  // leave the notches undrawn.
  const del = Delaunator.from(points.map((p) => [p.x, p.y]));
  const triangles: number[] = [];
  const loose = grow(region, gw, gh);
  const inLoose = (p: Point) => loose[map.cellAt(p)] === 1;
  const inside = (a: Point, b: Point) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (map.cell * 0.7)));
    for (let i = 1; i < n; i++) if (!inLoose({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n })) return false;
    return true;
  };
  for (let t = 0; t < del.triangles.length; t += 3) {
    const [i, j, k] = [del.triangles[t], del.triangles[t + 1], del.triangles[t + 2]];
    const [a, b, c] = [points[i], points[j], points[k]];
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    if (area < map.cell * map.cell * 0.05) continue;
    if (!inRegion({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 })) continue;
    if (!inside(a, b) || !inside(b, c) || !inside(c, a)) continue;
    triangles.push(i, j, k);
  }
  return { points, triangles, hull };
}

/** The region grown by one cell (8-connected). */
function grow(region: Uint8Array, gw: number, gh: number): Uint8Array {
  const out = Uint8Array.from(region);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!region[y * gw + x]) continue;
      for (const [dx, dy] of NEIGHBOURS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) out[ny * gw + nx] = 1;
      }
    }
  }
  return out;
}

/** Connected pieces (8-connected), each as its cells in raster order. */
function components(region: Uint8Array, gw: number, gh: number): number[][] {
  const seen = new Uint8Array(region.length);
  const out: number[][] = [];
  for (let start = 0; start < region.length; start++) {
    if (!region[start] || seen[start]) continue;
    const cells: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = c % gw;
      const y = (c - x) / gw;
      for (const [dx, dy] of NEIGHBOURS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (region[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    cells.sort((a, b) => a - b);
    out.push(cells);
  }
  return out;
}

/** Moore-neighbour tracing of the outer boundary, clockwise, from the piece's first cell in raster order. */
function traceOutline(region: Uint8Array, gw: number, gh: number, start: number): number[] {
  // E, SE, S, SW, W, NW, N, NE: clockwise with y down.
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && region[y * gw + x] === 1;
  const out = [start];
  let x = start % gw;
  let y = (start - x) / gw;
  let dir = 0;
  let firstMove = -1;
  for (let guard = 0; guard < region.length * 4; guard++) {
    let moved = -1;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 5 + k) % 8;
      if (on(x + DX[d], y + DY[d])) {
        moved = d;
        break;
      }
    }
    if (moved < 0) break;
    if (y * gw + x === start && firstMove >= 0 && moved === firstMove) break;
    if (firstMove < 0) firstMove = moved;
    x += DX[moved];
    y += DY[moved];
    dir = moved;
    const c = y * gw + x;
    if (c === start) continue;
    out.push(c);
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed outline. */
function simplifyClosed(points: Point[], epsilon: number): Point[] {
  if (points.length < 4) return points;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > farD) [far, farD] = [i, d];
  }
  const first = rdp(points.slice(0, far + 1), epsilon);
  const second = rdp([...points.slice(far), points[0]], epsilon);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let index = 0;
  let max = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i], [a, b]);
    if (d > max) [index, max] = [i, d];
  }
  if (max <= epsilon) return [a, b];
  return [...rdp(points.slice(0, index + 1), epsilon).slice(0, -1), ...rdp(points.slice(index), epsilon)];
}

// ---------------------------------------------------------------------------------------------

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size() {
    return this.keys.length;
  }

  push(val: number, key: number) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.vals[0], this.keys[0]];
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.vals[i], this.vals[j]] = [this.vals[j], this.vals[i]];
  }
}

const NEIGHBOURS_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

function segmentDistance(p: Point, [a, b]: [Point, Point]): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0), 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function setIf(obj: Json, key: string, value: number) {
  if (value !== 0) obj[key] = value;
}

function wrap(d: number): number {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
