import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiFetch } from "./ai-fetch.js";
import { getAssetRow } from "./assets.js";
import { ANIMATE_REASONING_EFFORT, ANIMATION_LOG_DIR, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "./config.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow } from "./db.js";
import { rigHashOf } from "./fingerprint.js";
import * as spine from "@esotericsoftware/spine-core";
import { FX_PREFIX, applyFx, coreBones, describeSlots, readFx, readSlots, stubLoader, type Fx } from "./animate-fx.js";
import { apiKey, getPath, logPrompt } from "./meta.js";
import { objectUrl, putFile } from "./storage.js";
import { parseSkeleton } from "./validate.js";

// Generated animations: Muse Spark reads a description of the remix's skeleton (bones, where they
// sit, what drives them, how the rig's own animations move) and writes keyframes for a new
// animation from the user's prompt. Spine animations are sparse keyframes per bone that the
// runtime interpolates, so one call writes the whole thing. The keys are checked, converted from
// screen space into each bone's local space, given smooth curves, and saved as a new animation in
// the remix's skeleton JSON. Shapes match frontend/app/lib/types.ts.

export interface AnimateInput {
  prompt: string;
  durationSec: number;
  loop: boolean;
  /** The remix's skeleton as JSON, sent by the page only when the stored one is a binary .skel. */
  skeleton: Record<string, unknown> | null;
  /**
   * Pictures of the rig as data URLs: its rest pose with bone names and frames of its own attack.
   * Without them Spark can't tell which way the character faces or which bone holds the weapon.
   */
  images: string[];
}

export interface AnimateResult {
  asset: ReturnType<typeof toSpineAsset>;
  animation: AssetRow["animations"][number];
  notes: string;
  /** Muse's choreography: the request expanded into timed beats and poses, which the keys follow. */
  plan: string;
  /** Bones Muse keyed that were left out, with the reason. */
  dropped: string[];
}

/** A failure the user can act on; its message is shown as is. */
export class AnimateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const DURATION_LIMITS = { min: 0.5, max: 8 };
const MAX_PROMPT = 500;
const MAX_KEYS = 40;
/** Key times snap to this frame rate. Keys that land on the same frame keep the later one. */
const FPS = 30;
/** Moves are capped at this share of the rig's larger side. */
const MAX_MOVE_SHARE = 0.6;
const SCALE_LIMITS = { min: 0.2, max: 3 };
const SHEAR_LIMIT = 60;
const MAX_IMAGES = 2;
/** A 1400×700 JPEG rig sheet is ~200 KB; this leaves room without accepting anything huge. */
const MAX_IMAGE_CHARS = 3_000_000;
const IMAGE_PREFIX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export function parseAnimateInput(body: unknown): AnimateInput | { error: string } {
  const prompt = getPath(body, ["prompt"]);
  const durationSec = getPath(body, ["durationSec"]);
  const loop = getPath(body, ["loop"]);
  const skeleton = getPath(body, ["skeleton"]) ?? null;
  const images = getPath(body, ["images"]) ?? [];
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) {
    return { error: `Describe the animation in 1–${MAX_PROMPT} characters.` };
  }
  if (typeof durationSec !== "number" || !(durationSec >= DURATION_LIMITS.min && durationSec <= DURATION_LIMITS.max)) {
    return { error: `The length must be ${DURATION_LIMITS.min}–${DURATION_LIMITS.max} seconds.` };
  }
  if (typeof loop !== "boolean") return { error: "Say whether the animation loops." };
  const parsedSkeleton = skeleton === null ? null : parseSkeleton(skeleton);
  if (skeleton !== null && !parsedSkeleton) return { error: "The skeleton sent with the request isn't a Spine skeleton JSON." };
  if (!Array.isArray(images) || images.length > MAX_IMAGES || !images.every((i) => typeof i === "string" && i.length <= MAX_IMAGE_CHARS && IMAGE_PREFIX.test(i))) {
    return { error: `Send at most ${MAX_IMAGES} rig pictures as JPEG, PNG or WebP data URLs.` };
  }
  return { prompt: prompt.trim(), durationSec: Math.round(durationSec * 100) / 100, loop, skeleton: parsedSkeleton, images: images as string[] };
}

// ---------------------------------------------------------------------------
// Reading the rig
// ---------------------------------------------------------------------------

/** 2×2 world matrix [a, b, c, d]: x' = a·x + b·y, y' = c·x + d·y. */
type Matrix = [number, number, number, number];

interface RigBone {
  name: string;
  parent: RigBone | null;
  length: number;
  /** Setup-pose world position of the bone's origin and tip. */
  x: number;
  y: number;
  tipX: number;
  tipY: number;
  m: Matrix;
  slots: string[];
  /** Why the bone can't be keyed directly, or null when it can. */
  drivenBy: string | null;
}

interface Rig {
  bones: Map<string, RigBone>;
  width: number;
  height: number;
}

