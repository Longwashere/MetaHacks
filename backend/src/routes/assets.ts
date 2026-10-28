import { Router } from "express";
import {
  ASSET_CATEGORIES,
  SORT_OPTIONS,
  getAsset,
  getAssetRow,
  listPublicAssets,
  listPublicRemixesOf,
  type SortOption,
} from "../lib/assets.js";
import { isAdminOf, optionalUser, viewerIdOf } from "../lib/auth.js";
import { parseLimit } from "../lib/validate.js";

// Public catalogue. Private assets are only returned to their owner and admins (send the access token).
export const assetsRouter = Router();
assetsRouter.use(optionalUser);

/** GET /assets?q=&category=&sort=popular|newest|name&limit= → SpineAsset[] (public only) */
assetsRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
  const category = ASSET_CATEGORIES.find((c) => c === req.query.category);
  const sort: SortOption = SORT_OPTIONS.find((s) => s === req.query.sort) ?? "popular";
  res.json(await listPublicAssets({ q, category, sort, limit: parseLimit(req.query.limit, 200) }));
});

/** GET /assets/:id → SpineAsset, or 404 (also for someone else's private asset, unless the viewer is an admin) */
assetsRouter.get("/:id", async (req, res) => {
  const asset = await getAsset(req.params.id, viewerIdOf(res), isAdminOf(res));
  if (!asset) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  res.json(asset);
});

/** GET /assets/:id/related?limit= → public assets in the same category */
assetsRouter.get("/:id/related", async (req, res) => {
  const row = await getAssetRow(req.params.id, viewerIdOf(res), isAdminOf(res));
  if (!row) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  const limit = parseLimit(req.query.limit, 4, 50);
  const sameCategory = await listPublicAssets({ category: row.category, sort: "popular", limit: limit + 1 });
  res.json(sameCategory.filter((a) => a.id !== row.id).slice(0, limit));
});

/** GET /assets/:id/remixes?limit= → public remixes built on this rig */
assetsRouter.get("/:id/remixes", async (req, res) => {
  res.json(await listPublicRemixesOf(req.params.id, parseLimit(req.query.limit, 8, 50)));
});
