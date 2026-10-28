import { AiTimeoutError } from "./ai-fetch.js";
import { getAssetRow } from "./assets.js";
import { REMIX_JOB_TIMEOUT_MS } from "./config.js";
import { ASSET_COLUMNS, REMIX_JOB_COLUMNS, check, db, toSpineAsset, type AssetRow, type RemixJobRow, type SpineAsset } from "./db.js";
import { newRemixJobId } from "./jobs.js";
import { allowanceError } from "./remix-jobs.js";
import { objectUrl } from "./storage.js";
import { PART_FIX_SOURCES, type PartFixInput, type RemixStatus } from "./types.js";
import { runPartFix } from "../v2/lib/part-fix.js";

// Part fixes repaint a few regions of a finished remix and update it in place. Each one is a
// remix_jobs row (input.kind = "parts", asset_id = the remix), so it counts toward the monthly
// allowance like a remix; live progress is kept here and resets on restart.

/** The job shape the frontend expects (PartFixJob in frontend/app/lib/types.ts). */
export interface PartFixJobView {
  id: string;
  assetId: string;
  status: RemixStatus;
  progress: number;
  stage: string;
  input: PartFixInput;
  createdAt: string;
  /** The updated remix once the fix succeeds. */
  asset: SpineAsset | null;
  error: string | null;
}

interface LiveFix {
  assetId: string;
  status: RemixStatus;
  progress: number;
  stage: string;
}

const live = new Map<string, LiveFix>();

export type StartPartFixResult = { ok: true; job: PartFixJobView } | { ok: false; status: 402 | 404 | 409; error: string };

export async function startPartFix(userId: string, assetId: string, input: PartFixInput, isAdmin: boolean): Promise<StartPartFixResult> {
  const [limitError, asset] = await Promise.all([allowanceError(userId, isAdmin), getAssetRow(assetId, userId)]);
  if (!asset?.files || asset.owner_id !== userId) return { ok: false, status: 404, error: "You can only fix parts of your own remixes." };
  if (limitError) return { ok: false, status: 402, error: limitError };
  // Two fixes on one remix would each start from the same pages, and the later save would undo the other.
  if ([...live.values()].some((j) => j.assetId === assetId && (j.status === "queued" || j.status === "running"))) {
    return { ok: false, status: 409, error: "Another fix on this remix is still running. Wait for it to finish." };
  }

  const [original, editPrompt] = await Promise.all([asset.remix_of ? getAssetRow(asset.remix_of, userId) : null, remixEditPrompt(asset.id)]);
  const id = newRemixJobId();
  check(
    await db().from("remix_jobs").insert({
      id,
      user_id: userId,
      base_asset_id: asset.id,
      api_version: "v2",
      input: { kind: "parts", ...input },
      status: "running",
      asset_id: asset.id,
    }),
  );

  const job: LiveFix = { assetId: asset.id, status: "queued", progress: 0, stage: "Queued" };
  live.set(id, job);
  void runJob(id, job, asset, original, editPrompt, input);

  const view = await getPartFixView(userId, id);
  if (!view) throw new Error(`Part fix ${id} vanished right after it was created`);
  return { ok: true, job: view };
}

/** Muse's edit prompt from the job that made the remix, which names its materials and colours. */
async function remixEditPrompt(assetId: string): Promise<string | null> {
  const rows = check(
    await db()
      .from("remix_jobs")
      .select("edit_prompt, input")
      .eq("asset_id", assetId)
      .eq("status", "succeeded")
      .order("created_at", { ascending: true })
      .limit(10)
      .overrideTypes<Pick<RemixJobRow, "edit_prompt" | "input">[], { merge: false }>(),
  );
  // Part fixes on this remix share its asset_id; the remix job is the one without a kind.
  return rows?.find((r) => r.input.kind === undefined && r.edit_prompt)?.edit_prompt ?? null;
}

async function runJob(id: string, job: LiveFix, asset: AssetRow, original: AssetRow | null, editPrompt: string | null, input: PartFixInput) {
  if (!asset.files) return;
  job.status = "running";
  const deadline = AbortSignal.timeout(REMIX_JOB_TIMEOUT_MS);
  let error: string | null = null;
  try {
    const result = await runPartFix(
      id,
      {
        ...input,
        remix: { atlasUrl: objectUrl(asset.files.atlas), premultipliedAlpha: asset.files.premultipliedAlpha, prompt: asset.prompt, editPrompt, style: asset.style },
        original: original?.files ? { atlasUrl: objectUrl(original.files.atlas), premultipliedAlpha: original.files.premultipliedAlpha } : null,
      },
      (progress, stage) => {
        job.progress = Math.min(Math.max(progress, 0), 0.99);
        job.stage = stage;
      },
      deadline,
    );
    deadline.throwIfAborted();
    job.progress = 0.99;
    job.stage = "Saving the remix";
    // Re-read the row so a skeleton saved from the tweak panel meanwhile isn't overwritten.
    const current = await getAssetRow(asset.id, asset.owner_id);
    if (!current?.files) throw new Error("The remix was deleted while its parts were being fixed.");
    check(
      await db()
        .from("assets")
        .update({ files: { ...current.files, atlas: result.atlas, textures: result.textures } })
        .eq("id", asset.id)
        .select(ASSET_COLUMNS)
        .single(),
    );
  } catch (e) {
    console.error(`Part fix ${id} failed`, e);
    error = deadline.aborted || e instanceof AiTimeoutError
      ? "The fix took too long. Try again."
      : e instanceof Error
        ? e.message
        : "Something went wrong. Try again with a different prompt.";
  }
  try {
    check(await db().from("remix_jobs").update({ status: error ? "failed" : "succeeded", error }).eq("id", id));
  } catch (e) {
    console.error(`Recording part fix ${id} failed`, e);
  }
  live.delete(id);
}

/** The part fix if it's the user's, with live progress while it runs. */
export async function getPartFixView(userId: string, jobId: string): Promise<PartFixJobView | null> {
  const row = check(
    await db()
      .from("remix_jobs")
      .select(REMIX_JOB_COLUMNS)
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle()
      .overrideTypes<RemixJobRow | null, { merge: false }>(),
  );
  if (!row || row.input.kind !== "parts") return null;

  const job = live.get(jobId);
  const running = row.status === "running" || row.status === "queued";
  // A running row with no live job means the server restarted mid-fix (see markStaleJobsFailed).
  const lost = running && !job;
  const asset = !running && row.asset_id ? await getAssetRow(row.asset_id, userId) : null;
  const { regions, prompt, source } = row.input;

  return {
    id: row.id,
    assetId: row.asset_id ?? "",
    status: lost ? "failed" : job ? job.status : row.status,
    progress: job ? job.progress : row.status === "succeeded" ? 1 : 0,
    stage: job ? job.stage : row.status === "succeeded" ? "Done" : "Failed",
    input: {
      regions: Array.isArray(regions) ? regions.filter((r): r is string => typeof r === "string") : [],
      prompt: typeof prompt === "string" ? prompt : "",
      source: PART_FIX_SOURCES.find((s) => s === source) ?? "original",
    },
    createdAt: row.created_at,
    asset: row.status === "succeeded" && asset ? toSpineAsset(asset) : null,
    error: lost ? "The remix service restarted. Try again." : job ? null : row.error,
  };
}