const DEG = Math.PI / 180;
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Setup-pose world transforms, ignoring shear and inherit modes (close enough to describe the rig and map moves). */
function readRig(skeleton: Record<string, unknown>): Rig {
  const bones = new Map<string, RigBone>();
  for (const raw of list(skeleton.bones)) {
    const b = record(raw);
    if (typeof b.name !== "string") continue;
    const parent = typeof b.parent === "string" ? (bones.get(b.parent) ?? null) : null;
    const rot = num(b.rotation, 0) * DEG;
    const sx = num(b.scaleX, 1);
    const sy = num(b.scaleY, 1);
    const local: Matrix = [Math.cos(rot) * sx, -Math.sin(rot) * sy, Math.sin(rot) * sx, Math.cos(rot) * sy];
    const p = parent?.m ?? [1, 0, 0, 1];
    const m: Matrix = [p[0] * local[0] + p[1] * local[2], p[0] * local[1] + p[1] * local[3], p[2] * local[0] + p[3] * local[2], p[2] * local[1] + p[3] * local[3]];
    const lx = num(b.x, 0);
    const ly = num(b.y, 0);
    const x = (parent?.x ?? 0) + p[0] * lx + p[1] * ly;
    const y = (parent?.y ?? 0) + p[2] * lx + p[3] * ly;
    const length = num(b.length, 0);
    bones.set(b.name, { name: b.name, parent, length, x, y, tipX: x + m[0] * length, tipY: y + m[2] * length, m, slots: [], drivenBy: null });
  }

  for (const raw of list(skeleton.slots)) {
    const s = record(raw);
    const bone = typeof s.bone === "string" ? bones.get(s.bone) : undefined;
    if (bone && typeof s.name === "string") bone.slots.push(s.name);
  }

  const drive = (names: unknown, reason: string) => {
    for (const n of list(names)) {
      const bone = typeof n === "string" ? bones.get(n) : undefined;
      if (bone && !bone.drivenBy) bone.drivenBy = reason;
    }
  };
  for (const raw of list(skeleton.ik)) {
    const c = record(raw);
    if (num(c.mix, 1) === 0) continue;
    drive(c.bones, `IK "${String(c.name)}": move its target bone "${String(c.target)}" instead`);
  }
  for (const raw of list(skeleton.transform)) {
    const c = record(raw);
    const mixes = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"].map((k) => num(c[k], 1));
    if (mixes.every((v) => v === 0)) continue;
    // Often a grip: both hands pinned to one weapon bone, so moving the target moves them together.
    drive(c.bones, `transform constraint "${String(c.name)}": it follows bone "${String(c.target)}", so move or turn that bone instead`);
  }
  for (const raw of list(skeleton.path)) drive(record(raw).bones, `path constraint "${String(record(raw).name)}"`);
  for (const raw of list(skeleton.physics)) drive([record(raw).bone], "physics (it moves on its own)");

  const header = record(skeleton.skeleton);
  return { bones, width: num(header.width, 0), height: num(header.height, 0) };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** One line per bone: where it sits in the setup pose, which way it points, what it carries, what drives it. */
function describeBones(rig: Rig): string[] {
  return [...rig.bones.values()].filter((b) => !b.name.startsWith(FX_PREFIX)).map((b) => {
    const angle = Math.round(Math.atan2(b.m[2], b.m[0]) / DEG);
    const where = b.length > 0
      ? `from (${r1(b.x)}, ${r1(b.y)}) to (${r1(b.tipX)}, ${r1(b.tipY)}), points ${angle}°`
      : `at (${r1(b.x)}, ${r1(b.y)})`;
    return [
      `- ${b.name}`,
      b.parent ? `parent ${b.parent.name}` : "root",
      where,
      b.slots.filter((s) => !s.startsWith(FX_PREFIX)).length ? `carries ${b.slots.filter((s) => !s.startsWith(FX_PREFIX)).slice(0, 6).join(", ")}` : null,
      b.drivenBy ? `DRIVEN BY ${b.drivenBy}` : null,
    ]
      .filter(Boolean)
      .join("; ");
  });
}

/** How far each bone moves in the rig's own animations, as a sense of scale and of which bones matter. */
function describeAnimations(skeleton: Record<string, unknown>): string[] {
  return Object.entries(record(skeleton.animations)).map(([name, raw]) => {
    const ranges: { bone: string; kind: string; span: number; text: string }[] = [];
    for (const [bone, timelines] of Object.entries(record(record(raw).bones))) {
      if (bone.startsWith(FX_PREFIX)) continue;
      const t = record(timelines);
      const rotate = list(t.rotate).map((k) => num(record(k).value, 0));
      if (rotate.length) {
        const [lo, hi] = [Math.min(...rotate), Math.max(...rotate)];
        if (hi - lo >= 1) ranges.push({ bone, kind: "rotate", span: hi - lo, text: `${bone} rotate ${r1(lo)}..${r1(hi)}°` });
      }
      const moves = list(t.translate).map((k) => [num(record(k).x, 0), num(record(k).y, 0)]);
      if (moves.length) {
        const xs = moves.map((m) => m[0]);
        const ys = moves.map((m) => m[1]);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (span >= 1) {
          ranges.push({ bone, kind: "move", span, text: `${bone} local move x ${r1(Math.min(...xs))}..${r1(Math.max(...xs))}, y ${r1(Math.min(...ys))}..${r1(Math.max(...ys))}` });
        }
      }
    }
    const top = (kind: string) => ranges.filter((r) => r.kind === kind).sort((a, b) => b.span - a.span).slice(0, 10).map((r) => r.text);
    return `- ${name} (${r1(maxTime(raw))}s): ${[...top("rotate"), ...top("move")].join("; ") || "no bone motion"}`;
  });
}

function maxTime(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(maxTime));
  if (typeof value !== "object" || value === null) return 0;
  return Math.max(num((value as Record<string, unknown>).time, 0), ...Object.values(value).map(maxTime));
}

// ---------------------------------------------------------------------------
// Asking Muse
// ---------------------------------------------------------------------------

// Two calls. Asked to key an animation in one go, Spark wrote small, evenly timed, softly eased
// motion (every bone keyed on the same beats, punches with no snap). Planning the beats first, on
// their own, and then keying them with per-key eases gives it room to be bold.

