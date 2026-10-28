import * as spine from "@esotericsoftware/spine-core";

// Effects for generated animations beyond bone keys, written as Spine 4.2 JSON: slot colour and
// alpha, hit flashes (two-colour tint), attachment swaps, draw-order changes, and weapon trails.
// Trails are baked: the new animation is played in the Spine runtime, and ghost copies of the
// weapon follow its path a few frames behind, glowing (additive) only while it moves fast.

export interface SlotInfo {
  name: string;
  bone: string;
  /** Attachment names this slot can show in the default skin. */
  attachments: string[];
  /** The attachment shown in the setup pose, or null when the slot starts hidden. */
  setup: string | null;
  /** Setup colour as rrggbbaa. */
  color: string;
  /** Width × height of the setup attachment, to find the torso (the biggest piece of art). */
  area: number;
}

export interface TrailSpec {
  bone: string;
  /** rrggbb */
  color: string;
  count: number;
}

export interface DrawOrderKey {
  t: number;
  front: string[];
  back: string[];
}

export interface Fx {
  slots: Record<string, Record<string, unknown[]>>;
  drawOrder: DrawOrderKey[];
  trails: TrailSpec[];
  /** Slots that need a dark colour in the setup pose for their flash to render. */
  darkSlots: string[];
}

/** Bones and slots we add for trails; they're never shown to Muse or keyed by it. */
export const FX_PREFIX = "fx_";
const MAX_FLASHES = 8;
const MAX_TRAILS = 2;
const MAX_GHOSTS = 4;
const MAX_DRAW_ORDER_KEYS = 8;
/** Frames between one ghost and the next. */
const GHOST_SPACING = 2;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const round = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

function defaultSkin(skeleton: Record<string, unknown>): Record<string, unknown> {
  const skins = list(skeleton.skins).map(record);
  return skins.find((s) => s.name === "default") ?? skins[0] ?? {};
}

export function readSlots(skeleton: Record<string, unknown>): SlotInfo[] {
  const attachments = record(defaultSkin(skeleton).attachments);
  return list(skeleton.slots)
    .map(record)
    .filter((s) => typeof s.name === "string" && typeof s.bone === "string" && !String(s.name).startsWith(FX_PREFIX))
    .map((s) => ({
      name: String(s.name),
      bone: String(s.bone),
      attachments: Object.keys(record(attachments[String(s.name)])),
      setup: typeof s.attachment === "string" ? s.attachment : null,
      color: typeof s.color === "string" ? s.color.toLowerCase() : "ffffffff",
      area: typeof s.attachment === "string" ? areaOf(record(record(attachments[String(s.name)])[s.attachment])) : 0,
    }));
}

const areaOf = (a: Record<string, unknown>) => num(a.width, 0) * num(a.height, 0);

/**
 * The bones that carry at least half of the visible art, root first: the hips-to-chest chain.
 * The last one is the chest.
 */
export function coreBones(skeleton: Record<string, unknown>): string[] {
  const bones = list(skeleton.bones).map(record);
  const children = new Map<string, string[]>();
  for (const b of bones) if (typeof b.parent === "string") children.set(b.parent, [...(children.get(b.parent) ?? []), String(b.name)]);
  const slotsOn = new Map<string, number>();
  for (const sl of list(skeleton.slots).map(record)) {
    if (typeof sl.attachment === "string" && !String(sl.name).startsWith(FX_PREFIX)) slotsOn.set(String(sl.bone), (slotsOn.get(String(sl.bone)) ?? 0) + 1);
  }
  const total = [...slotsOn.values()].reduce((a, b) => a + b, 0);
  const carried = (name: string): number => (slotsOn.get(name) ?? 0) + (children.get(name) ?? []).reduce((a, c) => a + carried(c), 0);
  return total === 0 ? [] : bones.map((b) => String(b.name)).filter((n) => !n.startsWith(FX_PREFIX) && carried(n) >= total * 0.5);
}

/**
 * One line per slot: its bone, what it can show, whether it starts hidden, and whether it's drawn
 * behind the torso (the biggest piece of art), where a striking arm would be hidden by the body.
 */
