import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiFetch } from "./ai-fetch.js";
import { AUTO_TWEAK_LOG_DIR, META_API_BASE_URL, MUSE_MODEL, MUSE_TIMEOUT_MS } from "./config.js";
import { apiKey, getPath, logPrompt } from "./meta.js";

// Auto-tweak: the remix page renders the original rig and the remix side by side (paused at a
// few poses), measures how far each repainted part drifted from the original's pixels, and asks
// Muse Spark which of those fixes to keep. Shapes match frontend/app/lib/types.ts.

const STATUSES = ["measured", "aligned", "reshaped", "unmeasured"] as const;
type AutoTweakStatus = (typeof STATUSES)[number];

interface Transform {
  x: number;
  y: number;
  scale: number;
  rotate: number;
}

interface AutoTweakPart {
  id: number;
  name: string;
  status: AutoTweakStatus;
  measured: Transform | null;
  current: Transform | null;
}

export interface AutoTweakInput {
  animation: string;
  images: string[];
  parts: AutoTweakPart[];
}

export interface AutoTweakReview {
  changes: (Transform & { part: string; reason: string })[];
  notes: string;
}

const MAX_IMAGES = 4;
/** A 1200×420 JPEG snapshot is ~150 KB; this leaves room for PNGs without accepting anything huge. */
const MAX_IMAGE_CHARS = 3_000_000;
const MAX_PARTS = 400;
const IMAGE_PREFIX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** Moves (% of the rig's size), scale and rotation Muse may set: measured parts get the slider ranges… */
const MEASURED_LIMITS = { move: 15, scaleMin: 0.5, scaleMax: 2, rotate: 45 };
/** …and parts without a measurement only small nudges, since those are judged by eye. */
const JUDGED_LIMITS = { move: 5, scaleMin: 0.85, scaleMax: 1.15, rotate: 15 };

export function parseAutoTweakInput(body: unknown): AutoTweakInput | null {
  const animation = getPath(body, ["animation"]);
  const images = getPath(body, ["images"]);
  const parts = getPath(body, ["parts"]);
  if (typeof animation !== "string" || animation.length > 200) return null;
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) return null;
  if (!images.every((i) => typeof i === "string" && i.length <= MAX_IMAGE_CHARS && IMAGE_PREFIX.test(i))) return null;
  if (!Array.isArray(parts) || parts.length > MAX_PARTS) return null;

  const parsed: AutoTweakPart[] = [];
  for (const p of parts) {
    const id = getPath(p, ["id"]);
    const name = getPath(p, ["name"]);
    const status = STATUSES.find((s) => s === getPath(p, ["status"]));
    const measured = parseTransform(getPath(p, ["measured"]));
    const current = parseTransform(getPath(p, ["current"]));
    if (typeof id !== "number" || !Number.isInteger(id) || typeof name !== "string" || !name || name.length > 200 || !status) return null;
    if (measured === undefined || current === undefined) return null;
    parsed.push({ id, name, status, measured, current });
  }
  return { animation, images: images as string[], parts: parsed };
}

/** A transform, null, or undefined when the value is malformed. */
function parseTransform(value: unknown): Transform | null | undefined {
  if (value === null || value === undefined) return null;
  const t = { x: getPath(value, ["x"]), y: getPath(value, ["y"]), scale: getPath(value, ["scale"]), rotate: getPath(value, ["rotate"]) };
  const ok = Object.values(t).every((v) => typeof v === "number" && Number.isFinite(v));
  return ok ? (t as Transform) : undefined;
}