const PLAN_SYSTEM_PROMPT = `You are the animation director on a stylish 2D action game. Turn the user's request into a punchy beat sheet for this exact rig; a keyframer will follow it to the letter. Be bold: weak, floaty, evenly timed motion is the failure to avoid.

You get pictures of the rig: its rest pose with every bone labelled, and frames of its own attack. Study them first.

Write, in plain text under 300 words, no JSON:
0. READ: which way the character faces (the way it strikes in its own attack), which bones the weapon hangs from (the bone nearest the weapon's handle in the picture, not a guess from names), the weapon hand's bone chain from shoulder to hand, and the off hand.
1. FEEL: one line on the energy and weight (heavy, explosive, sloppy, proud, twitchy…).
2. BEATS: 4–8 lines, each "start–end s · BEAT · what happens", naming the bones to move with concrete numbers (degrees, units). For actions use: anticipation (wind up opposite to the action, 20–35% of the time, slower), the action itself (fast: 0.06–0.2 s), an impact hold on the strongest pose (0.08–0.2 s), follow-through past the end pose, then a settle. For dances and idles, name the accent beats and a groove with rhythm and variation, not a plain back-and-forth.
3. HERO POSES: the 2–4 extreme poses as strong silhouettes with big numbers. Exaggerate: the rig's own attack and hit ranges are a floor for action, not a ceiling. Weapons travel in wide arcs (90–180°), jumps leave the ground by 20–40% of the rig's height, and the body squashes (scale about 1.1 x, 0.85 y) on crouches and landings and stretches at launch.
4. OVERLAP: which bone leads and how the rest follow (hips → chest → shoulder → elbow → hand or weapon, 0.03–0.08 s apart; hair, cloth and tails 0.08–0.15 s behind with a bigger swing and an overshoot).
5. FX: what sells the hits beyond bones, with times. You can use: a white or coloured flash on the whole body when this character is hit or powers up (never on its own attacks); tints and alpha fades on slots; swapping a slot's attachment (an angry or hurt face, hiding a part); bringing slots in front of or behind the body (the weapon arm in front during the swing); glowing trails behind the weapon bone, only for big weapon swings (slashes, chops, spins, slams) or dramatic action hits, never for dances, idles, emotes, taunts, walks or small moves; shear on a bone for a smear on the fastest frame; and a root jolt for screen shake. Pick the 2–4 that fit, don't use them all.

2D action animation best practices:
- Game feel: split attacks into startup, active and recovery. Startup (anticipation) about 25–35% of the time, active frames short (0.06–0.13 s, 2–4 frames at 30 fps), recovery the rest. The strike itself is never the slow part.
- Hit-stop: on contact, freeze the strongest pose for 2–4 frames, then add one or two tiny jolts (5–10 units) on the body before the follow-through.
- Line of action: every hero pose has one clear C or S curve from the head through the spine to the planted foot. Avoid stiff, straight-up-and-down poses.
- Silhouette: in hero poses, keep the arms and weapon clear of the torso so the action reads as a shape. The weapon should be fully visible at the top of the wind-up and at impact.
- Twist: wind up with the hips and shoulders turned against each other, then unwind them into the strike. Power comes from the body, not just the arm.
- Arcs: hands, weapon tips and the head travel in curves. Swing from the shoulder and elbow; don't slide things in straight lines.
- Weight: heavy characters get a longer wind-up, deeper squash, a slower recovery and big impacts; light characters are quicker and spring back sooner. Match the character described.
- Jumps: crouch, stretch on take-off, ease into and out of the apex (hang time), fall faster than the rise, land in a squash deeper than the crouch, then recover.
- Hit reactions: the part that was hit moves first, away from the hit; the head and limbs whip after it, then everything recovers with an overshoot.
- Ready pose: attacks start and end in a combat-ready stance (knees bent, weapon up), never a slack T-pose. Loops return to that same stance.
- Time in frames: put beats on multiples of 1/30 s, and give the eye at least 3–4 frames to read each hero pose.
- Direction: strikes travel the way the character faces, through the space in front of it, never behind its back. Wind-ups go behind and above.
- Give limb poses as screen directions (e.g. "upper arm aims 10°, forearm aims 0°" for a straight punch to the right), not as rotations: the keyframer aims bones directly.
- Hands pinned to the weapon by a constraint (DRIVEN BY … follows the weapon bone) move only with the weapon: such a character can't punch empty-handed, so turn punches into strikes with the weapon (a pommel jab, a hilt bash, a short thrust) and move the weapon bone.
- Punches: the arm straightens toward the target and the body lunges 10–20% of the rig's width behind it, the rear foot pushing. Slashes: the weapon travels a 120–200° arc in front of the body. Keep the torso within about 35° of upright unless the request asks for a flip.
- Facing rotations: when the character faces right, turning a forward-pointing arm counter-clockwise raises it and clockwise lowers it; when it faces left, the reverse. Check every swing against the rest pose.

Use only bones from the list. Bones marked DRIVEN BY can't be keyed; use the bone the note names instead (an IK target moves a whole leg or arm). For a loop, the last beat must flow back into the first pose.`;

