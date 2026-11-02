import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { deleteAsset, getAssetRow, getAssetsByIds, listOwnedAssets } from "../lib/assets.js";
import { isAdminOf, requireUser, userIdOf } from "../lib/auth.js";
import { AiTimeoutError } from "../lib/ai-fetch.js";
import { AnimateError, deleteAnimation, editAnimation, renameAnimation, generateAnimation, parseAnimateInput } from "../lib/animate.js";
import { parseAutoTweakInput, reviewAutoTweak } from "../lib/auto-tweak.js";
import { copyRemix } from "../lib/copies.js";
import { getPartFixView, isFixRunning, startPartFix } from "../lib/part-fix-jobs.js";
import { listVersions, restoreVersion } from "../lib/versions.js";
import { creditHistory, getAccount, getProfile, recordDownload, setDisplayName } from "../lib/billing.js";
import { MUSE_TIMEOUT_MS } from "../lib/config.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow } from "../lib/db.js";
import { rigHashOf } from "../lib/fingerprint.js";
import { createUploads, parseUploadInput, publishBlocked } from "../lib/uploads.js";
import { REMIX_API_VERSIONS, getRemixJobView, getRemixJobViewForAsset, startRemix } from "../lib/remix-jobs.js";
import { putFile } from "../lib/storage.js";
import { MAX_REFERENCE_BYTES, parseDisplayName, parsePartFixInput, parseReferenceImage, parseRemixInput, parseSkeleton } from "../lib/validate.js";

/** Large rigs export several hundred KB of JSON; leave headroom without accepting anything huge. */
const MAX_SKELETON_BYTES = "8mb";
/** Uploads carry up to three rigs' page images as base64; the page splits bigger batches into several requests. */
const MAX_UPLOAD_BYTES = "64mb";
/** Auto-tweak posts a few snapshot images as data URLs. */
const MAX_AUTO_TWEAK_BYTES = "12mb";
/** Uploads are closed to free users for the hackathon. */
const UPLOADS_PRO_ONLY = "Uploading rigs needs a Pro plan.";

// Everything scoped to the signed-in user. Mounted before the global JSON parser so the skeleton
// route can use its own, larger body limit.
export const meRouter = Router();
meRouter.use(requireUser);
const json = express.json();
/** A remix request can carry a reference image as a base64 data URL, about 4/3 of its bytes. */
const MAX_REMIX_BODY_BYTES = Math.ceil(MAX_REFERENCE_BYTES * 1.4) + 64 * 1024;

/** GET /me → Account: profile, plan, subscription and this month's remix usage */
meRouter.get("/", async (_req, res) => {
  res.json(await getAccount(userIdOf(res), isAdminOf(res)));
});

/** GET /me/credits → { jobs: CreditHistoryEntry[] }: this month's remixes and part fixes with what each cost, newest first */
meRouter.get("/credits", async (_req, res) => {
  res.json({ jobs: await creditHistory(userIdOf(res)) });
});

/** PATCH /me  body = { name } → Account, or 400 { error }. Also renames the user on all their assets. */
meRouter.patch("/", json, async (req, res) => {
  const parsed = parseDisplayName(req.body?.name);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const userId = userIdOf(res);
  await setDisplayName(userId, parsed.name);
  res.json(await getAccount(userId, isAdminOf(res)));
});

// ---------------------------------------------------------------------------
// Library (bookmarks)
// ---------------------------------------------------------------------------