const REVIEW_SYSTEM_PROMPT = `You are a 2D animation rigger reviewing a Spine character whose textures were repainted by an image model. The skeleton and meshes are unchanged; only the pixels inside each part were repainted, and the image model sometimes shifts or resizes what it paints, so parts no longer meet the way they did.

Each image shows one pose of the same animation in three panels, left to right:
1. ORIGINAL: the rig as the artist made it. This is the target for how parts fit together.
2. REMIX NOW: the repainted rig with the user's current tweaks.
3. REMIX + MEASURED FIXES: the repainted rig with the measured fixes applied.
Numbered tags on panels 2 and 3 mark each part; orange tags are parts with a measured fix. The user message maps numbers to part names and gives each part's status.

Statuses:
- measured: pixel measurement found the repainted part drifted; the measured fix moves, scales and turns it back. These numbers are exact; prefer them. Rotation is only measured on long parts (limbs, weapons), so a round part's measured rotate is always 0.
- aligned: the part already matches the original.
- reshaped: the remix gave the part a new silhouette on purpose (e.g. a bigger hat), so there is no measurement.
- unmeasured: no measurement was possible.

Your job: decide the final transform of each part so the remix fits together like the original: joints meet, nothing floats or leaves a gap, held items sit in the hand, nothing pokes through where it didn't before.
- Accept a measured fix by copying its numbers. Drop it (leave the part out) if panel 3 looks worse than panel 2 for that part, for example a reshaped-looking part pulled off its joint.
- Only change a part without a measured fix when panel 2 shows a clear misalignment against the original; keep those nudges small.
- Leave out every part that already looks right. If nothing needs changing, return an empty list.
- Don't restyle anything: no colours, no hiding parts.

Units: x and y are percent of the rig's size as seen in the image (+x right, +y up). scale is a multiplier (1 = unchanged). rotate is degrees counter-clockwise. Values are the part's total transform relative to the untweaked remix, and replace the user's current tweak on that part.

Reply with JSON only, no markdown: {"changes": [{"part": "<part name>", "x": 0, "y": 0, "scale": 1, "rotate": 0, "reason": "<at most 12 words>"}], "notes": "<one or two sentences for the user on what you changed and why>"}`;

/**
 * Asks Muse Spark which measured fixes to keep, and for any small nudges it can see. Every run
 * is saved to AUTO_TWEAK_LOG_DIR (see saveRun), including failed ones.
 */
