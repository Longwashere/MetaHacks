// Data layer for the app. Every route loader/action goes through these functions, which call the
// backend (BACKEND_URL) over HTTP. Calls for the signed-in user pass their Session, whose access
// token the backend verifies. See BACKEND.md for the endpoint contract.

import type { Session } from "~/lib/auth.server";
import type { AnimateInput, AnimateResult, AssetQuery, AutoTweakInput, AutoTweakReview, PartFixInput, PartFixJob, RemixApiVersion, RemixInput, RemixJob, SpineAsset } from "~/lib/types";

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    path: string,
  ) {
    super(`Backend ${path} failed (${status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
}

async function backend<T>(
  path: string,
  { session, method = "GET", body }: { session?: Session | null; method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new BackendError(res.status, parsed, path);
  return parsed as T;
}

/** Like backend(), but resolves to null on 404. */
async function backendOrNull<T>(path: string, options?: Parameters<typeof backend>[1]): Promise<T | null> {
  try {
    return await backend<T>(path, options);
  } catch (error) {
    if (error instanceof BackendError && error.status === 404) return null;
    throw error;
  }
}

const id = encodeURIComponent;

/** The `error` (or first field error) of a 4xx response body. */
function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const { error, errors } = body as { error?: unknown; errors?: Record<string, unknown> };
  if (typeof error === "string") return error;
  const first = errors && Object.values(errors).find((v) => typeof v === "string");
  return typeof first === "string" ? first : fallback;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** GET /assets?q=&category=&sort= — public assets only. */
export async function listAssets(query: AssetQuery = {}): Promise<SpineAsset[]> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.category) params.set("category", query.category);
  if (query.sort) params.set("sort", query.sort);
  return backend<SpineAsset[]>(`/assets?${params}`);
}

/** GET /assets?sort=popular&limit= */
export async function listFeaturedAssets(limit = 4): Promise<SpineAsset[]> {
  return backend<SpineAsset[]>(`/assets?sort=popular&limit=${limit}`);
}

/** GET /assets/:id/related — same category, for internal linking on asset pages. */
export async function listRelatedAssets(asset: SpineAsset, limit = 4): Promise<SpineAsset[]> {
  return (await backendOrNull<SpineAsset[]>(`/assets/${id(asset.id)}/related?limit=${limit}`)) ?? [];
}

/** GET /assets/:id/remixes — public remixes built on this rig. */
export async function listRemixesOf(assetId: string, limit = 8): Promise<SpineAsset[]> {
  return backend<SpineAsset[]>(`/assets/${id(assetId)}/remixes?limit=${limit}`);
}

/** GET /assets/:id — private assets only for their owner. */
export async function getAsset(assetId: string, session: Session | null): Promise<SpineAsset | null> {
  return backendOrNull<SpineAsset>(`/assets/${id(assetId)}`, { session });
}

/**
 * For assets without exported files: a minimal Spine JSON built from the asset's metadata, so the
 * download link still gives something to open.
 */
export function buildPlaceholderSkeleton(asset: SpineAsset): object {
  return {
    skeleton: { hash: asset.id, spine: `${asset.spineVersion}.00`, x: -64, y: 0, width: 128, height: 160 },
    bones: [{ name: "root" }, { name: "body", parent: "root", y: 60 }],
    slots: [{ name: "body", bone: "body", attachment: "body" }],
    skins: [{ name: "default", attachments: { body: { body: { width: 64, height: 96 } } } }],
    animations: Object.fromEntries(
      asset.animations.map((a) => [
        a.name,
        { bones: { body: { rotate: [{ time: 0 }, { time: a.durationSec / 2, value: 8 }, { time: a.durationSec }] } } },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** GET /me/library/ids — cheap lookup so cards can show saved state. Empty for guests. */
export async function getSavedAssetIds(session: Session | null): Promise<string[]> {
  return session ? backend<string[]>("/me/library/ids", { session }) : [];
}

/** GET /me/library — most recently saved first. */
export async function getLibrary(session: Session): Promise<SpineAsset[]> {
  return backend<SpineAsset[]>("/me/library", { session });
}

/** GET /me/remixes — newest first. */
export async function getMyRemixes(session: Session): Promise<SpineAsset[]> {
  return backend<SpineAsset[]>("/me/remixes", { session });
}

/** PUT /me/library/:assetId — idempotent. */
export async function saveToLibrary(session: Session, assetId: string): Promise<void> {
  await backend(`/me/library/${id(assetId)}`, { session, method: "PUT" });
}

/** DELETE /me/library/:assetId — idempotent. */
export async function removeFromLibrary(session: Session, assetId: string): Promise<void> {
  await backend(`/me/library/${id(assetId)}`, { session, method: "DELETE" });
}

/** PATCH /me/remixes/:assetId — publish or unpublish one of the user's remixes. Null if it isn't theirs. */
export async function setRemixVisibility(
  session: Session,
  assetId: string,
  visibility: SpineAsset["visibility"],
): Promise<SpineAsset | null> {
  return backendOrNull<SpineAsset>(`/me/remixes/${id(assetId)}`, { session, method: "PATCH", body: { visibility } });
}

/**
 * DELETE /me/remixes/:assetId — deletes one of the user's remixes (admins: any asset).
 * Fails when it isn't theirs, or when other remixes are built on it.
 */
export async function deleteAsset(session: Session, assetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await backend(`/me/remixes/${id(assetId)}`, { session, method: "DELETE" });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status >= 500) throw error;
    return { ok: false, error: errorMessage(error.body, "Couldn't delete the asset.") };
  }
}

// ---------------------------------------------------------------------------
// Remixing (re-texture an existing rig)
// ---------------------------------------------------------------------------

export type CreateRemixResult =
  | { ok: true; job: RemixJob }
  /** `limitReached` when the monthly allowance is used up (402). */
  | { ok: false; error: string; field: "base" | "referenceImage" | null; limitReached: boolean };

/**
 * POST /me/remix-jobs — returns right away with a queued job; the UI polls getRemixJob.
 * `referenceImage` is a JPEG, PNG or WebP data URL; the backend stores it and sets `input.referenceImage`.
 */
export async function createRemixJob(
  session: Session,
  input: Omit<RemixInput, "referenceImage">,
  apiVersion: RemixApiVersion = "v2",
  referenceImage: string | null = null,
): Promise<CreateRemixResult> {
  try {
    const job = await backend<RemixJob>("/me/remix-jobs", { session, method: "POST", body: { ...input, apiVersion, referenceImage } });
    return { ok: true, job };
  } catch (error) {
    if (!(error instanceof BackendError) || (error.status !== 400 && error.status !== 402)) throw error;
    const fieldErrors = (error.body as { errors?: { base?: unknown; referenceImage?: unknown } } | null)?.errors;
    return {
      ok: false,
      error: errorMessage(error.body, "Couldn't start the remix."),
      field: typeof fieldErrors?.base === "string" ? "base" : typeof fieldErrors?.referenceImage === "string" ? "referenceImage" : null,
      limitReached: error.status === 402,
    };
  }
}

/**
 * POST /me/remixes/:assetId/copy — the user's own private copy of someone else's remix, to tweak
 * and fix parts on. Free. Returns their existing copy (or the remix itself, if it's theirs) when
 * there is one.
 */
export async function copyRemix(
  session: Session,
  assetId: string,
): Promise<{ ok: true; asset: SpineAsset } | { ok: false; error: string }> {
  try {
    const asset = await backend<SpineAsset>(`/me/remixes/${id(assetId)}/copy`, { session, method: "POST" });
    return { ok: true, asset };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status === 401 || error.status >= 500) throw error;
    return { ok: false, error: errorMessage(error.body, "Couldn't copy the remix.") };
  }
}

/** GET /me/remix-jobs/:id — null if it isn't the user's. */
export async function getRemixJob(session: Session, jobId: string): Promise<RemixJob | null> {
  return backendOrNull<RemixJob>(`/me/remix-jobs/${id(jobId)}`, { session });
}

/**
 * POST /me/remixes/:assetId/part-fixes — repaints the chosen regions of one of the user's remixes
 * in place. Returns right away with a running job; the UI polls getPartFix. Counts as a remix.
 */
export async function createPartFix(
  session: Session,
  assetId: string,
  input: PartFixInput,
): Promise<{ ok: true; job: PartFixJob } | { ok: false; error: string }> {
  try {
    const job = await backend<PartFixJob>(`/me/remixes/${id(assetId)}/part-fixes`, { session, method: "POST", body: input });
    return { ok: true, job };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status === 401 || error.status >= 500) throw error;
    return { ok: false, error: errorMessage(error.body, "Couldn't start the fix.") };
  }
}

/** GET /me/part-fixes/:id — null if it isn't the user's. */
export async function getPartFix(session: Session, jobId: string): Promise<PartFixJob | null> {
  return backendOrNull<PartFixJob>(`/me/part-fixes/${id(jobId)}`, { session });
}

/**
 * POST /me/remixes/:assetId/skeleton  body = { skeleton, skin }
 * Replaces a remix's skeleton with one the user edited on the remix page. Only the user who made
 * the remix can do this. Returns the updated asset, or null if it isn't theirs.
 */
export async function saveRemixSkeleton(
  session: Session,
  assetId: string,
  skeleton: object,
  skin: string | null,
): Promise<SpineAsset | null> {
  return backendOrNull<SpineAsset>(`/me/remixes/${id(assetId)}/skeleton`, {
    session,
    method: "POST",
    body: { skeleton, skin },
  });
}

/**
 * POST /me/remixes/:assetId/auto-tweak — Muse reviews the measured part fixes. Nothing is stored.
 * Resolves to `{ ok: false, error }` for the user's own mistakes and model failures.
 */
export async function autoTweakRemix(
  session: Session,
  assetId: string,
  input: AutoTweakInput,
): Promise<{ ok: true; review: AutoTweakReview } | { ok: false; error: string }> {
  try {
    const review = await backend<AutoTweakReview>(`/me/remixes/${id(assetId)}/auto-tweak`, { session, method: "POST", body: input });
    return { ok: true, review };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status === 401 || (error.status >= 500 && error.status !== 502)) throw error;
    return { ok: false, error: errorMessage(error.body, "Couldn't auto-tweak the remix.") };
  }
}

/**
 * POST /me/remixes/:assetId/animations — Muse writes a new animation and it's saved into the remix.
 * Resolves to `{ ok: false, error }` for the user's own mistakes and model failures.
 */
export async function animateRemix(
  session: Session,
  assetId: string,
  input: AnimateInput,
): Promise<{ ok: true; result: AnimateResult } | { ok: false; error: string }> {
  try {
    const result = await backend<AnimateResult>(`/me/remixes/${id(assetId)}/animations`, { session, method: "POST", body: input });
    return { ok: true, result };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status === 401 || (error.status >= 500 && error.status !== 502)) throw error;
    return { ok: false, error: errorMessage(error.body, "Couldn't make the animation.") };
  }
}

// ---------------------------------------------------------------------------
// Account & billing
// ---------------------------------------------------------------------------

export interface Account {
  user: { id: string; name: string; avatarUrl: string | null };
  plan: "free" | "pro";
  /** Admins have no remix limit and can see and moderate any asset. */
  isAdmin: boolean;
  subscription: { status: string; currentPeriodEnd: string | null } | null;
  /** Remixes started this calendar month (UTC) that didn't fail, and the plan's allowance (null = unlimited). */
  usage: { used: number; limit: number | null; resetsAt: string };
  billingEnabled: boolean;
}

/** GET /me */
export async function getAccount(session: Session): Promise<Account> {
  return backend<Account>("/me", { session });
}

/** POST /billing/checkout → Stripe Checkout URL (or the portal, for existing subscribers). */
export async function createCheckoutUrl(session: Session): Promise<string> {
  const { url } = await backend<{ url: string }>("/billing/checkout", { session, method: "POST" });
  return url;
}

/** POST /billing/portal → Stripe customer portal URL, or null if the user never subscribed. */
export async function createPortalUrl(session: Session): Promise<string | null> {
  const res = await backendOrNull<{ url: string }>("/billing/portal", { session, method: "POST" });
  return res?.url ?? null;
}