async function libraryIds(userId: string): Promise<string[]> {
  const rows = check(
    await db()
      .from("library")
      .select("asset_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .overrideTypes<{ asset_id: string }[], { merge: false }>(),
  );
  return (rows ?? []).map((r) => r.asset_id);
}

/** GET /me/library/ids → string[] */
meRouter.get("/library/ids", async (_req, res) => {
  res.json(await libraryIds(userIdOf(res)));
});

/** GET /me/library → SpineAsset[], most recently saved first */
meRouter.get("/library", async (_req, res) => {
  const userId = userIdOf(res);
  res.json(await getAssetsByIds(await libraryIds(userId), userId));
});

/** PUT /me/library/:assetId → 204. Idempotent. */
meRouter.put("/library/:assetId", async (req, res) => {
  const userId = userIdOf(res);
  if (!(await getAssetRow(req.params.assetId, userId, isAdminOf(res)))) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  check(
    await db()
      .from("library")
      .upsert({ user_id: userId, asset_id: req.params.assetId }, { onConflict: "user_id,asset_id", ignoreDuplicates: true }),
  );
  res.status(204).end();
});

/** DELETE /me/library/:assetId → 204. Idempotent. */
meRouter.delete("/library/:assetId", async (req, res) => {
  check(await db().from("library").delete().eq("user_id", userIdOf(res)).eq("asset_id", req.params.assetId));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Uploads (the user's own rigs)
// ---------------------------------------------------------------------------

/**
 * POST /me/uploads  body = { category?, visibility, rigs: [{ name, skeleton, atlas, pages: [{ name, data }] }] }
 * → 201 { assets: SpineAsset[], notes }, or 400 { error, rigErrors? } (nothing stored). `data` is base64 PNG.
 * `notes` maps a rig's index to a remark, e.g. that it was kept private because its art was already in the library.
 * A rig that's already in the library is a rigError. Up to 3 rigs per request; admins up to 50, and Muse Spark
 * tags admin uploads in the background. See lib/uploads.ts. Free users get 403 { error }: uploads are Pro-only
 * during the hackathon, checked before the body is parsed.
 */
meRouter.post(
  "/uploads",
  async (_req, res, next) => {
    if (!isAdminOf(res) && (await getProfile(userIdOf(res))).plan === "free") {
      res.status(403).json({ error: UPLOADS_PRO_ONLY });
      return;
    }
    next();
  },
  express.json({ limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const isAdmin = isAdminOf(res);
    const parsed = parseUploadInput(req.body, isAdmin);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, rigErrors: parsed.rigErrors });
      return;
    }
    const result = await createUploads(userIdOf(res), parsed.input, isAdmin);
    if (!result.ok) {
      res.status(400).json({ error: result.error, rigErrors: result.rigErrors });
      return;
    }
    res.status(201).json({ assets: result.assets, notes: result.notes });
  },
);

// ---------------------------------------------------------------------------
// Downloads (monthly allowance)
// ---------------------------------------------------------------------------

/**
 * POST /me/downloads/:assetId → { used, limit, resetsAt } when the download is allowed and recorded,
 * 402 { error, used, limit, resetsAt } when the month's allowance is used up, 404 if the asset isn't visible.
 */
meRouter.post("/downloads/:assetId", async (req, res) => {
  const userId = userIdOf(res);
  const isAdmin = isAdminOf(res);
  const row = await getAssetRow(req.params.assetId, userId, isAdmin);
  if (!row) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }
  const { allowed, ...usage } = await recordDownload(userId, row.id, isAdmin);
  if (!allowed) {
    res.status(402).json({ error: `You've used your ${usage.limit} free downloads this month. Upgrade to Pro for unlimited downloads.`, ...usage });
    return;
  }
  res.json(usage);
});

// ---------------------------------------------------------------------------
// The user's remixes
// ---------------------------------------------------------------------------

async function ownedAsset(userId: string, assetId: string): Promise<AssetRow | null> {
  const row = await getAssetRow(assetId, userId);
  return row?.owner_id === userId ? row : null;
}

/** GET /me/remixes → SpineAsset[], newest first */
meRouter.get("/remixes", async (_req, res) => {
  res.json(await listOwnedAssets(userIdOf(res)));
});

/**
 * PATCH /me/remixes/:assetId  body = { visibility: "public" | "private" } → SpineAsset, or 409 { error } when an
 * upload reuses art someone else put in the library first (it stays private). Admins can change any asset.
 */
meRouter.patch("/remixes/:assetId", json, async (req, res) => {
  const visibility: unknown = req.body?.visibility;
  if (visibility !== "public" && visibility !== "private") {
    res.status(400).json({ error: 'Expected { visibility: "public" | "private" }.' });
    return;
  }
  const userId = userIdOf(res);
  const allowed = isAdminOf(res) ? await getAssetRow(req.params.assetId, userId, true) : await ownedAsset(userId, req.params.assetId);
  if (!allowed) {
    res.status(404).json({ error: "You can only change your own remixes." });
    return;
  }
  const blocked = visibility === "public" && !isAdminOf(res) ? await publishBlocked(allowed.id, userId) : null;
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }
  const row = check(
    await db()
      .from("assets")
      .update({ visibility })
      .eq("id", req.params.assetId)
      .select(ASSET_COLUMNS)
      .single()
      .overrideTypes<AssetRow, { merge: false }>(),
  );
  res.json(toSpineAsset(row));
});

