import { randomUUID } from "node:crypto";
import { getAssetRow } from "./assets.js";
import { getProfile } from "./billing.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset } from "./db.js";

export type CopyRemixResult =
  | { ok: true; asset: SpineAsset; created: boolean }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Gives the user their own copy of a remix so they can tweak it and fix its parts.
 * No model runs, so it doesn't count toward the monthly allowance. The copy shares the source's
 * storage keys: every save writes a new folder, so later edits on either side never touch the other.
 * It keeps the source's remix_of, so part fixes still start from the original rig, and copy_of
 * credits the source. Copying the same remix again returns the existing copy.
 */
export async function copyRemix(userId: string, sourceId: string, isAdmin: boolean): Promise<CopyRemixResult> {
  const source = await getAssetRow(sourceId, userId, isAdmin);
  if (!source) return { ok: false, status: 404, error: "That remix no longer exists." };
  if (source.owner_id === userId) return { ok: true, asset: toSpineAsset(source), created: false };
  // Original rigs have no remix_of; they're remixed, not copied.
  if (!source.remix_of || !source.files) return { ok: false, status: 400, error: "Only finished remixes can be copied." };

  const existing = check(
    await db()
      .from("assets")
      .select(ASSET_COLUMNS)
      .eq("owner_id", userId)
      .eq("copy_of", source.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
      .overrideTypes<AssetRow | null, { merge: false }>(),
  );
  if (existing) return { ok: true, asset: toSpineAsset(existing), created: false };

  const profile = await getProfile(userId);
  const slug = source.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const row = check(
    await db()
      .from("assets")
      .insert({
        id: `${slug || "remix"}-copy-${randomUUID().slice(0, 8)}`,
        owner_id: userId,
        author_id: userId,
        author_name: profile.name || "Anonymous",
        name: source.name,
        description: source.description,
        category: source.category,
        style: source.style,
        tags: source.tags,
        prompt: source.prompt,
        remix_of: source.remix_of,
        remix_of_name: source.remix_of_name,
        copy_of: source.id,
        copy_of_name: source.name,
        // Every remix is public for now.
        visibility: "public",
        spine_version: source.spine_version,
        bone_count: source.bone_count,
        slot_count: source.slot_count,
        animations: source.animations,
        accent: source.accent,
        thumbnail_url: source.thumbnail_url,
        files: source.files,
        tint: source.tint,
        // Same files, so the same fingerprints.
        art_hash: source.art_hash,
        rig_hash: source.rig_hash,
      })
      .select(ASSET_COLUMNS)
      .single()
      .overrideTypes<AssetRow, { merge: false }>(),
  );
  return { ok: true, asset: toSpineAsset(row), created: true };
}
