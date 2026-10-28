import sharp from "sharp";
import { createRemixJob as createV1Job, getRemixJob as getV1Job, newRemixJobId } from "./jobs.js";
import { createRemixJob as createV2Job, getRemixJob as getV2Job } from "../v2/lib/jobs.js";
import { getAssetRow } from "./assets.js";
import { getProfile, remixesUsed } from "./billing.js";
import { PLAN_LIMITS } from "./config.js";
import { REMIX_JOB_COLUMNS, check, db, toSpineAsset, type AssetRow, type RemixJobRow, type SpineAsset } from "./db.js";
import { objectUrl, putFile } from "./storage.js";
import { REMIX_STYLES, type RemixInput, type RemixJob, type RemixStyle } from "./types.js";

// Remix jobs for signed-in users. The v1/v2 runners do the work in memory; this records each job
// in remix_jobs (which is also the monthly usage count) and saves the finished remix as an asset
// owned by the user, public or private as they chose when starting it.

export const REMIX_API_VERSIONS = ["v1", "v2"] as const;
export type RemixApiVersion = (typeof REMIX_API_VERSIONS)[number];

/** The job shape the frontend expects (RemixJob in frontend/app/lib/types.ts). */
export interface RemixJobView {
  id: string;
  status: RemixJob["status"];
  progress: number;
  stage: string;
  input: RemixInput;
  apiVersion: RemixApiVersion;
  base: Pick<SpineAsset, "id" | "name" | "category" | "accent" | "animations" | "files" | "tint">;
  createdAt: string;
  editPrompt: string | null;
  promptStatus: RemixJob["promptStatus"];
  /** URL of the user's reference image, or null. */
  referenceUrl: string | null;
  asset: SpineAsset | null;
  error: string | null;
}

export type StartRemixResult =
  | { ok: true; job: RemixJobView }
  | { ok: false; status: 400 | 402; error: string; field?: "base" | "referenceImage" };

/** Starts a remix if the user has allowance left. Admins have no monthly limit and can remix any asset. */
export async function startRemix(
  userId: string,
  input: RemixInput,
  apiVersion: RemixApiVersion,
  isAdmin: boolean,
  referenceImage: Buffer | null = null,
): Promise<StartRemixResult> {
  const [limitError, base] = await Promise.all([allowanceError(userId, isAdmin), getAssetRow(input.baseAssetId, userId, isAdmin)]);
  if (limitError) return { ok: false, status: 402, error: limitError };
  if (!base) return { ok: false, status: 400, error: "That rig no longer exists.", field: "base" };
  if (!base.files) return { ok: false, status: 400, error: "This rig has no textures to repaint yet. Choose another one.", field: "base" };

  if (referenceImage && apiVersion === "v1") {
    return { ok: false, status: 400, error: "Reference images need the v2 remix API.", field: "referenceImage" };
  }

  const id = newRemixJobId();
  if (referenceImage) {
    const jpeg = await normalizeReference(referenceImage);
    if (!jpeg) return { ok: false, status: 400, error: "Couldn't read the reference image. Try another file.", field: "referenceImage" };
    input = { ...input, referenceImage: await putFile(`${new Date().toISOString().replace(/[:.]/g, "-")}_${id}_ref`, "reference.jpg", jpeg) };
  }
  check(
    await db().from("remix_jobs").insert({
      id,
      user_id: userId,
      base_asset_id: base.id,
      api_version: apiVersion,
      input,
      status: "running",
    }),
  );

  const request = {
    ...input,
    base: { name: base.name, atlasUrl: objectUrl(base.files.atlas), premultipliedAlpha: base.files.premultipliedAlpha },
    referenceUrl: input.referenceImage ? objectUrl(input.referenceImage) : null,
  };
  const onSettled = async (job: RemixJob) => {
    let assetId: string | null = null;
    let { status, error } = job;
    if (job.status === "succeeded" && job.result) {
      try {
        assetId = await saveRemixAsset(userId, id, input, base, job.result);
      } catch (saveError) {
        console.error(`Saving remix ${id} failed`, saveError);
        status = "failed";
        error = "The remix finished but couldn't be saved. Try again.";
      }
    }
    check(
      await db()
        .from("remix_jobs")
        .update({ status, error, edit_prompt: job.editPrompt, prompt_status: job.promptStatus, asset_id: assetId })
        .eq("id", id),
    );
  };
  if (apiVersion === "v1") createV1Job(request, { id, onSettled });
  else createV2Job(request, { id, onSettled });

  const job = await getRemixJobView(userId, id);
  if (!job) throw new Error(`Remix job ${id} vanished right after it was created`);
  return { ok: true, job };
}

/** Why the user can't start another remix or part fix this month, or null if they can. Admins have no limit. */
export async function allowanceError(userId: string, isAdmin: boolean): Promise<string | null> {
  if (isAdmin) return null;
  const [profile, used] = await Promise.all([getProfile(userId), remixesUsed(userId)]);
  const limit = PLAN_LIMITS[profile.plan];
  if (used < limit) return null;
  return profile.plan === "free"
    ? `You've used your ${limit} free remixes this month. Upgrade to Pro for more.`
    : `You've used all ${limit} remixes this month. Your allowance resets on the 1st.`;
}

const ACCENTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