/** DELETE /me/remixes/:assetId → 204, 404 (not theirs) or 409 (other remixes are built on it). Admins can delete any asset. */
meRouter.delete("/remixes/:assetId", async (req, res) => {
  const result = await deleteAsset(req.params.assetId, userIdOf(res), isAdminOf(res));
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

/**
 * POST /me/remixes/:assetId/copy → 201 SpineAsset (new copy), 200 SpineAsset (the user's own remix
 * or their existing copy of it), 400/404 { error }. Free: no model runs. See lib/copies.ts.
 */
meRouter.post("/remixes/:assetId/copy", async (req, res) => {
  const result = await copyRemix(userIdOf(res), req.params.assetId, isAdminOf(res));
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(result.created ? 201 : 200).json(result.asset);
});

/**
 * POST /me/remixes/:assetId/skeleton  body = { skeleton: <Spine 4.2 JSON>, skin: string | null } → SpineAsset
 * Stores the skeleton the user edited on the remix page (tweaks baked in) and points the remix at it.
 */
meRouter.post("/remixes/:assetId/skeleton", express.json({ limit: MAX_SKELETON_BYTES }), async (req, res) => {
  const skeleton = parseSkeleton(req.body?.skeleton);
  const skin: unknown = req.body?.skin ?? null;
  if (!skeleton || (skin !== null && (typeof skin !== "string" || skin.length > 200))) {
    res.status(400).json({ error: "Expected { skeleton, skin } with a Spine skeleton JSON." });
    return;
  }
  const userId = userIdOf(res);
  const asset = await ownedAsset(userId, req.params.assetId);
  if (!asset?.files) {
    res.status(404).json({ error: "You can only save edits to your own remixes." });
    return;
  }

  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_tweak_${randomUUID().slice(0, 8)}`;
  const key = await putFile(folder, "skeleton.json", JSON.stringify(skeleton));
  const row = check(
    await db()
      .from("assets")
      .update({ files: { ...asset.files, skeleton: key, skin: skin ?? asset.files.skin }, rig_hash: rigHashOf(skeleton) })
      .eq("id", asset.id)
      .select(ASSET_COLUMNS)
      .single()
      .overrideTypes<AssetRow, { merge: false }>(),
  );
  res.json(toSpineAsset(row));
});

/**
 * POST /me/remixes/:assetId/auto-tweak  body = AutoTweakInput → AutoTweakReview
 * One Muse Spark call that reviews the measured part fixes against snapshots of the original
 * and the remix. Nothing is stored: the page applies the result as live tweaks.
 */
meRouter.post("/remixes/:assetId/auto-tweak", express.json({ limit: MAX_AUTO_TWEAK_BYTES }), async (req, res) => {
  const input = parseAutoTweakInput(req.body);
  if (!input) {
    res.status(400).json({ error: "Expected { animation, images, parts } with 1–4 snapshot images." });
    return;
  }
  if (!(await ownedAsset(userIdOf(res), req.params.assetId))) {
    res.status(404).json({ error: "You can only auto-tweak your own remixes." });
    return;
  }
  try {
    res.json(await reviewAutoTweak(req.params.assetId, input, AbortSignal.timeout(MUSE_TIMEOUT_MS)));
  } catch (error) {
    console.error("Auto-tweak review failed", error);
    res.status(502).json({ error: error instanceof Error && !(error instanceof AiTimeoutError) ? error.message : "Muse took too long to review the rig. Try again." });
  }
});

/**
 * POST /me/remixes/:assetId/animations  body = { prompt, durationSec, loop, skeleton? } → 201 AnimateResult
 * One Muse Spark call writes a new animation's keyframes; it's saved into the remix's skeleton.
 * `skeleton` is only needed when the stored skeleton is a binary .skel. Doesn't use the allowance.
 */
meRouter.post("/remixes/:assetId/animations", express.json({ limit: MAX_SKELETON_BYTES }), async (req, res) => {
  const input = parseAnimateInput(req.body);
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  const asset = await ownedAsset(userIdOf(res), req.params.assetId);
  if (!asset?.files) {
    res.status(404).json({ error: "You can only animate your own remixes." });
    return;
  }
  try {
    res.status(201).json(await generateAnimation(asset, input, AbortSignal.timeout(MUSE_TIMEOUT_MS * 2)));
  } catch (error) {
    if (error instanceof AnimateError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("Generating an animation failed", error);
    res.status(502).json({ error: error instanceof AiTimeoutError ? "Muse took too long to write the animation. Try again." : "Couldn't make the animation. Try again." });
  }
});

/**
 * POST /me/remixes/:assetId/animations/:name/edit  body = { prompt, durationSec, loop, images?, keepOriginal? } → 201 AnimateResult
 * Muse reworks one of the remix's generated animations from the edit request. It replaces the
 * original under its name unless `keepOriginal`, which adds it beside it. Doesn't use the allowance.
 */
meRouter.post("/remixes/:assetId/animations/:name/edit", express.json({ limit: MAX_SKELETON_BYTES }), async (req, res) => {
  const input = parseAnimateInput(req.body);
  const keepOriginal: unknown = req.body?.keepOriginal ?? false;
  const name = req.params.name;
  if ("error" in input || typeof keepOriginal !== "boolean" || !name || name.length > 200) {
    res.status(400).json({ error: "error" in input ? input.error : "Expected { prompt, durationSec, loop, keepOriginal? } and an animation name." });
    return;
  }
  const asset = await ownedAsset(userIdOf(res), req.params.assetId);
  if (!asset?.files) {
    res.status(404).json({ error: "You can only edit animations on your own remixes." });
    return;
  }
  try {
    res.status(201).json(await editAnimation(asset, name, input, keepOriginal, AbortSignal.timeout(MUSE_TIMEOUT_MS * 2)));
  } catch (error) {
    if (error instanceof AnimateError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("Editing an animation failed", error);
    res.status(502).json({ error: error instanceof AiTimeoutError ? "Muse took too long to edit the animation. Try again." : "Couldn't edit the animation. Try again." });
  }
});

/**
 * PATCH /me/remixes/:assetId/animations/:name  body = { name } → SpineAsset with it renamed, 400
 * (one of the rig's own animations, or no usable name), 404, or 409 (the name is taken, or the
 * skeleton changed meanwhile). Only generated animations can be renamed.
 */
meRouter.patch("/remixes/:assetId/animations/:name", json, async (req, res) => {
  const name = req.params.name;
  const newName: unknown = req.body?.name;
  if (!name || name.length > 200 || typeof newName !== "string" || newName.length > 200) {
    res.status(400).json({ error: "Expected { name } with the animation's new name." });
    return;
  }
  const asset = await ownedAsset(userIdOf(res), req.params.assetId);
  if (!asset?.files) {
    res.status(404).json({ error: "You can only rename animations on your own remixes." });
    return;
  }
  try {
    res.json(await renameAnimation(asset, name, newName));
  } catch (error) {
    if (error instanceof AnimateError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

/**
 * DELETE /me/remixes/:assetId/animations/:name → SpineAsset without it, 400 (one of the rig's own
 * animations), 404 or 409 (the skeleton changed meanwhile). Only generated animations can be deleted.
 */
meRouter.delete("/remixes/:assetId/animations/:name", async (req, res) => {
  const name = req.params.name;
  if (!name || name.length > 200) {
    res.status(400).json({ error: "Name the animation to delete." });
    return;
  }
  const asset = await ownedAsset(userIdOf(res), req.params.assetId);
  if (!asset?.files) {
    res.status(404).json({ error: "You can only delete animations from your own remixes." });
    return;
  }
  try {
    res.json(await deleteAnimation(asset, name));
  } catch (error) {
    if (error instanceof AnimateError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Remix jobs
// ---------------------------------------------------------------------------

/**
 * POST /me/remix-jobs  body = RemixInput & { apiVersion: "v1" | "v2" | "v3", referenceImage?: data URL }
 * → 202 RemixJob, 400 { errors }, or 402 { error } when the monthly allowance is used up.
 */
meRouter.post("/remix-jobs", express.json({ limit: MAX_REMIX_BODY_BYTES }), async (req, res) => {
  const parsed = parseRemixInput(req.body);
  const apiVersion = REMIX_API_VERSIONS.find((v) => v === req.body?.apiVersion);
  const reference = parseReferenceImage(req.body?.referenceImage);
  if ("errors" in parsed || !apiVersion || "error" in reference) {
    res.status(400).json({
      errors: {
        ...("errors" in parsed ? parsed.errors : {}),
        ...(apiVersion ? {} : { apiVersion: "Choose a remix API version." }),
        ...("error" in reference ? { referenceImage: reference.error } : {}),
      },
    });
    return;
  }
  const result = await startRemix(userIdOf(res), parsed.input, apiVersion, isAdminOf(res), reference.image);
  if (!result.ok) {
    res.status(result.status).json(result.field ? { errors: { [result.field]: result.error } } : { error: result.error });
    return;
  }
  res.status(202).json(result.job);
});

/**
 * GET /me/remix-jobs/:id?eventsFrom=<n> → RemixJob, or 404 if it isn't the user's. `live.events` skips
 * the first n events (`live.eventsFrom`), for pollers that already have them.
 */
meRouter.get("/remix-jobs/:id", async (req, res) => {
  const eventsFrom = Number(req.query.eventsFrom ?? 0);
  const job = await getRemixJobView(userIdOf(res), req.params.id, Number.isSafeInteger(eventsFrom) && eventsFrom > 0 ? eventsFrom : 0);
  if (!job) {
    res.status(404).json({ error: "Remix job not found." });
    return;
  }
  res.json(job);
});

/** GET /me/remixes/:assetId/job → the RemixJob that made the user's remix (with its saved log), or 404 */
meRouter.get("/remixes/:assetId/job", async (req, res) => {
  const job = await getRemixJobViewForAsset(userIdOf(res), req.params.assetId);
  if (!job) {
    res.status(404).json({ error: "No remix job made this asset." });
    return;
  }
  res.json(job);
});

// ---------------------------------------------------------------------------
// Part fixes: repaint a few regions of a finished remix in place
// ---------------------------------------------------------------------------

/**
 * POST /me/remixes/:assetId/part-fixes  body = { regions: string[], prompt, source: "original" | "remix" }
 * → 202 PartFixJob, 400/402/404/409 { error }. Counts toward the monthly remix allowance.
 */
meRouter.post("/remixes/:assetId/part-fixes", json, async (req, res) => {
  const parsed = parsePartFixInput(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const result = await startPartFix(userIdOf(res), req.params.assetId, parsed.input, isAdminOf(res));
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(202).json(result.job);
});

/** GET /me/remixes/:assetId/versions → AssetVersion[], newest first (empty before the first part fix), or 404 */
meRouter.get("/remixes/:assetId/versions", async (req, res) => {
  const versions = await listVersions(userIdOf(res), req.params.assetId);
  if (!versions) {
    res.status(404).json({ error: "Remix not found." });
    return;
  }
  res.json(versions);
});

/**
 * POST /me/remixes/:assetId/restore  body = { versionId } → SpineAsset, 400/404/409 { error }.
 * Makes an earlier version current again. No model runs, so it doesn't count toward the allowance.
 */
meRouter.post("/remixes/:assetId/restore", json, async (req, res) => {
  const versionId: unknown = req.body?.versionId;
  if (typeof versionId !== "string" || versionId.length === 0 || versionId.length > 64) {
    res.status(400).json({ error: "Expected { versionId }." });
    return;
  }
  if (isFixRunning(req.params.assetId)) {
    res.status(409).json({ error: "A part fix on this remix is still running. Wait for it to finish." });
    return;
  }
  const result = await restoreVersion(userIdOf(res), req.params.assetId, versionId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.asset);
});

/** GET /me/part-fixes/:id → PartFixJob, or 404 if it isn't the user's */
meRouter.get("/part-fixes/:id", async (req, res) => {
  const job = await getPartFixView(userIdOf(res), req.params.id);
  if (!job) {
    res.status(404).json({ error: "Part fix not found." });
    return;
  }
  res.json(job);
});
