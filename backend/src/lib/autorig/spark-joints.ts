import sharp from "sharp";
import { aiFetch } from "../ai-fetch.js";
import { META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "../config.js";
import { apiKey, getPath, logPrompt } from "../meta.js";
import { cleanGear, GEAR_PARTS, MAX_GEAR, type GearItem } from "./gear.js";
import type { CallRecord, RigTrace } from "./trace.js";
import { JOINT_NAMES, type AutoRigView, type Cutout, type JointName, type Joints, type Point } from "./types.js";

// Muse Spark places the inner joints (AUTO_RIG_PLAN.md, "Finding the joints"). The silhouette
// finder (joints.ts) is reliable at the extremities (head top, fingertips, toes) and weak inside the
// body (shoulders under pauldrons, a neck under a beard, hips under a loincloth), so Spark looks at
// the character on a labelled grid and places those. Its answer is checked in code: a joint off
// the body, a limb that folds back on itself, swapped sides, or limbs out of proportion (a thigh much
// shorter than its shin, a hip far from the pelvis's height) are fixed or fall back to the
// silhouette's guess, and are flagged for the user. In the same call Spark lists the character's gear (cape, pauldrons,
// kneepads…) as short phrases for SAM 3.1, so slicing can keep each piece whole (gear.ts).

/** Joints the silhouette finder places well; Spark's answer for them is ignored. */
export const FROM_SILHOUETTE: JointName[] = ["head", "hand_l", "hand_r", "toe_l", "toe_r"];
/** A hip further than this share of the leg's length (pelvis to ankle) above or below the pelvis is misplaced. */
const MAX_HIP_DROP = 0.2;
/** A thigh shorter than this share of its shin is wrong (Spark once put both hips at knee height). */
const MIN_THIGH_TO_SHIN = 0.55;
/** Upper arm to forearm length outside this range is wrong. */
const ARM_RATIO: [number, number] = [0.5, 2.5];
/** Grid units across each axis of the image Spark sees. */
const UNITS = 1000;
/** Largest side of the image sent to Spark. */
const SEND_SIDE = 1024;

const SYSTEM_PROMPT = `You place the joints of a 2D skeleton rig on a picture of a character. The picture has a grid: x runs from 0 at the left edge to ${UNITS} at the right edge, y from 0 at the top edge to ${UNITS} at the bottom edge, with a labelled line every 100.

Place each joint at the centre of the body where that joint pivots, not on the edge of armour, clothing, hair or a pauldron:
- neck: where the head meets the torso, at the base of the neck (under the chin or beard).
- pelvis: the centre point between the two hip joints.
- shoulder: the ball of the shoulder, inside the body where the upper arm swings from (under any pauldron or shoulder pad).
- elbow, wrist, knee, ankle: the centre of that joint, across the limb's width.
- hip: the top of the thigh inside the body, where the leg swings from (under any belt, skirt or loincloth).
- head: the top of the skull (not a plume or crest). hand: the fingertips. toe: the tip of the foot.

Sides: _l is the CHARACTER's own left and _r its own right. The character faces the viewer or is turned to the right, so its right side (_r) is on the LEFT of the picture and its left side (_l) on the RIGHT of the picture. In a side profile the near arm and leg are reaching back (the LEFT of the picture) and are _r; the far arm and leg are reaching forward (the RIGHT of the picture) and are _l.

Also list the character's gear that the rig must not cut in half: capes, cloaks, scarves, long skirts or coat tails, shoulder pads or pauldrons, elbow pads, knee pads, helmet plumes or crests, and similar pieces. Up to ${MAX_GEAR} items, the biggest first. For each give:
- phrase: 1 to 3 plain, common words an image segmenter knows, with at most one colour word, such as "red cape", "shoulder pad", "knee pad", "elbow pad", "plume", "scarf", "loincloth". Don't describe its material or shape ("skull shoulder armor", "round knee pad", "knee armor"). Not a sentence, no left or right, no lists. One phrase covers both sides of a pair.
- goesWith: the body part it moves with, one of ${GEAR_PARTS.join(", ")}. Pads that cover a joint go with the lower part (knee pad: shin, elbow pad: forearm). Shoulder pads go with upper_arm. A cape or cloak that hangs behind the body gets goesWith "cape": it becomes its own piece with its own bones. Other loose cloth (scarf, skirt, coat tails) goes with torso. Headgear goes with head.
Leave out the hands, weapons, and anything that is just the surface of a body part (a breastplate, a sleeve, boots). Use an empty list if there is no such gear.

Reply with JSON only: {"joints": {"<joint>": [x, y], ...}, "gear": [{"phrase": "...", "goesWith": "..."}], "notes": "<one sentence on anything unclear>"} with all of these joints: ${JOINT_NAMES.join(", ")}.`;

export interface SparkJoints {
  joints: Joints;
  /** Joints Spark couldn't place sensibly; they keep the silhouette's guess. */
  flagged: JointName[];
  /** Gear for SAM to find, so slicing keeps each piece whole. */
  gear: GearItem[];
  notes: string;
}

export async function sparkJoints(cut: Cutout, view: AutoRigView, guess: Joints, signal: AbortSignal, trace?: RigTrace): Promise<SparkJoints> {
  if (trace) return trace.call("joints", MUSE_MODEL, undefined, (record) => askSpark(cut, view, guess, signal, record));
  return askSpark(cut, view, guess, signal, {});
}

async function askSpark(cut: Cutout, view: AutoRigView, guess: Joints, signal: AbortSignal, record: CallRecord): Promise<SparkJoints> {
  const image = await gridImage(cut);
  const toUnits = (p: Point) => [Math.round((p.x / cut.width) * UNITS), Math.round((p.y / cut.height) * UNITS)];
  const request = [
    `View: ${{ front: "front, facing the viewer", right: "turned to face the right of the picture", side: "strict side profile facing the right of the picture" }[view]}.`,
    "A rough first guess from the character's outline (often wrong at the neck, shoulders and hips, so check every joint against the picture):",
    JSON.stringify(Object.fromEntries(JOINT_NAMES.map((j) => [j, toUnits(guess[j])]))),
  ].join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) auto-rig joints`, request);

  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [{ type: "text", text: request }, { type: "image_url", image_url: { url: image } }] },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) throw new Error(`Muse Spark joints failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body: unknown = await res.json();
  record.usage = getPath(body, ["usage"]);
  console.log(`[meta] auto-rig joints (${MUSE_MODEL}) usage: ${JSON.stringify(getPath(body, ["usage"]))}`);
  const content = getPath(body, ["choices", 0, "message", "content"]);
  logPrompt(`chat/completions (${MUSE_MODEL}) auto-rig joints reply`, typeof content === "string" ? content : "(no content)");
  const parsed = typeof content === "string" ? parseReply(content, cut) : null;
  record.detail = { reply: typeof content === "string" ? content.slice(0, 4000) : null };
  if (!parsed) throw new Error("Muse Spark's joints came back unreadable.");
  const checked = { ...checkJoints(cut, guess, parsed.joints, parsed.notes), gear: parsed.gear };
  record.detail = { ...record.detail, flagged: checked.flagged, gear: checked.gear, notes: checked.notes };
  return checked;
}