export function describeSlots(slots: SlotInfo[]): string[] {
  const torso = slots.reduce<SlotInfo | null>((best, s) => (s.area > (best?.area ?? 0) ? s : best), null);
  const torsoIndex = torso ? slots.indexOf(torso) : -1;
  return slots.map((s, i) => {
    const shows = s.attachments.map((a) => (a === s.setup ? `${a} (shown at rest)` : a));
    const depth = s === torso ? "; the torso" : i < torsoIndex ? `; drawn behind the torso (${torso?.name})` : "";
    return `- ${s.name}; on bone ${s.bone}; ${shows.length ? `can show ${shows.join(", ")}` : "no attachments"}${s.setup ? "" : "; hidden at rest"}${depth}`;
  });
}

// ---------------------------------------------------------------------------
// Reading Muse's effects
// ---------------------------------------------------------------------------

const HEX = /^[0-9a-f]{6}([0-9a-f]{2})?$/i;
const hex = (v: unknown, withAlpha: boolean, fallback: string): string => {
  if (typeof v !== "string") return fallback;
  const h = v.replace(/^#/, "").toLowerCase();
  if (!HEX.test(h)) return fallback;
  return withAlpha ? (h.length === 6 ? `${h}ff` : h) : h.slice(0, 6);
};

interface ColorKey {
  t: number;
  /** r, g, b, a in 0–1 */
  c: number[];
}

const toRgb = (h: string) => [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toHex = (c: number[]) => c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");

/** Piecewise-linear value of keyed colours at `t`, holding the ends. */
function colorAt(keys: ColorKey[], t: number, fallback: number[]): number[] {
  if (keys.length === 0) return fallback;
  if (t <= keys[0].t) return keys[0].c;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return a.c.map((v, j) => v + (b.c[j] - v) * f);
    }
  }
  return keys[keys.length - 1].c;
}

/**
 * Slot timelines, draw order and trails from Muse's reply, checked against the rig. Unknown slots,
 * attachments and bones are dropped and reported. `snap` puts a time on the frame grid.
 */