const SYSTEM_PROMPT = `You are a senior 2D game animator keyframing a Spine skeleton. You turn the director's beat sheet into keyframes for an existing rig. You can't add bones or change art; you only key the bones listed.

How Spine animation works here:
- Each bone has a setup (rest) pose. Keys are offsets from that rest pose, and the runtime interpolates between keys.
- Bones are a hierarchy: rotating a bone swings all its children with it.
- Bones marked DRIVEN BY are controlled by a constraint; never key them. Key the bone the note names instead: moving an IK target bends the whole leg or arm.

Units (screen space, the same as the bone positions you're given):
- rotate: two ways. "aim": the direction the bone points on screen at that moment, whatever its parents do: 0 = right, 90 = up, 180 = left, -90 = down (the bone list gives each bone's rest direction). Use aim for limbs, hands, weapons and the head in key poses: a punch is the upper arm and forearm aimed straight at the target. Or "deg": degrees counter-clockwise added to the rest pose, 0 = rest, for small relative wobbles. Use one kind per bone.
- move: offset from the rest position in skeleton units, +x right, +y up. 0, 0 = rest.
- scale: multiplier on the bone's width (x) and height (y) as seen on screen. 1, 1 = rest. Use it for squash and stretch.
- shear: degrees of skew on the bone's own x and y axes. 0, 0 = rest. 15–35° on a weapon or limb for one or two frames at the fastest point of a swing reads as a smear.

Each key has an ease: how the motion arrives at that key from the previous one. This is where the energy comes from:
- "snap": accelerates hard into this key. The hit of a punch or slash, throws, drops, landings.
- "settle": arrives fast and slows into this key. Wind-ups, arriving in a pose, recoils, returning from an overshoot.
- "smooth": flows through this key. Continuous motion: grooves, waves, cloth and hair.
- "linear": constant speed. Spins and mechanical motion.
To hold a pose, repeat nearly the same values on a second key later (e.g. impact at 0.52 s, almost the same values at 0.66 s); use exactly the same values only for a hit-stop.

Rules:
- Follow the beat sheet: hit its timings, poses and numbers. Key the hero poses first, then breakdowns between them.
- Contrast is everything: slow wind-ups ("settle"), fast actions ("snap", 0.06–0.2 s), short holds on impact, then a decelerating follow-through.
- Never key all bones on the same times. Offset chained bones 0.03–0.08 s so motion ripples through the body; secondary parts (hair, cloth, tails, capes, loose gear) 0.08–0.15 s behind, swinging wider, then overshooting the rest pose once or twice before settling.
- After every big move, overshoot the target by 10–25% and settle back.
- Main bones get 5–12 keys; secondary bones as many as their follow-through needs.
- Don't shrink the director's numbers. Bold and readable beats safe and small.
- Keep the root still unless the request travels; hops and lunges move the hips or body bone.
- Body tilt: keep the hips and torso within about 35° of upright and the head readable, unless the request asks for a flip or spin. Tumbling the whole body reads as falling, not attacking.

Spine technique:
- Rotate limbs, don't move them. Use move only on the hips or body bone, IK targets and the root. Moving an arm, hand, head or weapon bone pulls it off its joint and opens gaps in the art.
- Feet: while the character stands, keep the foot IK targets at 0, 0 so the feet stay planted and the knees bend as the body moves. Move a foot target only for steps, kicks and jumps. Keep each foot within its leg's reach of the hips (about 90% of the leg's length), or the leg snaps straight and pops.
- Angles: keep each bone's rotate values continuous (going from 170 to 190 is fine; jumping to -170 spins the bone all the way round). Change rotation by at most about 120° between two neighbouring keys unless the move really is a full spin.
- Moving holds: in a held pose, let the main bones drift 2–5% (a degree or two, a few units) so the pose stays alive. Only a hit-stop freezes completely.
- Squash and stretch: scale only the hips or body bone and maybe a weapon bone, at most about 15–25%, and keep the volume (when y goes down to 0.85, x goes up to about 1.15). Scaling a limb shears everything attached below it.
- Chains: for hair, tails, cloth and capes, delay each bone a little more than the one above it and give it a bigger swing, so a wave rolls down the chain.
- Keys: put keys at least 1/30 s apart and on multiples of 1/30 s where you can.
- Start every timeline with a key at time 0. For a looping animation, every bone's last key (at the full duration) must equal its first key.

Effects (optional; use the ones the beat sheet calls for):
- "flash": a burst of colour over the whole body at a time, "strength" 0.2–0.5, held for "hold" (at most 2 frames) then fading over "fade". Only when this character is hit, powers up, transforms or teleports; never on its own attacks (that washes the attacker out; trails and hit-stop sell an attack). At most two.
- "slots": per slot, "color" keys tint it and set its alpha (rrggbbaa; ffffffff = normal, alpha 00 = invisible) and "attachment" keys swap what it shows (a name from its list, or null to hide it). Fade alpha only for blinks, teleports, dodges and vanishing; otherwise keep every slot fully opaque. Never hide the weapon.
- "drawOrder": at time t, put slots in "front" of everything or at the "back"; a key with empty lists restores the normal order. An arm or weapon drawn behind the torso is hidden when it strikes across the body: bring its slots to the front just before the strike and restore the order after the recovery.
- "trails": glowing afterimages behind a bone's art while it moves fast. Only for big weapon swings (slashes, chops, spins, slams) or dramatic action hits; leave them out of dances, idles, emotes, taunts, walks and small moves, even when the beat sheet mentions them. Name the bone the weapon hangs from; give a colour (rrggbb) and 2–4 ghosts.
Slots are listed with what they can show.

Reply with JSON only, no markdown:
{"name": "<short animation name, 1–3 words>", "notes": "<one or two sentences for the user on what you animated>", "bones": [{"bone": "<bone name>", "rotate": [{"t": 0, "aim": 60}, {"t": 0.4, "aim": 150, "ease": "settle"}, {"t": 0.52, "aim": -20, "ease": "snap"}], "move": [{"t": 0, "x": 0, "y": 0}], "scale": [{"t": 0, "x": 1, "y": 1, "ease": "smooth"}], "shear": [{"t": 0.5, "x": 0, "y": 25}]}], "flash": [{"t": 0.52, "color": "ffffff", "slots": "all", "hold": 0.03, "fade": 0.15}], "slots": [{"slot": "<slot name>", "color": [{"t": 0, "color": "ffffffff"}], "attachment": [{"t": 0.3, "name": "<attachment>"}]}], "drawOrder": [{"t": 0.3, "front": ["<slot>"], "back": []}, {"t": 0.8, "front": [], "back": []}], "trails": [{"bone": "<weapon bone>", "color": "ffcc66", "count": 3}]}
Each bone entry needs at least one of rotate, move, scale or shear; leave out the ones it doesn't use, and leave out effects you don't use. "t" is seconds from 0 to the duration. "ease" is optional and defaults to "smooth"; the first key's ease is ignored.`;

function userMessage(input: AnimateInput, rig: Rig, skeleton: Record<string, unknown>, plan: string | null): string {
  return [
    `Request: ${input.prompt}`,
    ...(plan ? ["", "Director's beat sheet:", plan, ""] : []),
    `Duration: ${input.durationSec} s. ${input.loop ? "Loops: yes, the last key of every timeline must match its first." : "Loops: no, it plays once."}`,
    `Rig size: ${r1(rig.width)} × ${r1(rig.height)} skeleton units.`,
    "",
    "Bones (setup pose, screen space, +y up):",
    ...describeBones(rig),
    "",
    "Slots (draw order from back to front):",
    ...describeSlots(readSlots(skeleton)),
    "",
    "The rig's own animations (largest motion per bone; moves here are in each bone's local space, so use them for scale only):",
    ...describeAnimations(skeleton),
  ].join("\n");
}