function parseReply(text: string, cut: Cutout): { joints: Partial<Joints>; gear: GearItem[]; notes: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const raw = getPath(json, ["joints"]);
  if (typeof raw !== "object" || raw === null) return null;
  const joints: Partial<Joints> = {};
  for (const j of JOINT_NAMES) {
    const v = (raw as Record<string, unknown>)[j];
    const [x, y] = Array.isArray(v) ? v : [(v as { x?: unknown } | null)?.x, (v as { y?: unknown } | null)?.y];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      joints[j] = { x: (x / UNITS) * cut.width, y: (y / UNITS) * cut.height };
    }
  }
  const notes = getPath(json, ["notes"]);
  return { joints, gear: cleanGear(getPath(json, ["gear"])), notes: typeof notes === "string" ? notes : "" };
}

/** Keeps Spark's joints that pass the checks and the silhouette's guess for the rest. */
export function checkJoints(cut: Cutout, guess: Joints, spark: Partial<Joints>, notes = ""): Omit<SparkJoints, "gear"> {
  const solid = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < cut.width && yi < cut.height && cut.rgba[(yi * cut.width + xi) * 4 + 3] >= 128;
  };
  let tall = 0;
  for (let y = 0; y < cut.height; y++) for (let x = 0; x < cut.width; x += 4) if (solid(x, y)) tall = y;
  const near = (p: Point, reach: number) => {
    for (let dy = -reach; dy <= reach; dy += 2) for (let dx = -reach; dx <= reach; dx += 2) if (solid(p.x + dx, p.y + dy)) return true;
    return false;
  };

  // Spark sometimes answers from its own point of view; swap the sides back if most of them are mirrored.
  const pairs = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"] as const;
  const mirrored = pairs.filter((p) => spark[`${p}_l`] && spark[`${p}_r`] && spark[`${p}_l`]!.x < spark[`${p}_r`]!.x).length;
  if (mirrored > pairs.length / 2) {
    for (const p of pairs) [spark[`${p}_l`], spark[`${p}_r`]] = [spark[`${p}_r`], spark[`${p}_l`]];
  }

  const out = { ...guess };
  const flagged: JointName[] = [];
  const reach = Math.max(4, Math.round(tall * 0.02));
  for (const j of JOINT_NAMES) {
    if (FROM_SILHOUETTE.includes(j)) continue;
    const p = spark[j];
    if (p && near(p, reach)) out[j] = p;
    else flagged.push(j);
  }
  // A limb that folds back on itself (the middle joint far off the line between its ends) is wrong.
  const chains: [JointName, JointName, JointName][] = [
    ["shoulder_l", "elbow_l", "wrist_l"],
    ["shoulder_r", "elbow_r", "wrist_r"],
    ["hip_l", "knee_l", "ankle_l"],
    ["hip_r", "knee_r", "ankle_r"],
  ];
  const d = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
  const flag = (...joints: JointName[]) => joints.forEach((j) => flagged.includes(j) || flagged.push(j));
  const revert = (...joints: JointName[]) => {
    for (const j of joints) out[j] = guess[j];
    flag(...joints);
  };
  for (const [a, b, c] of chains) {
    if (d(out[a], out[b]) + d(out[b], out[c]) > 1.6 * d(out[a], out[c]) + 1) revert(a, b, c);
  }

  // Proportions. The checks above pass a body that's merely misread, like hips placed at knee
  // height, which slices each thigh into a stub that pivots at the knee.
  const ankles = { x: (out.ankle_l.x + out.ankle_r.x) / 2, y: (out.ankle_l.y + out.ankle_r.y) / 2 };
  const leg = d(out.pelvis, ankles);
  for (const s of ["l", "r"] as const) {
    const [hip, knee, ankle] = [`hip_${s}`, `knee_${s}`, `ankle_${s}`] as const;
    if (Math.abs(out[hip].y - out.pelvis.y) > MAX_HIP_DROP * leg) {
      // Keep Spark's side-to-side placement and lift (or drop) the hip to the pelvis.
      out[hip] = { x: out[hip].x, y: out.pelvis.y };
      flag(hip);
    }
    if (d(out[hip], out[knee]) < MIN_THIGH_TO_SHIN * d(out[knee], out[ankle])) revert(hip, knee);

    const [shoulder, elbow, wrist] = [`shoulder_${s}`, `elbow_${s}`, `wrist_${s}`] as const;
    const ratio = d(out[shoulder], out[elbow]) / Math.max(1, d(out[elbow], out[wrist]));
    if (ratio < ARM_RATIO[0] || ratio > ARM_RATIO[1]) revert(shoulder, elbow, wrist);
  }
  return { joints: out, flagged, notes };
}

