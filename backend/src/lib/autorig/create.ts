import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getProfile } from "../billing.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset, type Visibility } from "../db.js";
import { fingerprintRig } from "../fingerprint.js";
import { getFile, putFile } from "../storage.js";
import { nameSlug } from "../upload-rename.js";
import { alphaCutout, hasTransparentBackground, keyCutout } from "./cutout.js";
import { cleanGear, gearMasks, loadGearMasks, saveGearMasks, type GearItem, type GearMask } from "./gear.js";
import { guessJoints } from "./joints.js";
import { museFillHidden } from "./muse-fill.js";
import { poseCharacter } from "./pose.js";
import { FROM_SILHOUETTE, sparkJoints } from "./spark-joints.js";
import { buildRig, cutPreview, IDLE_SECONDS, PAGE_NAME } from "./rig.js";
import { PREPARE_FOLDER, RigTrace } from "./trace.js";
import { JOINT_NAMES, type AutoRigView, type Cutout, type JointName, type Joints } from "./types.js";

// The /autoRig flow's two backend steps (AUTO_RIG_PLAN.md):
//   1. prepare: the upload → Muse Image's redraw in the rig pose (or the upload as-is when it has a
//      transparent background) → a keyed cutout → joints: the extremities from its silhouette and
//      the inner joints from Muse Spark (the silhouette's guess if Spark fails), and Spark's list of
//      the character's gear, which SAM 3.1 then masks. The page keeps the cutout while the user
//      drags the joints.
//   2. create: the cutout and the user's joints → a Spine rig, stored as a new asset. By default the
//      art stays one image, bent by weighted meshes (smooth, no seams, for gentle motion). With
//      `slice`, it's cut into parts with the saved gear masks, keeping each piece of gear whole (a
//      cape its own piece), and Muse Image paints their hidden areas (the code's smear is kept
//      wherever it doesn't).
// Each step saves a trace of its model calls and decisions (trace.ts): prepare as
// `<time>_autorig-prep_<id>/prepare.json`, with Muse's redraw beside it, and create as
// `autorig.json` in the rig's folder. Prepare also saves the cutout and the gear masks there, so the
// joint editor's cut preview (previewCuts) and the build can find them by the trace id.

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Larger side of the cutout; Muse's 1600px redraw is scaled down to this. */
const CUTOUT_SIDE = 1024;
const MAX_NAME_LENGTH = 80;
const ACCENTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

export interface PrepareInput {
  image: Buffer;
  view: AutoRigView;
  /** Rig the upload as it is (it must have a transparent background) instead of asking Muse. */
  skipPose: boolean;
}

export interface PreparedRig {
  /** The keyed character as a PNG data URL; sent back with the joints to build the rig. */
  cutout: string;
  width: number;
  height: number;
  joints: Joints;
  /** Joints Muse Spark couldn't place sensibly (or all of them if it failed); the page outlines them. */
  flagged: JointName[];
  /** Who placed the inner joints. */
  jointsBy: "spark" | "outline";
  /** Gear Spark found; SAM's masks of it are saved with the pose for the cut preview and the build. */
  gear: GearItem[];
  posed: boolean;
  /** This prepare's trace folder; sent back with Build rig so the two traces link up. */
  traceId: string;
  /** Where the rig will cut the character with these joints (PNG data URL, the cutout's size). */
  cuts: string;
}

export interface PreviewInput {
  traceId: string;
  view: AutoRigView;
  joints: Joints;
}

export interface CreateInput {
  name: string;
  view: AutoRigView;
  visibility: Visibility;
  /** Cut the art into separate parts (for big motions) rather than bend it as one image. */
  slice: boolean;
  cutout: Buffer;
  joints: Joints;
  gear: GearItem[];
  /** The prepare trace's folder, if the page sent a valid one. */
  prepareTrace: string | null;
}

type Parsed<T> = { ok: true; input: T } | { ok: false; error: string };

export function parsePrepareInput(body: unknown): Parsed<PrepareInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send an image." };
  const { image, view, skipPose } = body as Record<string, unknown>;
  const decoded = decodeDataUrl(image, ["image/png", "image/jpeg", "image/webp"]);
  if (!decoded) return { ok: false, error: "Send a PNG, JPG or WebP image." };
  if (decoded.length > MAX_IMAGE_BYTES) return { ok: false, error: "The image is too big. Use one under 8 MB." };
  if (view !== "front" && view !== "right") return { ok: false, error: "Pick a view: front or facing right." };
  return { ok: true, input: { image: decoded, view, skipPose: skipPose === true } };
}