export function readFx(
  parsed: unknown,
  slots: SlotInfo[],
  boneNames: Set<string>,
  durationSec: number,
  loop: boolean,
  snap: (t: number) => number,
  dropped: string[],
): Fx {
  const bySlot = new Map(slots.map((s) => [s.name, s]));
  const frame = 1 / 30;
  const tints = new Map<string, ColorKey[]>();
  const flashes = new Map<string, ColorKey[]>();
  const attachmentKeys = new Map<string, { time: number; name: string | null }[]>();

  const slotList = (value: unknown): SlotInfo[] => {
    if (value === "all" || value === undefined) return slots.filter((s) => s.setup);
    return list(value).flatMap((n) => {
      const slot = typeof n === "string" ? bySlot.get(n) : undefined;
      if (!slot && typeof n === "string") dropped.push(`${n.slice(0, 60)}: not a slot in this rig`);
      return slot ? [slot] : [];
    });
  };

  for (const raw of list(getPathSafe(parsed, "slots"))) {
    const e = record(raw);
    const slot = typeof e.slot === "string" ? bySlot.get(e.slot) : undefined;
    if (!slot) {
      if (typeof e.slot === "string") dropped.push(`${e.slot.slice(0, 60)}: not a slot in this rig`);
      continue;
    }
    const colors = list(e.color)
      .map(record)
      .map((k) => ({ t: snap(num(k.t, 0)), c: toRgb(hex(k.color, true, slot.color)) }))
      .sort((a, b) => a.t - b.t);
    if (colors.length) tints.set(slot.name, colors);
    const swaps = list(e.attachment).map(record).flatMap((k) => {
      const name = k.name === null ? null : typeof k.name === "string" ? k.name : undefined;
      if (name === undefined) return [];
      if (name !== null && !slot.attachments.includes(name)) {
        dropped.push(`${slot.name}: has no attachment "${name.slice(0, 60)}"`);
        return [];
      }
      return [{ time: snap(num(k.t, 0)), name }];
    });
    if (swaps.length) attachmentKeys.set(slot.name, swaps.sort((a, b) => a.time - b.time));
  }

  for (const raw of list(getPathSafe(parsed, "flash")).slice(0, MAX_FLASHES)) {
    const e = record(raw);
    const t = snap(num(e.t, 0));
    // A full-strength flash held for several frames turned the art into a flat white silhouette,
    // so flashes are partial and short: at most two frames held, a fifth of a second to fade.
    const strength = clamp(num(e.strength, 0.35), 0.1, 0.5);
    const color = toRgb(hex(e.color, false, "ffffff")).map((v) => v * strength);
    const hold = clamp(num(e.hold, frame), 0, 2 * frame);
    const fade = clamp(num(e.fade, 0.1), frame, 0.2);
    const black = [0, 0, 0];
    // Always the whole body: a flash on one slot (the belly) read as a white blob, not a flash.
    for (const slot of slotList("all")) {
      const keys = flashes.get(slot.name) ?? [];
      keys.push({ t: Math.max(0, t - frame), c: black }, { t, c: color }, { t: Math.min(durationSec, t + hold), c: color }, { t: Math.min(durationSec, t + hold + fade), c: black });
      flashes.set(slot.name, keys);
    }
  }

  const out: Fx["slots"] = {};
  const darkSlots: string[] = [];
  for (const slot of slots) {
    const tint = tints.get(slot.name);
    const flash = flashes.get(slot.name)?.sort((a, b) => a.t - b.t);
    const timelines: Record<string, unknown[]> = {};
    const setup = toRgb(slot.color);
    if (tint) {
      if (tint[0].t > 0) tint.unshift({ t: 0, c: setup });
      if (loop) tint.push({ t: durationSec, c: tint[0].c });
    }
    if (flash) {
      // Two-colour tint: the dark colour is added to the art, so dark white turns it white.
      darkSlots.push(slot.name);
      const times = [...new Set([0, ...(tint ?? []).map((k) => k.t), ...flash.map((k) => k.t), durationSec])].sort((a, b) => a - b);
      timelines.rgba2 = times.map((t) => ({ time: round4(t), light: toHex(colorAt(tint ?? [], t, setup)), dark: toHex(colorAt(flash, t, [0, 0, 0])) }));
    } else if (tint) {
      timelines.rgba = tint.map((k) => ({ time: round4(k.t), color: toHex(k.c) }));
    }
    const swaps = attachmentKeys.get(slot.name);
    if (swaps) {
      // Back to the setup attachment at the end of a loop, so it doesn't jump on the wrap.
      if (loop && swaps[swaps.length - 1].name !== slot.setup) swaps.push({ time: durationSec, name: slot.setup });
      timelines.attachment = swaps.map((k) => ({ time: round4(k.time), name: k.name }));
    }
    if (Object.keys(timelines).length) out[slot.name] = timelines;
  }

  const drawOrder = list(getPathSafe(parsed, "drawOrder"))
    .slice(0, MAX_DRAW_ORDER_KEYS)
    .map(record)
    .map((k) => ({
      t: snap(num(k.t, 0)),
      front: slotList(list(k.front)).map((s) => s.name),
      back: slotList(list(k.back)).map((s) => s.name),
    }))
    .sort((a, b) => a.t - b.t);
  if (loop && drawOrder.length && (drawOrder[drawOrder.length - 1].front.length || drawOrder[drawOrder.length - 1].back.length)) {
    drawOrder.push({ t: durationSec, front: [], back: [] });
  }

  const trails = list(getPathSafe(parsed, "trails"))
    .slice(0, MAX_TRAILS)
    .map(record)
    .flatMap((t): TrailSpec[] => {
      const bone = typeof t.bone === "string" ? t.bone : "";
      if (!boneNames.has(bone) || bone.startsWith(FX_PREFIX)) {
        if (bone) dropped.push(`trail on ${bone.slice(0, 60)}: not a bone in this rig`);
        return [];
      }
      return [{ bone, color: hex(t.color, false, "ffd27a"), count: clamp(Math.round(num(t.count, 3)), 1, MAX_GHOSTS) }];
    });

  return { slots: out, drawOrder, trails, darkSlots };
}

function getPathSafe(value: unknown, key: string): unknown {
  return record(value)[key];
}

// ---------------------------------------------------------------------------
// Writing effects into the skeleton
// ---------------------------------------------------------------------------

/**
 * Adds the slot timelines, trails and draw order to `animName` in `skeleton` (mutated). Trails need
 * the animation's bone keys already in place. Returns notes on trails that couldn't be made.
 */
export function applyFx(skeleton: Record<string, unknown>, animName: string, fx: Fx, durationSec: number, loop: boolean): string[] {
  const notes: string[] = [];
  const animation = record(record(skeleton.animations)[animName]);
  if (Object.keys(fx.slots).length) animation.slots = { ...record(animation.slots), ...fx.slots };
  for (const raw of list(skeleton.slots)) {
    const s = record(raw);
    if (fx.darkSlots.includes(String(s.name)) && typeof s.dark !== "string") s.dark = "000000";
  }
  for (const trail of fx.trails) notes.push(...addTrail(skeleton, animName, trail, durationSec, loop));
  // Draw order last: trails insert slots, and the offsets depend on every slot's index.
  if (fx.drawOrder.length) animation.drawOrder = drawOrderKeys(skeleton, fx.drawOrder);
  return notes;
}