/** The cutout on a light background with the 0–1000 grid drawn and labelled, as a JPEG data URL. */
async function gridImage(cut: Cutout): Promise<string> {
  const scale = Math.min(1, SEND_SIDE / Math.max(cut.width, cut.height));
  const w = Math.round(cut.width * scale);
  const h = Math.round(cut.height * scale);
  const font = Math.max(10, Math.round(Math.max(w, h) / 70));
  const lines: string[] = [];
  for (let u = 100; u < UNITS; u += 100) {
    const x = (u / UNITS) * w;
    const y = (u / UNITS) * h;
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#3b82f6" stroke-opacity="0.45" stroke-width="1"/>`,
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#3b82f6" stroke-opacity="0.45" stroke-width="1"/>`,
      `<text x="${x + 2}" y="${font}" font-size="${font}" font-family="sans-serif" fill="#1d4ed8">${u}</text>`,
      `<text x="2" y="${y - 2}" font-size="${font}" font-family="sans-serif" fill="#1d4ed8">${u}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines.join("")}</svg>`;
  const art = await sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }).resize(w, h).png().toBuffer();
  const jpeg = await sharp({ create: { width: w, height: h, channels: 3, background: "#eeeeee" } })
    .composite([{ input: art }, { input: Buffer.from(svg) }])
    .jpeg({ quality: 88 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