export function parseCreateInput(body: unknown): Parsed<CreateInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Nothing to rig." };
  const { name, view, visibility, cutout, joints, gear, traceId, slice } = body as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME_LENGTH) return { ok: false, error: `Give the rig a name (up to ${MAX_NAME_LENGTH} characters).` };
  if (view !== "front" && view !== "right") return { ok: false, error: "Pick a view: front or facing right." };
  if (visibility !== "public" && visibility !== "private") return { ok: false, error: "Visibility must be public or private." };
  const png = decodeDataUrl(cutout, ["image/png"]);
  if (!png || png.length > MAX_IMAGE_BYTES) return { ok: false, error: "The cutout is missing. Start over." };
  const out = parseJoints(joints);
  if (typeof out === "string") return { ok: false, error: out };
  const prepareTrace = typeof traceId === "string" && PREPARE_FOLDER.test(traceId) ? traceId : null;
  return { ok: true, input: { name: name.trim(), view, visibility, slice: slice === true, cutout: png, joints: out, gear: cleanGear(gear), prepareTrace } };
}

export function parsePreviewInput(body: unknown): Parsed<PreviewInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Nothing to preview." };
  const { traceId, view, joints } = body as Record<string, unknown>;
  if (typeof traceId !== "string" || !PREPARE_FOLDER.test(traceId)) return { ok: false, error: "Pose the character first." };
  if (view !== "front" && view !== "right") return { ok: false, error: "Pick a view: front or facing right." };
  const out = parseJoints(joints);
  if (typeof out === "string") return { ok: false, error: out };
  return { ok: true, input: { traceId, view, joints: out } };
}

/** All 19 joints as finite numbers, or the error to show. */
function parseJoints(joints: unknown): Joints | string {
  if (typeof joints !== "object" || joints === null) return "The joints are missing.";
  const out = {} as Joints;
  for (const j of JOINT_NAMES) {
    const p = (joints as Record<string, unknown>)[j];
    const x = (p as { x?: unknown } | null)?.x;
    const y = (p as { y?: unknown } | null)?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return `The ${j.replace("_", " ")} joint is missing.`;
    out[j] = { x, y };
  }
  return out;
}

export async function prepareAutoRig(input: PrepareInput, signal: AbortSignal): Promise<PreparedRig | { error: string }> {
  const trace = new RigTrace("prepare");
  const folder = `${stamp()}_autorig-prep_${randomUUID().slice(0, 8)}`;
  trace.set("input", { view: input.view, skipPose: input.skipPose, bytes: input.image.length });
  let redraw: Buffer | null = null;
  try {
    let cut: Cutout;
    if (input.skipPose) {
      if (!(await hasTransparentBackground(input.image))) {
        trace.set("outcome", { error: "no transparent background" });
        return { error: "Rigging as-is needs a PNG with a transparent background." };
      }
      cut = await alphaCutout(await sharp(input.image).resize(CUTOUT_SIDE, CUTOUT_SIDE, { fit: "inside", withoutEnlargement: true }).png().toBuffer());
    } else {
      redraw = await poseCharacter(input.image, input.view, signal, trace);
      cut = await keyCutout(await sharp(redraw).resize(CUTOUT_SIDE, CUTOUT_SIDE, { fit: "inside" }).png().toBuffer());
    }
    trace.set("cutout", { width: cut.width, height: cut.height });
    const png = await sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }).png().toBuffer();
    const guess = guessJoints(cut, input.view);
    let placed: Pick<PreparedRig, "joints" | "flagged" | "jointsBy" | "gear">;
    try {
      const spark = await sparkJoints(cut, input.view, guess, signal, trace);
      placed = { joints: spark.joints, flagged: spark.flagged, jointsBy: "spark", gear: spark.gear };
    } catch (error) {
      if (signal.aborted) throw error;
      console.error("[autorig] Spark joints failed; using the outline's guess", error);
      placed = { joints: guess, flagged: JOINT_NAMES.filter((j) => !FROM_SILHOUETTE.includes(j)), jointsBy: "outline", gear: [] };
    }
    trace.set("outcome", { jointsBy: placed.jointsBy, flagged: placed.flagged, gear: placed.gear, joints: placed.joints });
    // SAM finds the gear (and the hands) now, so the cut preview can show it kept whole. Without it
    // the rig is cut by distance alone.
    let gear: GearMask[] = [];
    try {
      gear = await gearMasks(cut, placed.gear, signal, trace);
    } catch (error) {
      if (signal.aborted) throw error;
      console.error("[autorig] SAM gear masks failed; slicing by distance alone", error);
      trace.set("gearError", error instanceof Error ? error.message : String(error));
    }
    rememberPose(folder, { cut, gear });
    const save = (name: string, body: Buffer | string) => putFile(folder, name, body);
    const [cuts] = await Promise.all([cutPreview(cut, placed.joints, input.view, gear), save("cutout.png", png), saveGearMasks(save, gear, cut.width, cut.height)]);
    return { cutout: dataUrl(png), width: cut.width, height: cut.height, ...placed, posed: !input.skipPose, traceId: folder, cuts: dataUrl(cuts) };
  } catch (error) {
    trace.set("outcome", { error: error instanceof Error ? error.message : String(error), aborted: signal.aborted });
    throw error;
  } finally {
    // Saved after the reply is ready but awaited, so the trace exists before the page can use its id.
    await Promise.all([trace.save(folder, "prepare.json"), redraw ? putFile(folder, "pose.webp", redraw).catch((e: unknown) => console.error("[autorig] couldn't save the pose", e)) : null]);
  }
}