/** Spine draw-order keys: each listed slot moves by an offset from its setup index; the rest keep their order. */
function drawOrderKeys(skeleton: Record<string, unknown>, keys: DrawOrderKey[]): unknown[] {
  const names = list(skeleton.slots).map((s) => String(record(s).name));
  const n = names.length;
  return keys.map((k) => {
    const targets = new Map<string, number>();
    k.front.forEach((name, i) => targets.set(name, n - 1 - i));
    k.back.forEach((name, i) => { if (!targets.has(name)) targets.set(name, i); });
    const offsets = [...targets]
      .map(([slot, target]) => ({ slot, index: names.indexOf(slot), target }))
      .filter((o) => o.index >= 0 && o.target !== o.index)
      .sort((a, b) => a.index - b.index)
      .map((o) => ({ slot: o.slot, offset: o.target - o.index }));
    return offsets.length ? { time: round4(k.t), offsets } : { time: round4(k.t) };
  });
}

/** Builds attachments without textures: enough to pose a skeleton and read bone transforms. */
export const stubLoader: spine.AttachmentLoader = {
  newRegionAttachment: (_skin, name, path) => new spine.RegionAttachment(name, path),
  newMeshAttachment: (_skin, name, path) => new spine.MeshAttachment(name, path),
  newBoundingBoxAttachment: (_skin, name) => new spine.BoundingBoxAttachment(name),
  newPathAttachment: (_skin, name) => new spine.PathAttachment(name),
  newPointAttachment: (_skin, name) => new spine.PointAttachment(name),
  newClippingAttachment: (_skin, name) => new spine.ClippingAttachment(name),
};