/** Has Muse Spark write the animation and saves it into the remix's skeleton as a new animation. */
export async function generateAnimation(asset: AssetRow, input: AnimateInput, signal: AbortSignal): Promise<AnimateResult> {
  if (!asset.files) throw new AnimateError("This remix has no files to animate.", 404);
  const skeleton = await loadSkeleton(asset.files.skeleton, input.skeleton, signal);
  return animateSkeleton(asset.id, skeleton, input, signal, (built, next) => save(asset, next, built, input));
}

/**
 * Has Muse Spark plan and key an animation for `skeleton` and checks it, then hands it to `keep`
 * (generateAnimation saves it; scripts can just look at it). Every run is saved to
 * ANIMATION_LOG_DIR (see saveRun), including failed ones.
 */
export async function animateSkeleton<T>(
  logId: string,
  skeleton: Record<string, unknown>,
  input: AnimateInput,
  signal: AbortSignal,
  keep: (built: BuiltAnimation, skeleton: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const rig = readRig(skeleton);
  if (rig.bones.size === 0) throw new AnimateError("This rig has no bones to animate.");

  const run: RunLog = { assetId: logId, startedAt: new Date().toISOString(), model: MUSE_MODEL, input: { ...input, skeleton: null }, attempts: [] };
  const started = Date.now();
  try {
    run.planRequest = userMessage(input, rig, skeleton, null);
    const plan = (await callMuse("plan", PLAN_SYSTEM_PROMPT, run.planRequest, input.images, signal, run))?.trim().slice(0, 4000);
    if (!plan) throw new AnimateError("Muse couldn't plan the animation. Try again.", 502);
    run.plan = plan;

    const request = (run.request = userMessage(input, rig, skeleton, plan));
    let finished = null;
    // One retry when the reply can't be used: a text call is cheap, and a bad JSON reply is the common failure.
    for (let attempt = 0; attempt < 2 && !finished; attempt++) {
      const retryNote = attempt > 0 ? "\n\nYour last reply couldn't be used (not valid JSON, or no listed bone was keyed). Reply with the JSON object only." : "";
      const content = await callMuse("keys", SYSTEM_PROMPT, request + retryNote, input.images, signal, run);
      finished = content === null ? null : finishAnimation(skeleton, input, plan, content);
    }
    if (!finished) throw new AnimateError("Muse's animation came back unreadable. Try again or reword the request.", 502);
    const { built, next } = finished;
    run.result = { name: built.name, notes: built.notes, dropped: built.dropped, animation: record(record(next.animations)[built.name]) };

    return await keep(built, next);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.durationMs = Date.now() - started;
    await saveRun(run);
  }
}

/**
 * Turns Muse's keyframe reply into the finished skeleton: keys checked and converted, aims
 * resolved, torso tilt limited, effects and trails added. Null when the reply is unusable.
 * Exported so test scripts can replay saved replies through changed code without new calls.
 */
export function finishAnimation(skeleton: Record<string, unknown>, input: AnimateInput, plan: string, content: string) {
  const rig = readRig(skeleton);
  const built = buildAnimation(content, rig, skeleton, input, new Set(Object.keys(record(skeleton.animations))), plan);
  if (!built) return null;
  // The whole skeleton with the animation in it: trails add bones and slots to the setup pose.
  const next: Record<string, unknown> = structuredClone(skeleton);
  next.animations = { ...record(next.animations), [built.name]: built.animation };
  resolveAims(next, built.name, built.aims, input);
  const core = tameTilt(next, built.name, input);
  if (core) resolveAims(next, built.name, new Map([...built.aims].filter(([bone]) => !core.has(bone))), input);
  built.dropped.push(...applyFx(next, built.name, built.fx, input.durationSec, input.loop));
  return { built, next };
}

/** The stored skeleton JSON. A binary .skel can't be read here, so the page converts it and sends it. */
async function loadSkeleton(key: string, sent: Record<string, unknown> | null, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!key.toLowerCase().endsWith(".json")) {
    if (!sent) throw new AnimateError("This rig is stored as a binary .skel file; send it as JSON with the request.");
    return sent;
  }
  const res = await fetch(objectUrl(key), { signal });
  if (!res.ok) throw new Error(`Couldn't read skeleton ${key} (${res.status})`);
  const skeleton = parseSkeleton(await res.json());
  if (!skeleton) throw new Error(`Skeleton ${key} isn't a Spine skeleton JSON`);
  return skeleton;
}