/** A prepared pose: the cutout and its gear masks. */
interface Pose {
  cut: Cutout;
  gear: GearMask[];
}

/** Recent poses by trace id, so dragging joints doesn't re-read them from storage. */
const recentPoses = new Map<string, Pose>();
const RECENT_POSES = 16;

function rememberPose(traceId: string, pose: Pose) {
  recentPoses.delete(traceId);
  recentPoses.set(traceId, pose);
  if (recentPoses.size > RECENT_POSES) recentPoses.delete(recentPoses.keys().next().value!);
}

/** A prepared pose from memory or its trace folder; null if it's gone (or predates saved gear). */
async function loadPose(traceId: string): Promise<Pose | null> {
  const known = recentPoses.get(traceId);
  if (known) return known;
  try {
    const png = await getFile(traceId, "cutout.png");
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pose = { cut: { width: info.width, height: info.height, rgba: data }, gear: await loadGearMasks((name) => getFile(traceId, name)) };
    rememberPose(traceId, pose);
    return pose;
  } catch {
    return null;
  }
}

/** Where the rig would cut the prepared character with these joints, for the joint editor. */
export async function previewCuts(input: PreviewInput): Promise<{ cuts: string } | { error: string }> {
  const pose = await loadPose(input.traceId);
  if (!pose) return { error: "This pose has expired. Pose the character again." };
  return { cuts: dataUrl(await cutPreview(pose.cut, input.joints, input.view, pose.gear)) };
}

export async function createAutoRig(userId: string, input: CreateInput, signal: AbortSignal): Promise<{ ok: true; asset: SpineAsset } | { ok: false; error: string }> {
  const trace = new RigTrace("create");
  const suffix = randomUUID().slice(0, 8);
  const folder = `${stamp()}_autorig_${suffix}`;
  const prepareTrace = input.prepareTrace ? `remixes/${input.prepareTrace}/prepare.json` : null;
  trace.set("input", { view: input.view, visibility: input.visibility, slice: input.slice, prepareTrace, gear: input.gear, joints: input.joints });
  try {
    const result = await buildAndSave(userId, input, signal, trace, folder, suffix);
    trace.set("outcome", result.ok ? { assetId: result.asset.id } : { error: result.error });
    return result;
  } catch (error) {
    trace.set("outcome", { error: error instanceof Error ? error.message : String(error), aborted: signal.aborted });
    throw error;
  } finally {
    await trace.save(folder, "autorig.json");
  }
}