/** A bone's world transform: x' = a·x + b·y + worldX, y' = c·x + d·y + worldY. */
interface Pose {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

interface Sample {
  /** The anchor (the trail bone's shoulder) and the root, in world space. */
  anchor: Pose;
  anchorRotation: number;
  root: Pose;
  rootRotation: number;
  /** The trail bone relative to the anchor: position in the anchor's space, rotation and scale. */
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** The trailed art's centre in the anchor's space, for its speed relative to the body. */
  cx: number;
  cy: number;
}

const poseOf = (b: spine.Bone): Pose => ({ a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY });
const apply = (p: Pose, x: number, y: number) => ({ x: p.a * x + p.b * y + p.x, y: p.c * x + p.d * y + p.y });
function invertApply(p: Pose, x: number, y: number) {
  const det = p.a * p.d - p.b * p.c || 1;
  const dx = x - p.x;
  const dy = y - p.y;
  return { x: (p.d * dx - p.b * dy) / det, y: (p.a * dy - p.c * dx) / det };
}

/**
 * Ghost copies of everything `trail.bone` carries, a few frames behind it. The art is copied into
 * new slots on new bones under the root; for a mesh weighted to several bones, only the triangles
 * mostly weighted to the trail bone are kept (the axe, not the whole arm).
 */
function addTrail(skeleton: Record<string, unknown>, animName: string, trail: TrailSpec, durationSec: number, loop: boolean): string[] {
  const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
  const sk = new spine.Skeleton(data);
  const anim = data.findAnimation(animName);
  const bone = sk.findBone(trail.bone);
  if (!anim || !bone) return [`trail on ${trail.bone}: bone not found`];
  const boneIndex = data.bones.indexOf(bone.data);
  const root = sk.getRootBone();
  if (!root) return [];

  // The art to copy, as attachment JSON local to the trail bone, captured in the setup pose.
  sk.setToSetupPose();
  sk.updateWorldTransform(spine.Physics.pose);
  const skinAttachments = record(defaultSkin(skeleton).attachments);
  const parts: { slot: string; name: string; json: Record<string, unknown>; cx: number; cy: number }[] = [];
  for (const slot of sk.slots) {
    const attachment = slot.getAttachment();
    if (!attachment || slot.data.name.startsWith(FX_PREFIX)) continue;
    const json = record(record(skinAttachments[slot.data.name])[attachment.name]);
    if (attachment instanceof spine.RegionAttachment && slot.bone === bone) {
      parts.push({ slot: slot.data.name, name: attachment.name, json: { ...json }, cx: num(json.x, 0), cy: num(json.y, 0) });
    } else if (attachment instanceof spine.MeshAttachment) {
      const part = meshPart(slot, attachment, json, bone, boneIndex);
      if (part) parts.push({ slot: slot.data.name, name: attachment.name, ...part });
    }
  }
  if (parts.length === 0) return [`trail on ${trail.bone}: it carries no art to trail`];

  // Ghosts lag relative to the chest, not the world: lagged in world space they hung in the air
  // beside a jumping character. (A few bones up the chain reached the root for a sword bone that
  // hangs off it.) Anchored to the chest, the trail draws the swing's arc around the body.
  const chest = coreBones(skeleton).pop();
  const anchorBone: spine.Bone = (chest && chest !== trail.bone ? sk.findBone(chest) : null) ?? root;
  const sample = (t: number | null): Sample => {
    sk.setToSetupPose();
    if (t !== null) anim.apply(sk, 0, t, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    sk.updateWorldTransform(spine.Physics.pose);
    const anchor = poseOf(anchorBone);
    const rel = invertApply(anchor, bone.worldX, bone.worldY);
    const centre = bone.localToWorld(new spine.Vector2(parts[0].cx, parts[0].cy));
    const relCentre = invertApply(anchor, centre.x, centre.y);
    return {
      anchor,
      anchorRotation: anchorBone.getWorldRotationX(),
      root: poseOf(root),
      rootRotation: root.getWorldRotationX(),
      x: rel.x,
      y: rel.y,
      rotation: bone.getWorldRotationX() - anchorBone.getWorldRotationX(),
      scaleX: bone.getWorldScaleX() / root.getWorldScaleX(),
      scaleY: bone.getWorldScaleY() / root.getWorldScaleY(),
      cx: relCentre.x,
      cy: relCentre.y,
    };
  };
  /** Where a ghost showing the swing as it was at `then` sits now, local to the root. */
  const ghost = (now: Sample, then: Sample) => {
    const world = apply(now.anchor, then.x, then.y);
    const local = invertApply(now.root, world.x, world.y);
    return { x: local.x, y: local.y, rotation: now.anchorRotation + then.rotation - now.rootRotation, scaleX: then.scaleX, scaleY: then.scaleY };
  };
  const restSample = sample(null);
  const rest = ghost(restSample, restSample);
  const frames = Math.max(2, Math.round(durationSec * 30) + 1);
  const samples = Array.from({ length: frames }, (_, f) => sample(Math.min(f / 30, durationSec)));
  const height = num(record(skeleton.skeleton).height, 1000) || 1000;
  // Anchor space can be scaled; measure speed in world units by mapping the offset through the anchor.
  const speed = samples.map((s, f) => {
    if (f === 0) return 0;
    const p = samples[f - 1];
    const a = apply(s.anchor, s.cx, s.cy);
    const b = apply(s.anchor, p.cx, p.cy);
    return Math.hypot(a.x - b.x, a.y - b.y) * 30;
  });
  // Ghosts show from about 0.8 of the rig's height per second, fully at 2.5, so only real swings trail.
  const slow = 0.8 * height;
  const fast = 2.5 * height;

  const bones = list(skeleton.bones);
  const slots = list(skeleton.slots);
  const animation = record(record(skeleton.animations)[animName]);
  const boneTimelines = record(animation.bones);
  const slotTimelines = record(animation.slots);
  const skinMap = record(defaultSkin(skeleton).attachments);
  if (!defaultSkin(skeleton).attachments) defaultSkin(skeleton).attachments = skinMap;

  for (let i = 1; i <= trail.count; i++) {
    const ghostBone = `${FX_PREFIX}trail_${trail.bone}_${i}`;
    if (!bones.some((b) => record(b).name === ghostBone)) {
      bones.push({ name: ghostBone, parent: root.data.name, x: round(rest.x), y: round(rest.y), rotation: round(rest.rotation), scaleX: round4(rest.scaleX), scaleY: round4(rest.scaleY) });
    }
    const delay = i * GHOST_SPACING;
    const at = (f: number) => (f - delay >= 0 ? f - delay : loop ? frames - 1 + (f - delay) : 0);
    const keys = samples.map((now, f) => ({ f, s: ghost(now, samples[at(f)]) }));
    for (let k = 1; k < keys.length; k++) {
      // Keep rotation continuous so the ghosts don't spin the long way round between frames.
      while (keys[k].s.rotation - keys[k - 1].s.rotation > 180) keys[k].s.rotation -= 360;
      while (keys[k].s.rotation - keys[k - 1].s.rotation < -180) keys[k].s.rotation += 360;
    }
    boneTimelines[ghostBone] = {
      translate: keys.map(({ f, s }) => ({ time: round4(Math.min(f / 30, durationSec)), x: round(s.x - rest.x), y: round(s.y - rest.y) })),
      rotate: keys.map(({ f, s }) => ({ time: round4(Math.min(f / 30, durationSec)), value: round(s.rotation - rest.rotation) })),
      scale: keys.map(({ f, s }) => ({ time: round4(Math.min(f / 30, durationSec)), x: round4(s.scaleX / rest.scaleX), y: round4(s.scaleY / rest.scaleY) })),
    };
    const fade = 0.7 * (1 - (i - 1) / trail.count);
    parts.forEach((part, p) => {
      const ghostSlot = `${FX_PREFIX}trail_${trail.bone}_${i}_${p}`;
      if (!slots.some((s) => record(s).name === ghostSlot)) {
        // Just behind the art it copies.
        const index = slots.findIndex((s) => record(s).name === part.slot);
        // Two-colour tint with a dark colour of the trail colour turns the ghost into a solid
        // glowing silhouette; additive blending alone barely brightened a dark grey weapon.
        slots.splice(Math.max(0, index), 0, { name: ghostSlot, bone: ghostBone, color: `${trail.color}00`, dark: trail.color, blend: "additive", attachment: part.name });
        skinMap[ghostSlot] = { [part.name]: part.json };
      }
      slotTimelines[ghostSlot] = {
        rgba2: keys.map(({ f }) => {
          const a = clamp((speed[at(f)] - slow) / (fast - slow), 0, 1) * fade;
          return { time: round4(Math.min(f / 30, durationSec)), light: `${trail.color}${toHex([a])}`, dark: trail.color };
        }),
      };
    });
  }
  animation.bones = boneTimelines;
  animation.slots = slotTimelines;
  return [];
}

/**
 * The part of a mesh that `bone` carries, as an unweighted mesh local to that bone: the whole mesh
 * if it's attached to the bone unweighted, or the triangles whose vertices are all mostly weighted
 * to it. Null when nothing qualifies.
 */
function meshPart(slot: spine.Slot, mesh: spine.MeshAttachment, json: Record<string, unknown>, bone: spine.Bone, boneIndex: number) {
  const world = new Array<number>(mesh.worldVerticesLength).fill(0);
  mesh.computeWorldVertices(slot, 0, mesh.worldVerticesLength, world, 0, 2);
  const count = mesh.worldVerticesLength / 2;
  let keep: boolean[];
  if (!mesh.bones) {
    if (slot.bone !== bone) return null;
    keep = new Array<boolean>(count).fill(true);
  } else {
    // bones: [n, i1, i2, …] per vertex; weights are in vertices as [x, y, w] per influence.
    keep = [];
    let b = 0;
    let w = 0;
    for (let v = 0; v < count; v++) {
      const n = mesh.bones[b++];
      let weight = 0;
      for (let k = 0; k < n; k++, b++, w += 3) if (mesh.bones[b] === boneIndex) weight += mesh.vertices[w + 2];
      keep.push(weight >= 0.6);
    }
  }
  const triangles = mesh.triangles.length ? mesh.triangles : list(json.triangles).map((t) => num(t, 0));
  const kept: number[] = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    if (keep[triangles[i]] && keep[triangles[i + 1]] && keep[triangles[i + 2]]) kept.push(triangles[i], triangles[i + 1], triangles[i + 2]);
  }
  if (kept.length === 0) return null;
  const used = [...new Set(kept)].sort((a, b) => a - b);
  const index = new Map(used.map((v, i) => [v, i]));
  const uvs = list(json.uvs).map((u) => num(u, 0));
  const vertices: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const v of used) {
    const local = bone.worldToLocal(new spine.Vector2(world[v * 2], world[v * 2 + 1]));
    vertices.push(round(local.x), round(local.y));
    cx += local.x / used.length;
    cy += local.y / used.length;
  }
  return {
    json: {
      type: "mesh",
      ...(typeof json.path === "string" ? { path: json.path } : { path: mesh.name }),
      uvs: used.flatMap((v) => [uvs[v * 2], uvs[v * 2 + 1]]),
      triangles: kept.map((v) => index.get(v) ?? 0),
      vertices,
      hull: 0,
      ...(typeof json.width === "number" ? { width: json.width, height: json.height } : {}),
    },
    cx,
    cy,
  };
}
