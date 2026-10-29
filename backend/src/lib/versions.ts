import { randomUUID } from "node:crypto";
import { getAssetRow } from "./assets.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetFileKeys, type AssetRow, type SpineAsset } from "./db.js";
import { copyRegionAttachments } from "./mesh.js";
import { objectUrl, putFile } from "./storage.js";

// A remix's version history (asset_versions). Part fixes add a row when they save; restoring
// makes an earlier version's atlas and pages current again without adding one, since the state
// it leaves is still in the list to restore. Nothing here calls a model, so restores don't count
// toward the monthly allowance.

interface VersionRow {
  id: string;
  asset_id: string;
  user_id: string;
  kind: "part_fix";
  job_id: string | null;
  label: string;
  regions: string[];
  boxed: string[];
  files_before: AssetFileKeys;
  files_after: AssetFileKeys;
  created_at: string;
}

/** One state of a remix, newest first (AssetVersion in frontend/app/lib/types.ts). */
export interface AssetVersionView {
  /** The version row, or "original" for the remix before its first change. */
  id: string;
  kind: "original" | "part_fix";
  /** The fix's prompt. */
  label: string;
  regions: string[];
  createdAt: string;
  /** True for the version the remix's sprite sheet is on now. */
  current: boolean;
}

export const ORIGINAL_VERSION = "original";
const ORIGINAL_LABEL = "Original remix";

/** Records a part fix that changed `assetId`'s files from `before` to `after`. Never throws. */
export async function recordPartFixVersion(
  asset: Pick<AssetRow, "id" | "owner_id">,
  jobId: string,
  label: string,
  regions: string[],
  boxed: string[],
  before: AssetFileKeys,
  after: AssetFileKeys,
): Promise<void> {
  if (!asset.owner_id) return;
  try {
    check(
      await db().from("asset_versions").insert({
        id: newVersionId(),
        asset_id: asset.id,
        user_id: asset.owner_id,
        kind: "part_fix",
        job_id: jobId,
        label,
        regions,
        boxed,
        files_before: before,
        files_after: after,
      }),
    );
  } catch (error) {
    console.error(`Recording the version for part fix ${jobId} failed`, error);
  }
}

/** The remix's versions, newest first, ending with the original; null if it isn't the user's; empty with no changes yet. */
export async function listVersions(userId: string, assetId: string): Promise<AssetVersionView[] | null> {
  const asset = await getAssetRow(assetId, userId);
  if (!asset?.files || asset.owner_id !== userId) return null;
  const rows = await versionRows(asset.id);
  if (rows.length === 0) return [];

  rows.reverse();
  const files = asset.files;
  const isCurrent = (f: AssetFileKeys) => f.atlas === files.atlas && f.textures.join("\n") === files.textures.join("\n");
  const views: AssetVersionView[] = [
    { id: ORIGINAL_VERSION, kind: "original", label: ORIGINAL_LABEL, regions: [], createdAt: asset.created_at, current: false },
    ...rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, regions: r.regions, createdAt: r.created_at, current: false })),
  ];
  // The newest version whose pages are the remix's now.
  const states = [rows[0].files_before, ...rows.map((r) => r.files_after)];
  for (let i = states.length - 1; i >= 0; i--) {
    if (isCurrent(states[i])) {
      views[i].current = true;
      break;
    }
  }
  return views.reverse();
}

export type RestoreResult = { ok: true; asset: SpineAsset } | { ok: false; status: 404; error: string };

/**
 * Makes a version's atlas and pages the remix's current ones. The current skeleton is kept, except
 * that attachments a part fix swapped for a box are copied from the version's skeleton, so a
 * restored part gets its own mesh back while other tweak edits stay. No row is added: the version
 * left behind is still listed, so restoring it undoes this. The caller checks that no
 * part fix on the remix is running, since its save would undo the restore.
 */
export async function restoreVersion(userId: string, assetId: string, versionId: string): Promise<RestoreResult> {
  const asset = await getAssetRow(assetId, userId);
  if (!asset?.files || asset.owner_id !== userId) return { ok: false, status: 404, error: "You can only restore your own remixes." };

  const rows = (await versionRows(asset.id)).reverse();
  const version = rows.find((r) => r.id === versionId);
  const targetFiles = versionId === ORIGINAL_VERSION ? rows[0]?.files_before : version?.files_after;
  if (!targetFiles) return { ok: false, status: 404, error: "That version doesn't exist." };

  const current = asset.files;
  const boxed = [...new Set(rows.flatMap((r) => r.boxed))];
  let skeleton = current.skeleton;
  if (boxed.length > 0 && targetFiles.skeleton !== current.skeleton) {
    const signal = AbortSignal.timeout(30_000);
    const [from, to] = await Promise.all([loadSkeleton(targetFiles.skeleton, signal), loadSkeleton(current.skeleton, signal)]);
    if (copyRegionAttachments(from, to, boxed) > 0) {
      const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_restore_${randomUUID().slice(0, 8)}`;
      skeleton = await putFile(folder, "skeleton.json", JSON.stringify(to));
    }
  }

  const files: AssetFileKeys = { ...current, atlas: targetFiles.atlas, textures: targetFiles.textures, premultipliedAlpha: targetFiles.premultipliedAlpha, skeleton };
  const row = check(
    await db()
      .from("assets")
      .update({ files })
      .eq("id", asset.id)
      .select(ASSET_COLUMNS)
      .single()
      .overrideTypes<AssetRow, { merge: false }>(),
  );
  return { ok: true, asset: toSpineAsset(row) };
}

/** The remix's skeleton JSON, or null for a binary .skel or one that can't be read (meshes are then left as they are). */
export async function loadSkeleton(key: string, signal: AbortSignal): Promise<unknown> {
  if (!key.toLowerCase().endsWith(".json")) return null;
  try {
    const res = await fetch(objectUrl(key), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    signal.throwIfAborted();
    console.error(`Couldn't read skeleton ${key}`, error);
    return null;
  }
}

/** The remix's version rows, newest first. */
async function versionRows(assetId: string): Promise<VersionRow[]> {
  return (
    check(
      await db()
        .from("asset_versions")
        .select("*")
        .eq("asset_id", assetId)
        .order("created_at", { ascending: false })
        .overrideTypes<VersionRow[], { merge: false }>(),
    ) ?? []
  );
}

function newVersionId(): string {
  return `ver_${randomUUID().slice(0, 8)}`;
}