async function buildAndSave(userId: string, input: CreateInput, signal: AbortSignal, trace: RigTrace, folder: string, suffix: string): Promise<{ ok: true; asset: SpineAsset } | { ok: false; error: string }> {
  const { data, info } = await sharp(input.cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cut: Cutout = { width: info.width, height: info.height, rgba: data };
  for (const j of JOINT_NAMES) {
    const p = input.joints[j];
    if (p.x < -cut.width * 0.1 || p.x > cut.width * 1.1 || p.y < -cut.height * 0.1 || p.y > cut.height * 1.1) return { ok: false, error: "A joint is outside the picture. Drag it back onto the character." };
  }
  let page: Buffer;
  let rig: Awaited<ReturnType<typeof buildRig>>;
  if (input.slice) {
    // The gear masks SAM found while preparing. A pose without them (made before they were saved)
    // asks SAM again; if that fails, the rig is cut by distance alone.
    const pose = input.prepareTrace ? await loadPose(input.prepareTrace) : null;
    let gear: GearMask[] = pose && pose.cut.width === cut.width && pose.cut.height === cut.height ? pose.gear : [];
    trace.set("gearFrom", pose ? "prepare" : "sam");
    if (!pose) {
      try {
        gear = await gearMasks(cut, input.gear, signal, trace);
      } catch (error) {
        if (signal.aborted) throw error;
        console.error("[autorig] SAM gear masks failed; slicing by distance alone", error);
        trace.set("gearError", error instanceof Error ? error.message : String(error));
      }
    }
    const t = Date.now();
    rig = await buildRig(cut, input.joints, input.view, { gear });
    trace.set("build", { ms: Date.now() - t, gear: rig.stats.gear, parts: rig.stats.parts });
    console.log(`[autorig] gear: ${rig.stats.gear.map((g) => `${g.phrase} → ${g.part ?? "skipped"}`).join(", ") || "none"}`);
    page = rig.page;
    try {
      const t = Date.now();
      const fill = await museFillHidden(rig.pageImage, rig.regions, rig.hidden, signal, trace);
      page = await sharp(fill.page.rgba, { raw: { width: fill.page.width, height: fill.page.height, channels: 4 } }).png().toBuffer();
      const painted = fill.pieces.reduce((s, p) => s + p.painted, 0);
      const total = fill.pieces.reduce((s, p) => s + p.hidden, 0);
      console.log(`[autorig] Muse filled ${painted} of ${total} hidden pixels (marker ${fill.marker})`);
      trace.set("fill", { ms: Date.now() - t, marker: fill.marker, painted, hidden: total, pieces: fill.pieces });
    } catch (error) {
      if (signal.aborted) throw error;
      console.error("[autorig] Muse fill failed; keeping the smeared fill", error);
      trace.set("fill", { error: error instanceof Error ? error.message : String(error), keptSmear: true });
    }
  } else {
    // One image bent by weighted meshes: nothing to cut or paint, so no model calls.
    const t = Date.now();
    rig = await buildRig(cut, input.joints, input.view, { slice: false });
    trace.set("build", { ms: Date.now() - t, parts: rig.stats.parts });
    page = rig.page;
  }

  const profile = await getProfile(userId);
  const slug = nameSlug(input.name) || "rig";
  const [skeletonKey, atlasKey, pageKey] = await Promise.all([
    putFile(folder, `${slug}.json`, JSON.stringify(rig.skeleton)),
    putFile(folder, `${slug}.atlas`, rig.atlas),
    putFile(folder, `${PAGE_NAME}.png`, page),
  ]);
  const fingerprint = fingerprintRig(rig.skeleton, [page]);
  const animations = Object.entries(rig.skeleton.animations as Record<string, unknown>).map(([name]) => ({ name, durationSec: IDLE_SECONDS, loop: true }));
  const row = {
    id: `${slug}-${suffix}`,
    owner_id: userId,
    author_id: userId,
    author_name: profile.name || "Anonymous",
    name: input.name,
    description: `A Spine 4.2 rig auto-rigged from an image by ${profile.name || "a RigForge user"}.`,
    category: "character",
    style: "cartoon",
    tags: ["auto-rig"],
    visibility: input.visibility,
    based_on: null,
    based_on_name: null,
    art_hash: fingerprint.artHash,
    rig_hash: fingerprint.rigHash,
    spine_version: "4.2",
    bone_count: (rig.skeleton.bones as unknown[]).length,
    slot_count: (rig.skeleton.slots as unknown[]).length,
    animations,
    accent: ACCENTS[parseInt(suffix.slice(0, 2), 16) % ACCENTS.length],
    files: { skeleton: skeletonKey, atlas: atlasKey, textures: [pageKey], premultipliedAlpha: false, skin: null },
  };
  const res = await db().from("assets").insert(row).select(ASSET_COLUMNS).single().overrideTypes<AssetRow, { merge: false }>();
  if (res.error?.code === "23505") return { ok: false, error: "You already have this exact rig in your library." };
  return { ok: true, asset: toSpineAsset(check(res)!) };
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A folder-name timestamp, e.g. 2026-11-02T21-51-49-211Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function decodeDataUrl(value: unknown, types: string[]): Buffer | null {
  if (typeof value !== "string") return null;
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m || !types.includes(m[1])) return null;
  return Buffer.from(m[2], "base64");
}
