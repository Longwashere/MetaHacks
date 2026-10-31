import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset } from "./db.js";

/** Built-in categories, always listed first. Admin uploads can add more (lib/upload-tags.ts). */
export const ASSET_CATEGORIES = ["character", "creature", "effect", "prop", "ui"] as const;
/** What any category looks like; the database checks the same pattern (assets_category_check). */
const CATEGORY_PATTERN = /^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$/;

export function isCategory(value: unknown): value is string {
  return typeof value === "string" && CATEGORY_PATTERN.test(value);
}
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

/** The built-in categories, then any others public assets use, most used first. */
export async function listPublicCategories(): Promise<string[]> {
  const rows = check(await db().from("assets").select("category").eq("visibility", "public").overrideTypes<{ category: string }[], { merge: false }>()) ?? [];
  const counts = new Map<string, number>();
  for (const { category } of rows) {
    if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...ASSET_CATEGORIES, ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c)];
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

export type DeleteAssetResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

/**
 * Deletes an asset: the owner can delete their own, admins can delete any (official rigs included).
 * Library entries go with it (cascade); remix jobs and copies keep their rows with the link cleared.
 * Stored files are left alone, since copies share the source's storage keys.
 * Remixes built on this asset would lose their original (no part fixes, no copying), so the owner
 * can't delete one that has remixes; admins can, for moderation.
 */
export async function deleteAsset(id: string, userId: string, isAdmin: boolean): Promise<DeleteAssetResult> {
  const row = await getAssetRow(id, userId, isAdmin);
  if (!row || (row.owner_id !== userId && !isAdmin)) return { ok: false, status: 404, error: "You can only delete your own remixes." };
  if (!isAdmin) {
    const { count, error } = await db().from("assets").select("id", { count: "exact", head: true }).eq("remix_of", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    if (count) {
      return {
        ok: false,
        status: 409,
        error: `${count} ${count === 1 ? "remix is" : "remixes are"} built on this one, so it can't be deleted. Make it private instead.`,
      };
    }
  }
  check(await db().from("assets").delete().eq("id", id));
  return { ok: true };
}
