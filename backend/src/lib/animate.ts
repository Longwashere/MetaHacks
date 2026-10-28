import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiFetch } from "./ai-fetch.js";
import { getAssetRow } from "./assets.js";
import { ANIMATION_LOG_DIR, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "./config.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow } from "./db.js";
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
/** Moves are capped at this share of the rig's larger side. */
const MAX_MOVE_SHARE = 0.6;
const SCALE_LIMITS = { min: 0.2, max: 3 };

export function parseAnimateInput(body: unknown): AnimateInput | { error: string } {
  const prompt = getPath(body, ["prompt"]);
  const durationSec = getPath(body, ["durationSec"]);
  const loop = getPath(body, ["loop"]);
  const skeleton = getPath(body, ["skeleton"]) ?? null;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) {
    return { error: `Describe the animation in 1–${MAX_PROMPT} characters.` };
  }
  if (typeof durationSec !== "number" || !(durationSec >= DURATION_LIMITS.min && durationSec <= DURATION_LIMITS.max)) {
    return { error: `The length must be ${DURATION_LIMITS.min}–${DURATION_LIMITS.max} seconds.` };
  }
  if (typeof loop !== "boolean") return { error: "Say whether the animation loops." };
  const parsedSkeleton = skeleton === null ? null : parseSkeleton(skeleton);
  if (skeleton !== null && !parsedSkeleton) return { error: "The skeleton sent with the request isn't a Spine skeleton JSON." };
  return { prompt: prompt.trim(), durationSec: Math.round(durationSec * 100) / 100, loop, skeleton: parsedSkeleton };
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
  return [...rig.bones.values()].map((b) => {
    const angle = Math.round(Math.atan2(b.m[2], b.m[0]) / DEG);
    const where = b.length > 0
      ? `from (${r1(b.x)}, ${r1(b.y)}) to (${r1(b.tipX)}, ${r1(b.tipY)}), points ${angle}°`
      : `at (${r1(b.x)}, ${r1(b.y)})`;
    return [
      `- ${b.name}`,
      b.parent ? `parent ${b.parent.name}` : "root",
      where,
      b.slots.length ? `carries ${b.slots.slice(0, 6).join(", ")}${b.slots.length > 6 ? "…" : ""}` : null,
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

Write, in plain text under 250 words, no JSON:
1. FEEL: one line on the energy and weight (heavy, explosive, sloppy, proud, twitchy…).
2. BEATS: 4–8 lines, each "start–end s · BEAT · what happens", naming the bones to move with concrete numbers (degrees, units). For actions use: anticipation (wind up opposite to the action, 20–35% of the time, slower), the action itself (fast: 0.06–0.2 s), an impact hold on the strongest pose (0.08–0.2 s), follow-through past the end pose, then a settle. For dances and idles, name the accent beats and a groove with rhythm and variation, not a plain back-and-forth.
3. HERO POSES: the 2–4 extreme poses as strong silhouettes with big numbers. Exaggerate: the rig's own attack and hit ranges are a floor for action, not a ceiling. Weapons travel in wide arcs (90–180°), jumps leave the ground by 20–40% of the rig's height, and the body squashes (scale about 1.1 x, 0.85 y) on crouches and landings and stretches at launch.
4. OVERLAP: which bone leads and how the rest follow (hips → chest → shoulder → elbow → hand or weapon, 0.03–0.08 s apart; hair, cloth and tails 0.08–0.15 s behind with a bigger swing and an overshoot).

Use only bones from the list. Bones marked DRIVEN BY can't be keyed; use the bone the note names instead (an IK target moves a whole leg or arm). For a loop, the last beat must flow back into the first pose.`;

const SYSTEM_PROMPT = `You are a senior 2D game animator keyframing a Spine skeleton. You turn the director's beat sheet into keyframes for an existing rig. You can't add bones or change art; you only key the bones listed.

How Spine animation works here:
- Each bone has a setup (rest) pose. Keys are offsets from that rest pose, and the runtime interpolates between keys.
- Bones are a hierarchy: rotating a bone swings all its children with it.
- Bones marked DRIVEN BY are controlled by a constraint; never key them. Key the bone the note names instead: moving an IK target bends the whole leg or arm.

Units (screen space, the same as the bone positions you're given):
- rotate: degrees counter-clockwise on screen, added to the rest pose. 0 = rest.
- move: offset from the rest position in skeleton units, +x right, +y up. 0, 0 = rest.
- scale: multiplier on the bone's width (x) and height (y) as seen on screen. 1, 1 = rest. Use it for squash and stretch.

Each key has an ease: how the motion arrives at that key from the previous one. This is where the energy comes from:
- "snap": accelerates hard into this key. The hit of a punch or slash, throws, drops, landings.
- "settle": arrives fast and slows into this key. Wind-ups, arriving in a pose, recoils, returning from an overshoot.
- "smooth": flows through this key. Continuous motion: grooves, waves, cloth and hair.
- "linear": constant speed. Spins and mechanical motion.
To hold a pose, repeat the same values on a second key later (e.g. impact at 0.52 s, same values at 0.66 s).

Rules:
- Follow the beat sheet: hit its timings, poses and numbers. Key the hero poses first, then breakdowns between them.
- Contrast is everything: slow wind-ups ("settle"), fast actions ("snap", 0.06–0.2 s), short holds on impact, then a decelerating follow-through.
- Never key all bones on the same times. Offset chained bones 0.03–0.08 s so motion ripples through the body; secondary parts (hair, cloth, tails, capes, loose gear) 0.08–0.15 s behind, swinging wider, then overshooting the rest pose once or twice before settling.
- After every big move, overshoot the target by 10–25% and settle back.
- Main bones get 5–12 keys; secondary bones as many as their follow-through needs.
- Don't shrink the director's numbers. Bold and readable beats safe and small.
- Keep the root still unless the request travels; hops and lunges move the hips or body bone.
- Start every timeline with a key at time 0. For a looping animation, every bone's last key (at the full duration) must equal its first key.

Reply with JSON only, no markdown:
{"name": "<short animation name, 1–3 words>", "notes": "<one or two sentences for the user on what you animated>", "bones": [{"bone": "<bone name>", "rotate": [{"t": 0, "deg": 0}, {"t": 0.4, "deg": 35, "ease": "settle"}, {"t": 0.52, "deg": -90, "ease": "snap"}], "move": [{"t": 0, "x": 0, "y": 0}], "scale": [{"t": 0, "x": 1, "y": 1, "ease": "smooth"}]}]}
Each bone entry needs at least one of rotate, move or scale; leave out the ones it doesn't use. "t" is seconds from 0 to the duration. "ease" is optional and defaults to "smooth"; the first key's ease is ignored.`;

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
    "The rig's own animations (largest motion per bone; moves here are in each bone's local space, so use them for scale only):",
    ...describeAnimations(skeleton),
  ].join("\n");
}

/** Has Muse Spark write the animation and saves it into the remix's skeleton as a new animation. */
export async function generateAnimation(asset: AssetRow, input: AnimateInput, signal: AbortSignal): Promise<AnimateResult> {
  if (!asset.files) throw new AnimateError("This remix has no files to animate.", 404);
  const skeleton = await loadSkeleton(asset.files.skeleton, input.skeleton, signal);
  return animateSkeleton(asset.id, skeleton, input, signal, (built) => save(asset, skeleton, built, input));
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
  keep: (built: BuiltAnimation) => Promise<T>,
): Promise<T> {
  const rig = readRig(skeleton);
  if (rig.bones.size === 0) throw new AnimateError("This rig has no bones to animate.");

  const run: RunLog = { assetId: logId, startedAt: new Date().toISOString(), model: MUSE_MODEL, input: { ...input, skeleton: null }, attempts: [] };
  const started = Date.now();
  try {
    run.planRequest = userMessage(input, rig, skeleton, null);
    const plan = (await callMuse("plan", PLAN_SYSTEM_PROMPT, run.planRequest, signal, run))?.trim().slice(0, 4000);
    if (!plan) throw new AnimateError("Muse couldn't plan the animation. Try again.", 502);
    run.plan = plan;

    const request = (run.request = userMessage(input, rig, skeleton, plan));
    const existing = new Set(Object.keys(record(skeleton.animations)));
    let built = null;
    // One retry when the reply can't be used: a text call is cheap, and a bad JSON reply is the common failure.
    for (let attempt = 0; attempt < 2 && !built; attempt++) {
      const retryNote = attempt > 0 ? "\n\nYour last reply couldn't be used (not valid JSON, or no listed bone was keyed). Reply with the JSON object only." : "";
      const content = await callMuse("keys", SYSTEM_PROMPT, request + retryNote, signal, run);
      built = content === null ? null : buildAnimation(content, rig, input, existing, plan);
    }
    if (!built) throw new AnimateError("Muse's animation came back unreadable. Try again or reword the request.", 502);
    run.result = { name: built.name, notes: built.notes, dropped: built.dropped, animation: built.animation };

    return await keep(built);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.durationMs = Date.now() - started;
    await saveRun(run);
  }
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

async function callMuse(step: "plan" | "keys", system: string, request: string, signal: AbortSignal, run: RunLog): Promise<string | null> {
  logPrompt(`chat/completions (${MUSE_MODEL}) animate ${step} system`, system);
  logPrompt(`chat/completions (${MUSE_MODEL}) animate ${step} user`, request);
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: request },
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
  animation: { bones: Record<string, Record<string, unknown[]>> };
}

/** Muse's reply is untrusted: keep only animatable bones, clamp every value, and close loops. */
function buildAnimation(content: string, rig: Rig, input: AnimateInput, existing: Set<string>, plan: string): BuiltAnimation | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }

  const maxMove = Math.max(rig.width, rig.height, 100) * MAX_MOVE_SHARE;
  const dropped: string[] = [];
  const bones: BuiltAnimation["animation"]["bones"] = {};
  for (const entry of list(getPath(parsed, ["bones"]))) {
    const e = record(entry);
    const name = typeof e.bone === "string" ? e.bone : null;
    const bone = name ? rig.bones.get(name) : undefined;
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

    const rotate = readKeys(e.rotate, ["deg"], [0], ease, input, (v) => [clamp(v[0], -360, 360)]);
    if (rotate) timelines.rotate = toTimeline(rotate, input.loop, (k) => ({ value: round(k[0] * flip) }), (k) => [k[0] * flip]);

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

    if (Object.keys(timelines).length > 0) bones[bone.name] = timelines;
  }
  if (Object.keys(bones).length === 0) return null;

  const notes = getPath(parsed, ["notes"]);
  return {
    name: uniqueName(getPath(parsed, ["name"]), existing),
    notes: typeof notes === "string" ? notes.replace(/\s+/g, " ").trim().slice(0, 400) : "",
    plan,
    dropped,
    animation: { bones },
  };
}

