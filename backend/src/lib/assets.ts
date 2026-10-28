import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset } from "./db.js";

export const ASSET_CATEGORIES = ["character", "creature", "effect", "prop", "ui"] as const;
export const SORT_OPTIONS = ["popular", "newest", "name"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export interface AssetQuery {
  q?: string;
  category?: string;
  sort?: SortOption;
  limit?: number;
}

const MAX_LIMIT = 200;

/** Public assets, searched by name, description, prompt and tags. */
export async function listPublicAssets({ q, category, sort = "popular", limit = MAX_LIMIT }: AssetQuery = {}): Promise<SpineAsset[]> {
  let query = db().from("assets").select(ASSET_COLUMNS).eq("visibility", "public");
  if (category) query = query.eq("category", category);
  // % and _ are LIKE wildcards; drop them (and backslashes) so the search is literal.
  const needle = q?.trim().toLowerCase().replace(/[%_\\]/g, "");
  if (needle) query = query.ilike("search_text", `%${needle}%`);
  const ordered =
    sort === "newest"
      ? query.order("created_at", { ascending: false })
      : sort === "name"
        ? query.order("name", { ascending: true })
        : query.order("saves", { ascending: false }).order("created_at", { ascending: false });
  const rows = check(await ordered.limit(Math.min(limit, MAX_LIMIT)).overrideTypes<AssetRow[], { merge: false }>());
  return (rows ?? []).map(toSpineAsset);
}

/** An asset row if the viewer may see it: public ones for everyone, private ones for their owner and admins. */
export async function getAssetRow(id: string, viewerId: string | null, viewerIsAdmin = false): Promise<AssetRow | null> {
  const row = check(
    await db().from("assets").select(ASSET_COLUMNS).eq("id", id).maybeSingle().overrideTypes<AssetRow | null, { merge: false }>(),
  );
  if (!row) return null;
  if (row.visibility === "private" && row.owner_id !== viewerId && !viewerIsAdmin) return null;
  return row;
}

export async function getAsset(id: string, viewerId: string | null, viewerIsAdmin = false): Promise<SpineAsset | null> {
  const row = await getAssetRow(id, viewerId, viewerIsAdmin);
  return row && toSpineAsset(row);
}

/** Assets by id, keeping the order of `ids`. Skips private assets the viewer doesn't own. */
export async function getAssetsByIds(ids: string[], viewerId: string): Promise<SpineAsset[]> {
  if (ids.length === 0) return [];
  const rows = check(await db().from("assets").select(ASSET_COLUMNS).in("id", ids).overrideTypes<AssetRow[], { merge: false }>()) ?? [];
  const visible = new Map(rows.filter((r) => r.visibility === "public" || r.owner_id === viewerId).map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = visible.get(id);
    return row ? [toSpineAsset(row)] : [];
  });
}

/** Public remixes built on `assetId`, most saved first. */
export async function listPublicRemixesOf(assetId: string, limit: number): Promise<SpineAsset[]> {
  const rows = check(
    await db()
      .from("assets")
      .select(ASSET_COLUMNS)
      .eq("visibility", "public")
      .eq("remix_of", assetId)
      .order("saves", { ascending: false })
      .limit(Math.min(limit, MAX_LIMIT))
      .overrideTypes<AssetRow[], { merge: false }>(),
  );
  return (rows ?? []).map(toSpineAsset);
}

/** Assets the user made, newest first. */
export async function listOwnedAssets(userId: string): Promise<SpineAsset[]> {
  const rows = check(
    await db()
      .from("assets")
      .select(ASSET_COLUMNS)
      .eq("owner_id", userId)
      .order("created_at", { ascending: false })
      .limit(MAX_LIMIT)
      .overrideTypes<AssetRow[], { merge: false }>(),
  );
  return (rows ?? []).map(toSpineAsset);
}
