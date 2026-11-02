import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getProfile } from "../billing.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset, type Visibility } from "../db.js";
import { fingerprintRig } from "../fingerprint.js";
import { putFile } from "../storage.js";
import { nameSlug } from "../upload-rename.js";
import { alphaCutout, hasTransparentBackground, keyCutout } from "./cutout.js";
import { guessJoints } from "./joints.js";
import { poseCharacter } from "./pose.js";
import { FROM_SILHOUETTE, sparkJoints } from "./spark-joints.js";
import { buildRig, IDLE_SECONDS, PAGE_NAME } from "./rig.js";
import { JOINT_NAMES, type AutoRigView, type Cutout, type JointName, type Joints } from "./types.js";

// The /autoRig flow's two backend steps (AUTO_RIG_PLAN.md):
//   1. prepare: the upload → Muse Image's redraw in the rig pose (or the upload as-is when it has a
//      transparent background) → a keyed cutout → joints: the extremities from its silhouette and
//      the inner joints from Muse Spark (the silhouette's guess if Spark fails). Nothing is stored;
//      the page keeps the cutout while the user drags the joints.
//   2. create: the cutout and the user's joints → a Spine rig, stored and saved as a new asset.

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
  posed: boolean;
}

export interface CreateInput {
  name: string;
  view: AutoRigView;
  visibility: Visibility;
  cutout: Buffer;
  joints: Joints;
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
  const { name, view, visibility, cutout, joints } = body as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME_LENGTH) return { ok: false, error: `Give the rig a name (up to ${MAX_NAME_LENGTH} characters).` };
  if (view !== "front" && view !== "right") return { ok: false, error: "Pick a view: front or facing right." };
  if (visibility !== "public" && visibility !== "private") return { ok: false, error: "Visibility must be public or private." };
  const png = decodeDataUrl(cutout, ["image/png"]);
  if (!png || png.length > MAX_IMAGE_BYTES) return { ok: false, error: "The cutout is missing. Start over." };
  if (typeof joints !== "object" || joints === null) return { ok: false, error: "The joints are missing." };
  const out = {} as Joints;
  for (const j of JOINT_NAMES) {
    const p = (joints as Record<string, unknown>)[j];
    const x = (p as { x?: unknown } | null)?.x;
    const y = (p as { y?: unknown } | null)?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: `The ${j.replace("_", " ")} joint is missing.` };
    out[j] = { x, y };
  }
  return { ok: true, input: { name: name.trim(), view, visibility, cutout: png, joints: out } };
}

export async function prepareAutoRig(input: PrepareInput, signal: AbortSignal): Promise<PreparedRig | { error: string }> {
  let cut: Cutout;
  if (input.skipPose) {
    if (!(await hasTransparentBackground(input.image))) return { error: "Rigging as-is needs a PNG with a transparent background." };
    cut = await alphaCutout(await sharp(input.image).resize(CUTOUT_SIDE, CUTOUT_SIDE, { fit: "inside", withoutEnlargement: true }).png().toBuffer());
  } else {
    const redraw = await poseCharacter(input.image, input.view, signal);
    cut = await keyCutout(await sharp(redraw).resize(CUTOUT_SIDE, CUTOUT_SIDE, { fit: "inside" }).png().toBuffer());
  }
  const png = await sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }).png().toBuffer();
  const guess = guessJoints(cut, input.view);
  let placed: Pick<PreparedRig, "joints" | "flagged" | "jointsBy">;
  try {
    const spark = await sparkJoints(cut, input.view, guess, signal);
    placed = { joints: spark.joints, flagged: spark.flagged, jointsBy: "spark" };
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("[autorig] Spark joints failed; using the outline's guess", error);
    placed = { joints: guess, flagged: JOINT_NAMES.filter((j) => !FROM_SILHOUETTE.includes(j)), jointsBy: "outline" };
  }
  return { cutout: `data:image/png;base64,${png.toString("base64")}`, width: cut.width, height: cut.height, ...placed, posed: !input.skipPose };
}

export async function createAutoRig(userId: string, input: CreateInput): Promise<{ ok: true; asset: SpineAsset } | { ok: false; error: string }> {
  const { data, info } = await sharp(input.cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cut: Cutout = { width: info.width, height: info.height, rgba: data };
  for (const j of JOINT_NAMES) {
    const p = input.joints[j];
    if (p.x < -cut.width * 0.1 || p.x > cut.width * 1.1 || p.y < -cut.height * 0.1 || p.y > cut.height * 1.1) return { ok: false, error: "A joint is outside the picture. Drag it back onto the character." };
  }
  const rig = await buildRig(cut, input.joints, input.view);

  const profile = await getProfile(userId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomUUID().slice(0, 8);
  const slug = nameSlug(input.name) || "rig";
  const folder = `${stamp}_autorig_${suffix}`;
  const [skeletonKey, atlasKey, pageKey] = await Promise.all([
    putFile(folder, `${slug}.json`, JSON.stringify(rig.skeleton)),
    putFile(folder, `${slug}.atlas`, rig.atlas),
    putFile(folder, `${PAGE_NAME}.png`, rig.page),
  ]);
  const fingerprint = fingerprintRig(rig.skeleton, [rig.page]);
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

function decodeDataUrl(value: unknown, types: string[]): Buffer | null {
  if (typeof value !== "string") return null;
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m || !types.includes(m[1])) return null;
  return Buffer.from(m[2], "base64");
}