/**
 * Sorted keys with times clamped to the duration, a key at 0 (rest when Muse left it out) and, for
 * loops, a last key at the duration equal to the first. Null when the timeline never leaves rest.
 */
function readKeys(value: unknown, fields: string[], rest: number[], ease: Ease, input: AnimateInput, clampValues: (v: number[]) => number[]): Key[] | null {
  const byTime = new Map<number, { v: number[]; ease: Ease }>();
  for (const raw of list(value).slice(0, MAX_KEYS * 2)) {
    const k = record(raw);
    const t = num(k.t, Number.NaN);
    if (Number.isNaN(t)) continue;
    const time = Math.round(clamp(t, 0, input.durationSec) * 10000) / 10000;
    byTime.set(time, { v: clampValues(fields.map((f, i) => num(k[f], rest[i]))), ease: readEase(k.ease, ease) });
  }
  const keys = [...byTime].map(([t, k]) => ({ t, ...k })).sort((a, b) => a.t - b.t).slice(0, MAX_KEYS);
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

  const next = { ...skeleton, animations: { ...record(skeleton.animations), [built.name]: built.animation } };
  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_anim_${randomUUID().slice(0, 8)}`;
  const key = await putFile(folder, "skeleton.json", JSON.stringify(next));
  const animation = { name: built.name, durationSec: input.durationSec, loop: input.loop };
  const row = check(
    await db()
      .from("assets")
      .update({ files: { ...current.files, skeleton: key }, animations: [...current.animations, animation] })
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
  result?: Omit<BuiltAnimation, "animation" | "plan"> & { animation: unknown };
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