/** Saves a finished remix as an asset: the base rig's skeleton with the new atlas and pages. */
async function saveRemixAsset(
  userId: string,
  jobId: string,
  input: RemixInput,
  base: AssetRow,
  result: { name: string; atlas: string; textures: string[] },
): Promise<string> {
  const profile = await getProfile(userId);
  const name = result.name || `${base.name} Remix`;
  // Readable slug + the job's suffix for uniqueness, e.g. "crimson-ninja-wandering-monk-3f9a1c2b".
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = `${slug || "remix"}-${jobId.slice(4)}`;
  const accent = input.keepPalette ? base.accent : ACCENTS[(ACCENTS.indexOf(base.accent) + 1) % ACCENTS.length];

  check(
    await db().from("assets").insert({
      id,
      owner_id: userId,
      author_id: userId,
      author_name: profile.name || "Anonymous",
      name,
      description: `Remix of ${base.name}: ${input.prompt}`,
      category: base.category,
      style: input.style === "auto" ? base.style : input.style,
      tags: [...new Set([...base.tags, "remix"])],
      prompt: input.prompt,
      remix_of: base.id,
      remix_of_name: base.name,
      visibility: input.visibility,
      spine_version: base.spine_version,
      bone_count: base.bone_count,
      slot_count: base.slot_count,
      animations: base.animations,
      accent,
      files: { ...base.files, atlas: result.atlas, textures: result.textures },
    }),
  );
  return id;
}

/** The job if it's the user's, with live progress while it runs. */
export async function getRemixJobView(userId: string, jobId: string): Promise<RemixJobView | null> {
  const row = check(
    await db()
      .from("remix_jobs")
      .select(REMIX_JOB_COLUMNS)
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle()
      .overrideTypes<RemixJobRow | null, { merge: false }>(),
  );
  // Part fixes share the table (they count toward the allowance) but have their own view.
  if (!row || row.input.kind === "parts") return null;

  const [base, asset] = await Promise.all([
    row.base_asset_id ? getAssetRow(row.base_asset_id, userId) : null,
    row.asset_id ? getAssetRow(row.asset_id, userId) : null,
  ]);
  const live = row.status === "running" || row.status === "queued" ? (row.api_version === "v1" ? getV1Job(jobId) : getV2Job(jobId)) : null;
  // A running row with no live job means the server restarted mid-remix (see markStaleJobsFailed).
  const lost = !live && (row.status === "running" || row.status === "queued");
  // The runner has finished but onSettled hasn't recorded it yet: keep the client polling.
  const settling = live?.status === "succeeded" || live?.status === "failed";
  const baseAsset = base && toSpineAsset(base);
  const input = parseStoredInput(row.input);

  return {
    id: row.id,
    status: lost ? "failed" : live ? (live.status === "queued" ? "queued" : "running") : row.status,
    progress: live ? (settling ? 0.99 : live.progress) : row.status === "succeeded" ? 1 : 0,
    stage: live ? (settling ? "Saving remix" : live.stage) : row.status === "succeeded" ? "Done" : "Failed",
    input,
    apiVersion: row.api_version,
    base: baseAsset
      ? {
          id: baseAsset.id,
          name: baseAsset.name,
          category: baseAsset.category,
          accent: baseAsset.accent,
          animations: baseAsset.animations,
          files: baseAsset.files,
          tint: baseAsset.tint,
        }
      : { id: row.base_asset_id ?? "", name: "Deleted rig", category: "character", accent: "chart-1", animations: [], files: null, tint: null },
    createdAt: row.created_at,
    editPrompt: live?.editPrompt ?? row.edit_prompt,
    promptStatus: live?.promptStatus ?? (row.prompt_status === "reworded" ? "reworded" : "original"),
    referenceUrl: input.referenceImage ? objectUrl(input.referenceImage) : null,
    asset: live ? null : asset && toSpineAsset(asset),
    error: lost ? "The remix service restarted. Try again." : live ? null : row.error,
  };
}

function parseStoredInput(value: Record<string, unknown>): RemixInput {
  const style = REMIX_STYLES.find((s) => s === value.style) ?? ("auto" satisfies RemixStyle);
  return {
    baseAssetId: String(value.baseAssetId ?? ""),
    prompt: String(value.prompt ?? ""),
    style,
    strength: typeof value.strength === "number" ? value.strength : 0.5,
    keepPalette: value.keepPalette === true,
    keepPosition: value.keepPosition === true,
    keepSize: value.keepSize === true,
    keepOutline: value.keepOutline === true,
    visibility: value.visibility === "public" ? "public" : "private",
    referenceImage: typeof value.referenceImage === "string" ? value.referenceImage : null,
  };
}

/** Longest side of a stored reference image; Muse Spark sees it at this size. */
const REFERENCE_MAX_SIDE = 1024;

/** The upload as a flattened JPEG of at most REFERENCE_MAX_SIDE, or null if it isn't a readable image. */
async function normalizeReference(image: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(image, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: REFERENCE_MAX_SIDE, height: REFERENCE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** On startup: jobs still marked running were lost with the previous process, so stop counting them. */
export async function markStaleJobsFailed(): Promise<void> {
  check(
    await db()
      .from("remix_jobs")
      .update({ status: "failed", error: "The remix service restarted. Try again." })
      .in("status", ["queued", "running"]),
  );
}