async function callMuse(step: "plan" | "keys", system: string, request: string, images: string[], signal: AbortSignal, run: RunLog): Promise<string | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) animate ${step} system`, system);
  logPrompt(`chat/completions (${MUSE_MODEL}) animate ${step} user`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      reasoning_effort: ANIMATE_REASONING_EFFORT,
      // Long keyframe replies sometimes had stray words in the middle of the JSON.
      ...(step === "keys" ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: images.length ? [{ type: "text", text: request }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : request,
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    run.attempts.push({ step, status: res.status, responseBody: body });
    console.error(`Muse animate request failed (${res.status})`, body);
    throw new AnimateError("Muse couldn't write the animation. Try again.", 502);
  }
  const body: unknown = await res.json();
  run.attempts.push({ step, status: res.status, responseBody: body });
  const content = getPath(body, ["choices", 0, "message", "content"]);
  logPrompt(`chat/completions (${MUSE_MODEL}) animate ${step} reply`, typeof content === "string" ? content : "(no content)");
  return typeof content === "string" ? content : null;
}

// ---------------------------------------------------------------------------
// Turning Muse's keys into a Spine animation
// ---------------------------------------------------------------------------

const EASES = ["smooth", "snap", "settle", "linear"] as const;
type Ease = (typeof EASES)[number];
interface Key {
  t: number;
  v: number[];
  /**
   * How the value arrives at this key from the previous one. Spark read a "from this key to the
   * next" ease as "arriving here", and its holds froze the rest pose, so the ease is on the arrival.
   */
  ease: Ease;
}

/** Normalised Bézier handles (x1, y1, x2, y2) for the eased curves: cubic ease-in and ease-out. */
const EASE_HANDLES = { snap: [0.55, 0, 0.9, 0.35], settle: [0.1, 0.65, 0.45, 1] } as const;

function readEase(value: unknown, fallback: Ease): Ease {
  return EASES.find((e) => e === value) ?? fallback;
}

export interface BuiltAnimation {
  name: string;
  notes: string;
  plan: string;
  dropped: string[];
  fx: Fx;
  /** Rotation keys given as screen directions, per bone; resolved to local rotations by resolveAims. */
  aims: Map<string, Key[]>;
  animation: { bones: Record<string, Record<string, unknown[]>> };
}

/** Muse's reply is untrusted: keep only animatable bones, clamp every value, and close loops. */
function buildAnimation(content: string, rig: Rig, skeleton: Record<string, unknown>, input: AnimateInput, existing: Set<string>, plan: string): BuiltAnimation | null {
  const parsed = parseLooseJson(content);
  if (parsed === null) return null;

  const maxMove = Math.max(rig.width, rig.height, 100) * MAX_MOVE_SHARE;
  const dropped: string[] = [];
  const aims = new Map<string, Key[]>();
  const bones: BuiltAnimation["animation"]["bones"] = {};
  for (const entry of list(getPath(parsed, ["bones"]))) {
    const e = record(entry);
    const name = typeof e.bone === "string" ? e.bone : null;
    const bone = name && !name.startsWith(FX_PREFIX) ? rig.bones.get(name) : undefined;
    if (!bone) {
      if (name) dropped.push(`${name.slice(0, 60)}: not a bone in this rig`);
      continue;
    }
    if (bone.drivenBy) {
      dropped.push(`${bone.name}: driven by ${bone.drivenBy.split(":")[0]}`);
      continue;
    }
    // A bone-wide ease (the old reply format) is the default for keys that don't set their own.
    const ease = readEase(e.ease, "smooth");
    const flip = bone.parent && det(bone.parent.m) < 0 ? -1 : 1;
    const parentInverse = invert(bone.parent?.m ?? [1, 0, 0, 1]);
    const timelines: Record<string, unknown[]> = {};

    // "aim" keys give the direction the bone points on screen. Relative "deg" keys left Spark
    // adding up parent rotations in its head, and its punches went up instead of forward.
    const rotateKeys = list(e.rotate);
    const aimed = rotateKeys.some((k) => typeof record(k).aim === "number");
    const rotate = aimed
      ? readKeys(rotateKeys.filter((k) => typeof record(k).aim === "number").map((k) => ({ ...record(k), deg: record(k).aim })), ["deg"], [Number.NaN], ease, input, (v) => [clamp(v[0], -720, 720)], false)
      : readKeys(rotateKeys, ["deg"], [0], ease, input, (v) => [clamp(v[0], -360, 360)]);
    if (rotate && aimed) aims.set(bone.name, rotate);
    else if (rotate) timelines.rotate = toTimeline(rotate, input.loop, (k) => ({ value: round(k[0] * flip) }), (k) => [k[0] * flip]);

    const move = readKeys(e.move, ["x", "y"], [0, 0], ease, input, (v) => [clamp(v[0], -maxMove, maxMove), clamp(v[1], -maxMove, maxMove)]);
    if (move && parentInverse) {
      // Screen-space offsets → the parent's local space, which is what Spine's translate keys are in.
      const local = (k: number[]) => [parentInverse[0] * k[0] + parentInverse[1] * k[1], parentInverse[2] * k[0] + parentInverse[3] * k[1]];
      timelines.translate = toTimeline(move, input.loop, (k) => { const [x, y] = local(k); return { x: round(x), y: round(y) }; }, local);
    }

    const scale = readKeys(e.scale, ["x", "y"], [1, 1], ease, input, (v) => v.map((s) => clamp(s, SCALE_LIMITS.min, SCALE_LIMITS.max)));
    // Spine scales along the bone's own axes. For a bone that points more up or down than sideways
    // (a torso), its x axis is screen height, so the screen-space pair swaps.
    const upright = Math.abs(bone.m[2]) > Math.abs(bone.m[0]);
    const boneAxes = (k: number[]) => (upright ? [k[1], k[0]] : k);
    if (scale) timelines.scale = toTimeline(scale, input.loop, (k) => { const [x, y] = boneAxes(k); return { x: round(x), y: round(y) }; }, boneAxes);

    const shear = readKeys(e.shear, ["x", "y"], [0, 0], ease, input, (v) => v.map((d) => clamp(d, -SHEAR_LIMIT, SHEAR_LIMIT)));
    if (shear) timelines.shear = toTimeline(shear, input.loop, (k) => ({ x: round(k[0]), y: round(k[1]) }), (k) => k);

    if (Object.keys(timelines).length > 0 || aims.has(bone.name)) bones[bone.name] = timelines;
  }
  if (Object.keys(bones).length === 0) return null;

  const snap = (t: number) => Math.round(Math.min(Math.round(clamp(t, 0, input.durationSec) * FPS) / FPS, input.durationSec) * 10000) / 10000;
  const boneNames = new Set([...rig.bones.keys()].filter((n) => !n.startsWith(FX_PREFIX)));
  const fx = readFx(parsed, readSlots(skeleton), boneNames, input.durationSec, input.loop, snap, dropped);
  const notes = getPath(parsed, ["notes"]);
  return {
    name: uniqueName(getPath(parsed, ["name"]), existing),
    notes: typeof notes === "string" ? notes.replace(/\s+/g, " ").trim().slice(0, 400) : "",
    plan,
    dropped,
    fx,
    aims,
    animation: { bones },
  };
}

/**
 * Turns aim keys (screen directions) into local rotate keys. Bones are done parents first, each
 * after posing the animation so far in the Spine runtime, so a forearm's aim allows for where the
 * upper arm has swung to at that moment.
 */
function resolveAims(skeleton: Record<string, unknown>, animName: string, aims: Map<string, Key[]>, input: AnimateInput) {
  if (aims.size === 0) return;
  const animation = record(record(skeleton.animations)[animName]);
  const bones = record(animation.bones);
  animation.bones = bones;
  for (const name of list(skeleton.bones).map((b) => String(record(b).name)).filter((n) => aims.has(n))) {
    const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
    const sk = new spine.Skeleton(data);
    const anim = data.findAnimation(animName);
    const bone = sk.findBone(name);
    if (!anim || !bone) continue;
    const keys: Key[] = [];
    let previous: number | null = null;
    for (const k of aims.get(name) ?? []) {
      sk.setToSetupPose();
      anim.apply(sk, 0, k.t, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      sk.updateWorldTransform(spine.Physics.pose);
      const parent = bone.parent;
      const parentRotation = parent ? parent.getWorldRotationX() : 0;
      const flip = parent && parent.a * parent.d - parent.b * parent.c < 0 ? -1 : 1;
      let v = (k.v[0] - parentRotation) * flip - bone.data.rotation;
      v = ((((v + 180) % 360) + 360) % 360) - 180;
      while (previous !== null && v - previous > 180) v -= 360;
      while (previous !== null && v - previous < -180) v += 360;
      keys.push({ t: k.t, v: [v], ease: k.ease });
      previous = v;
    }
    if (keys.length === 0) continue;
    if (keys[0].t > 0) keys.unshift({ t: 0, v: [0], ease: "smooth" });
    if (input.loop) {
      const last = keys[keys.length - 1];
      if (last.t >= input.durationSec) last.v = keys[0].v;
      else keys.push({ t: input.durationSec, v: keys[0].v, ease: "settle" });
    }
    bones[name] = { ...record(bones[name]), rotate: toTimeline(keys, input.loop, (k) => ({ value: round(k[0]) }), (k) => k) };
  }
}

/** Requests that may turn the whole body over. */
const FLIP_WORDS = /\b(flip|spin|somersault|cartwheel|roll|tumble|twirl|backflip|frontflip|360)\b/i;
/** How far the chest may tilt from its rest angle, in degrees, unless the request asks for a flip. */
const MAX_TILT = 45;

/**
 * Spark tumbled whole bodies (a "meteor slash" pitched the orc onto its side) even when told to
 * stay within about 35° of upright. The core bones carry most of the art; if the deepest of them
 * (the chest) tilts past MAX_TILT at any frame, every core bone's rotate keys are scaled down to
 * fit. Returns the core bones when it scaled them (their children's aims need resolving again).
 */
function tameTilt(skeleton: Record<string, unknown>, animName: string, input: AnimateInput): Set<string> | null {
  if (FLIP_WORDS.test(input.prompt)) return null;
  const core = coreBones(skeleton);
  const chest = core[core.length - 1];
  if (!chest) return null;

  const data = new spine.SkeletonJson(stubLoader).readSkeletonData(JSON.stringify(skeleton));
  const sk = new spine.Skeleton(data);
  const anim = data.findAnimation(animName);
  const bone = sk.findBone(chest);
  if (!anim || !bone) return null;
  sk.setToSetupPose();
  sk.updateWorldTransform(spine.Physics.pose);
  const rest = bone.getWorldRotationX();
  let worst = 0;
  for (let f = 0; f <= Math.round(input.durationSec * FPS); f++) {
    sk.setToSetupPose();
    anim.apply(sk, 0, Math.min(f / FPS, input.durationSec), false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    sk.updateWorldTransform(spine.Physics.pose);
    worst = Math.max(worst, Math.abs(((bone.getWorldRotationX() - rest + 540) % 360) - 180));
  }
  if (worst <= MAX_TILT) return null;
  const factor = MAX_TILT / worst;
  const bones = record(record(record(skeleton.animations)[animName]).bones);
  for (const name of core) {
    const rotate = list(record(bones[name]).rotate).map(record);
    for (const key of rotate) {
      if (typeof key.value === "number") key.value = round(key.value * factor);
      // Bezier handles hold absolute values too (every second number after the time).
      if (Array.isArray(key.curve)) key.curve = key.curve.map((v: unknown, i: number) => (i % 2 === 1 && typeof v === "number" ? round(v * factor) : v));
    }
  }
  return new Set(core);
}

/**
 * The JSON object in Muse's reply. Long replies have had stray words between values
 * (`…]} credible:1], …`), so on a syntax error the text from the error to the next `,`, `]` or `}`
 * is dropped and parsing tried again, a few times.
 */
function parseLooseJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let text = content.slice(start, end + 1);
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return JSON.parse(text);
    } catch (error) {
      const at = /position (\d+)/.exec(error instanceof Error ? error.message : "");
      if (!at) return null;
      const from = Number(at[1]);
      const rest = text.slice(from).search(/[,\]}]/);
      if (rest <= 0) return null;
      text = text.slice(0, from) + text.slice(from + rest);
    }
  }
  return null;
}

/**
 * Sorted keys with times clamped to the duration, a key at 0 (rest when Muse left it out) and, for
 * loops, a last key at the duration equal to the first. Null when the timeline never leaves rest.
 */
function readKeys(
  value: unknown,
  fields: string[],
  rest: number[],
  ease: Ease,
  input: AnimateInput,
  clampValues: (v: number[]) => number[],
  /** False for aim keys, which have no rest value here: they're padded once resolved. */
  padRest = true,
): Key[] | null {
  const byTime = new Map<number, { v: number[]; ease: Ease }>();
  for (const raw of list(value).slice(0, MAX_KEYS * 2)) {
    const k = record(raw);
    const t = num(k.t, Number.NaN);
    if (Number.isNaN(t)) continue;
    // On 30 fps frames, as game animation is timed; Spark only lands about a third of its keys there.
    const time = Math.round(Math.min(Math.round(clamp(t, 0, input.durationSec) * FPS) / FPS, input.durationSec) * 10000) / 10000;
    byTime.set(time, { v: clampValues(fields.map((f, i) => num(k[f], rest[i]))), ease: readEase(k.ease, ease) });
  }
  const keys = [...byTime].map(([t, k]) => ({ t, ...k })).sort((a, b) => a.t - b.t).slice(0, MAX_KEYS);
  if (!padRest) return keys.length ? keys : null;
  if (keys.length === 0 || keys.every((k) => k.v.every((v, i) => Math.abs(v - rest[i]) < 1e-3))) return null;
  if (keys[0].t > 0) keys.unshift({ t: 0, v: rest, ease: "smooth" });
  if (input.loop) {
    const last = keys[keys.length - 1];
    if (last.t >= input.durationSec) last.v = keys[0].v;
    else keys.push({ t: input.durationSec, v: keys[0].v, ease: "settle" });
  }
  return keys;
}

/**
 * Spine 4.2 keys with one Bézier curve per segment, set by the ease of the key it arrives at. Spine
 * stores a segment's curve on its first key. "smooth" uses Catmull-Rom tangents so motion flows
 * through keys (a loop's ends share one tangent so it doesn't hitch); "snap" and "settle" are cubic
 * ease-in and ease-out.
 * `channels` maps a key to the values the curve interpolates (after any conversion to local space).
 */
function toTimeline(keys: Key[], loop: boolean, fields: (v: number[]) => Record<string, number>, channels: (v: number[]) => number[]): unknown[] {
  const times = keys.map((k) => k.t);
  const values = keys.map((k) => channels(k.v));
  const n = keys.length;
  const tangents = values[0].map((_, c) => {
    const v = values.map((vs) => vs[c]);
    return v.map((_, i) => {
      if (i > 0 && i < n - 1) return (v[i + 1] - v[i - 1]) / (times[i + 1] - times[i - 1]);
      if (loop && n > 2) return (v[1] - v[n - 2]) / (times[1] - times[0] + times[n - 1] - times[n - 2]);
      return 0;
    });
  });

  return keys.map((k, i) => {
    const key: Record<string, unknown> = { time: k.t, ...fields(k.v) };
    if (i === n - 1) return key;
    const ease = keys[i + 1].ease;
    if (ease === "linear") return key;
    const dt = times[i + 1] - times[i];
    if (ease === "snap" || ease === "settle") {
      const [x1, y1, x2, y2] = EASE_HANDLES[ease];
      key.curve = values[i].flatMap((v0, c) => {
        const dv = values[i + 1][c] - v0;
        return [round4(times[i] + x1 * dt), round(v0 + y1 * dv), round4(times[i] + x2 * dt), round(v0 + y2 * dv)];
      });
      return key;
    }
    key.curve = tangents.flatMap((m, c) => [
      round4(times[i] + dt / 3),
      round(values[i][c] + (m[i] * dt) / 3),
      round4(times[i + 1] - dt / 3),
      round(values[i + 1][c] - (m[i + 1] * dt) / 3),
    ]);
    return key;
  });
}

function uniqueName(value: unknown, existing: Set<string>): string {
  const cleaned = typeof value === "string" ? value.replace(/[^\w -]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const base = cleaned || "generated";
  let name = base;
  for (let i = 2; existing.has(name); i++) name = `${base} ${i}`;
  return name;
}

const det = (m: Matrix) => m[0] * m[3] - m[1] * m[2];

function invert(m: Matrix): Matrix | null {
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d];
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const round = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save(asset: AssetRow, skeleton: Record<string, unknown>, built: BuiltAnimation, input: AnimateInput): Promise<AnimateResult> {
  // Re-read the row: if the skeleton was saved from the tweak panel or a part fix meanwhile,
  // writing ours would throw those edits away.
  const current = await getAssetRow(asset.id, asset.owner_id);
  if (!current?.files) throw new AnimateError("The remix was deleted while the animation was being written.", 404);
  if (current.files.skeleton !== asset.files?.skeleton) {
    throw new AnimateError("The remix was saved while Muse was animating. Try again so the animation builds on your latest edits.", 409);
  }

  const next = skeleton;
  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_anim_${randomUUID().slice(0, 8)}`;
  const key = await putFile(folder, "skeleton.json", JSON.stringify(next));
  const animation = { name: built.name, durationSec: input.durationSec, loop: input.loop };
  const row = check(
    await db()
      .from("assets")
      .update({ files: { ...current.files, skeleton: key }, animations: [...current.animations, animation], rig_hash: rigHashOf(next) })
      .eq("id", asset.id)
      .select(ASSET_COLUMNS)
      .single()
      .overrideTypes<AssetRow, { merge: false }>(),
  );
  return { asset: toSpineAsset(row), animation, notes: built.notes, plan: built.plan, dropped: built.dropped };
}