export async function reviewAutoTweak(assetId: string, input: AutoTweakInput, signal: AbortSignal): Promise<AutoTweakReview> {
  const request = [
    `Animation: ${input.animation}. ${input.images.length} image(s), one per pose.`,
    "Parts (number: name, status, measured fix, user's current tweak):",
    ...input.parts.map(describePart),
  ].join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) auto-tweak system`, REVIEW_SYSTEM_PROMPT);
  logPrompt(`chat/completions (${MUSE_MODEL}) auto-tweak user + ${input.images.length} image(s)`, request);

  const run: RunLog = { assetId, startedAt: new Date().toISOString(), model: MUSE_MODEL, request, input };
  const started = Date.now();
  try {
    const review = await callMuse(input, request, signal, run);
    run.review = review;
    return review;
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.durationMs = Date.now() - started;
    await saveRun(run);
  }
}

async function callMuse(input: AutoTweakInput, request: string, signal: AbortSignal, run: RunLog): Promise<AutoTweakReview> {
  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "text", text: request }, ...input.images.map((url) => ({ type: "image_url", image_url: { url } }))],
        },
      ],
    }),
    timeoutMs: MUSE_TIMEOUT_MS,
    signal,
  });
  run.status = res.status;
  if (!res.ok) {
    const body = await res.text();
    run.responseBody = body;
    console.error(`Muse auto-tweak request failed (${res.status}) with ${MUSE_MODEL}`, body);
    throw new Error("Muse couldn't review the rig. Try again.");
  }

  const body: unknown = await res.json();
  run.responseBody = body;
  const content = getPath(body, ["choices", 0, "message", "content"]);
  logPrompt(`chat/completions (${MUSE_MODEL}) auto-tweak reply`, typeof content === "string" ? content : "(no content)");
  const review = typeof content === "string" ? parseReview(content, input.parts) : null;
  if (!review) throw new Error("Muse's review came back unreadable. Try again.");
  return review;
}

/** One auto-tweak run, as saved to reply.json. */
interface RunLog {
  assetId: string;
  startedAt: string;
  model: string;
  /** The text part of the user message; the images are saved beside it. */
  request: string;
  input: AutoTweakInput;
  /** HTTP status and full body (parsed JSON, or text on errors) of the Muse response. */
  status?: number;
  responseBody?: unknown;
  /** What the endpoint returned after validation, or the error it reported. */
  review?: AutoTweakReview;
  error?: string;
  durationMs?: number;
}

/**
 * Writes <AUTO_TWEAK_LOG_DIR>/<time>_<assetId>/: pose-N.jpg (the snapshots Muse saw),
 * system-prompt.txt, and reply.json (request, parts, Muse's raw response, the returned review
 * or error). Logging must never fail the request, so errors are only reported.
 */
async function saveRun(run: RunLog) {
  try {
    const folder = path.join(AUTO_TWEAK_LOG_DIR, `${run.startedAt.replace(/[:.]/g, "-")}_${run.assetId.replace(/[^\w-]/g, "_").slice(0, 80)}`);
    await mkdir(folder, { recursive: true });
    const images = run.input.images.map((url, i) => {
      const [, type = "jpeg", data = ""] = /^data:image\/(\w+);base64,(.*)$/.exec(url) ?? [];
      return { name: `pose-${i + 1}.${type === "jpeg" ? "jpg" : type}`, data: Buffer.from(data, "base64") };
    });
    const record = { ...run, input: { ...run.input, images: images.map((img) => img.name) } };
    await Promise.all([
      ...images.map((img) => writeFile(path.join(folder, img.name), img.data)),
      writeFile(path.join(folder, "system-prompt.txt"), REVIEW_SYSTEM_PROMPT),
      writeFile(path.join(folder, "reply.json"), JSON.stringify(record, null, 2)),
    ]);
    console.log(`[auto-tweak] saved run to ${folder}`);
  } catch (error) {
    console.error("Couldn't save the auto-tweak run log", error);
  }
}

function describePart(p: AutoTweakPart): string {
  const fmt = (t: Transform) => `x ${t.x}, y ${t.y}, scale ${t.scale}, rotate ${t.rotate}`;
  return [
    `${p.id}: ${p.name}`,
    p.status,
    p.measured ? `fix ${fmt(p.measured)}` : null,
    p.current ? `current ${fmt(p.current)}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Muse's reply is untrusted: keep only known parts and clamp every value. */
function parseReview(content: string, parts: AutoTweakPart[]): AutoTweakReview | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const changes = getPath(parsed, ["changes"]);
  if (!Array.isArray(changes)) return null;

  const byName = new Map(parts.map((p) => [p.name, p]));
  const seen = new Set<string>();
  const out: AutoTweakReview["changes"] = [];
  for (const c of changes) {
    const name = getPath(c, ["part"]);
    const part = typeof name === "string" ? byName.get(name) : undefined;
    if (!part || seen.has(part.name)) continue;
    seen.add(part.name);
    const limits = part.status === "measured" ? MEASURED_LIMITS : JUDGED_LIMITS;
    const num = (key: string, fallback: number) => {
      const v = getPath(c, [key]);
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    };
    const reason = getPath(c, ["reason"]);
    out.push({
      part: part.name,
      x: round(clamp(num("x", 0), -limits.move, limits.move)),
      y: round(clamp(num("y", 0), -limits.move, limits.move)),
      scale: round(clamp(num("scale", 1), limits.scaleMin, limits.scaleMax)),
      rotate: round(clamp(num("rotate", 0), -limits.rotate, limits.rotate)),
      reason: typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, 120) : "",
    });
  }
  const notes = getPath(parsed, ["notes"]);
  return { changes: out, notes: typeof notes === "string" ? notes.replace(/\s+/g, " ").trim().slice(0, 400) : "" };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