/** One run, as saved to run.json. */
interface RunLog {
  assetId: string;
  startedAt: string;
  model: string;
  input: AnimateInput;
  /** The user messages of the planning call and the keyframing call. */
  planRequest?: string;
  request?: string;
  plan?: string;
  /** HTTP status and full body (parsed JSON, or text on errors) of each Muse response. */
  attempts: { step: "plan" | "keys"; status: number; responseBody: unknown }[];
  result?: Pick<BuiltAnimation, "name" | "notes" | "dropped"> & { animation: unknown };
  error?: string;
  durationMs?: number;
}

/**
 * Writes <ANIMATION_LOG_DIR>/<time>_<assetId>/: system-prompts.txt and run.json (input, the rig
 * description and beat sheet Muse saw, its raw replies, the built animation or the error). Logging must never
 * fail the request, so errors are only reported.
 */
async function saveRun(run: RunLog) {
  try {
    const folder = path.join(ANIMATION_LOG_DIR, `${run.startedAt.replace(/[:.]/g, "-")}_${run.assetId.replace(/[^\w-]/g, "_").slice(0, 80)}`);
    await mkdir(folder, { recursive: true });
    await Promise.all([
      writeFile(path.join(folder, "system-prompts.txt"), `PLAN\n\n${PLAN_SYSTEM_PROMPT}\n\nKEYS\n\n${SYSTEM_PROMPT}`),
      writeFile(path.join(folder, "run.json"), JSON.stringify(run, null, 2)),
    ]);
    console.log(`[animate] saved run to ${folder}`);
  } catch (error) {
    console.error("Couldn't save the animation run log", error);
  }
}

