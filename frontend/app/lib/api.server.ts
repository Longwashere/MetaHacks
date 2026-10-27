// Data layer for the app. Every route loader/action goes through these functions,
// so connecting the real backend means replacing the bodies below — the UI
// doesn't need to change. See BACKEND.md for the endpoint contract.
//
// Assets and libraries are an in-memory mock that resets when the server restarts.
// Remix jobs run on the backend (BACKEND_URL).

import { MOCK_ASSETS } from "~/lib/mock-data.server";
import type {
  AssetAccent,
  AssetQuery,
  RemixApiVersion,
  RemixInput,
  RemixJob,
  SpineAsset,
  SpineAssetFiles,
} from "~/lib/types";

// Survive Vite HMR in dev by parking the mock store on globalThis.
interface MockStore {
  assets: Map<string, SpineAsset>;
  /** userId -> saved asset ids (most recent first) */
  libraries: Map<string, string[]>;
  jobs: Map<string, RemixJob & { userId: string }>;
}
const globalStore = globalThis as typeof globalThis & { __spineMock?: MockStore };
const store: MockStore = (globalStore.__spineMock ??= {
  assets: new Map(MOCK_ASSETS.map((a) => [a.id, a])),
  libraries: new Map([["demo-user", ["knight-errant", "spinning-coin"]]]),
  jobs: new Map(),
});

// Ensure assets are always up-to-date even when globalStore persists across HMR
for (const a of MOCK_ASSETS) {
  const existing = store.assets.get(a.id);
  if (!existing) {
    store.assets.set(a.id, a);
  } else {
    store.assets.set(a.id, { ...a, saves: existing.saves, downloads: existing.downloads });
  }
}

const MOCK_LATENCY_MS = 150;
const delay = (ms = MOCK_LATENCY_MS) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** BACKEND: GET /assets?q=&category=&sort= */
export async function listAssets(query: AssetQuery = {}): Promise<SpineAsset[]> {
  await delay();
  const q = query.q?.trim().toLowerCase();
  let results = [...store.assets.values()].filter((a) => a.visibility === "public");

  if (query.category) results = results.filter((a) => a.category === query.category);
  if (q) {
    results = results.filter((a) =>
      [a.name, a.description, a.prompt ?? "", ...a.tags]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }

  switch (query.sort ?? "popular") {
    case "newest":
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
    case "name":
      results.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      results.sort((a, b) => b.saves - a.saves);
  }
  return results;
}

/** BACKEND: GET /assets/featured */
export async function listFeaturedAssets(limit = 4): Promise<SpineAsset[]> {
  const all = await listAssets({ sort: "popular" });
  return all.slice(0, limit);
}

/** BACKEND: GET /assets/:id/related — same category, for internal linking on asset pages. */
export async function listRelatedAssets(asset: SpineAsset, limit = 4): Promise<SpineAsset[]> {
  const sameCategory = await listAssets({ category: asset.category, sort: "popular" });
  return sameCategory.filter((a) => a.id !== asset.id).slice(0, limit);
}

/** BACKEND: GET /assets/:id/remixes — public remixes built on this rig. */
export async function listRemixesOf(assetId: string, limit = 8): Promise<SpineAsset[]> {
  const all = await listAssets({ sort: "popular" });
  return all.filter((a) => a.remixOf?.id === assetId).slice(0, limit);
}

/** BACKEND: GET /assets/:id */
export async function getAsset(id: string): Promise<SpineAsset | null> {
  await delay();
  return store.assets.get(id) ?? null;
}

/**
 * BACKEND: GET /assets/:id/skeleton — should stream the real .json/.skel file
 * (or return a signed storage URL to redirect to).
 * The mock builds a minimal Spine JSON from the asset's metadata.
 */
export async function getSkeletonExport(id: string): Promise<object | null> {
  const asset = await getAsset(id);
  if (!asset) return null;
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

/** BACKEND: GET /me/library/ids — cheap lookup so cards can show saved state. */
export async function getSavedAssetIds(userId: string): Promise<string[]> {
  return [...(store.libraries.get(userId) ?? [])];
}

/** BACKEND: GET /me/library */
export async function getLibrary(userId: string): Promise<SpineAsset[]> {
  await delay();
  const ids = store.libraries.get(userId) ?? [];
  return ids.flatMap((id) => store.assets.get(id) ?? []);
}

/** BACKEND: GET /me/remixes */
export async function getMyRemixes(userId: string): Promise<SpineAsset[]> {
  await delay();
  return [...store.jobs.values()]
    .filter((j) => j.userId === userId && j.asset)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((j) => j.asset ?? []);
}

/** BACKEND: PUT /me/library/:assetId */
export async function saveToLibrary(userId: string, assetId: string): Promise<void> {
  await delay();
  const asset = store.assets.get(assetId);
  if (!asset) throw new Response("Asset not found", { status: 404 });
  const ids = store.libraries.get(userId) ?? [];
  if (!ids.includes(assetId)) {
    store.libraries.set(userId, [assetId, ...ids]);
    asset.saves += 1;
  }
}

/** BACKEND: DELETE /me/library/:assetId */
export async function removeFromLibrary(userId: string, assetId: string): Promise<void> {
  await delay();
  const ids = store.libraries.get(userId) ?? [];
  if (ids.includes(assetId)) {
    store.libraries.set(userId, ids.filter((id) => id !== assetId));
    const asset = store.assets.get(assetId);
    if (asset) asset.saves = Math.max(0, asset.saves - 1);
  }
}

// ---------------------------------------------------------------------------
// Remixing (re-texture an existing rig)
// ---------------------------------------------------------------------------

// The backend runs the job (Muse plans the look, Muse Image repaints the atlas pages).
// Assets and users still live in the mock store above, so jobs are tracked here too.
const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

/** The parts of the backend's job we read. See backend/src/lib/types.ts. */
interface BackendRemixJob {
  id: string;
  status: RemixJob["status"];
  progress: number;
  stage: string;
  editPrompt: string | null;
  promptStatus: RemixJob["promptStatus"];
  result: { name: string; atlasUrl: string; textureUrls: string[] } | null;
  error: string | null;
}

/**
 * BACKEND: POST /{v1,v2}/remixes  body = RemixInput + the base rig's atlas
 * Returns immediately with a queued job; the UI polls getRemixJob.
 * Returns null if the base asset doesn't exist or has no files to repaint.
 */
export async function createRemixJob(
  userId: string,
  input: RemixInput,
  apiVersion: RemixApiVersion = "v2",
): Promise<RemixJob | null> {
  const base = store.assets.get(input.baseAssetId);
  if (!base?.files) return null;

  const res = await fetch(`${BACKEND_URL}/${apiVersion}/remixes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      base: { name: base.name, atlasUrl: base.files.atlasUrl, premultipliedAlpha: base.files.premultipliedAlpha },
    }),
  });
  if (!res.ok) throw new Error(`POST /${apiVersion}/remixes failed (${res.status}): ${await res.text()}`);
  const remote = (await res.json()) as BackendRemixJob;

  const job: RemixJob & { userId: string } = {
    id: remote.id,
    userId,
    status: "queued",
    progress: 0,
    stage: "Queued",
    input,
    apiVersion,
    base: {
      id: base.id,
      name: base.name,
      category: base.category,
      accent: base.accent,
      animations: base.animations,
      files: base.files,
      tint: base.tint,
    },
    createdAt: new Date().toISOString(),
    editPrompt: null,
    promptStatus: "original",
    asset: null,
    error: null,
  };
  store.jobs.set(job.id, job);
  applyBackendJob(job, remote);
  return publicJob(job);
}

/** BACKEND: GET /{v1,v2}/remixes/:id (or push updates over SSE/WebSocket). */
export async function getRemixJob(userId: string, jobId: string): Promise<RemixJob | null> {
  const job = store.jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  if (job.status === "queued" || job.status === "running") {
    const res = await fetch(`${BACKEND_URL}/${job.apiVersion}/remixes/${encodeURIComponent(jobId)}`);
    if (res.status === 404) {
      // The backend keeps jobs in memory, so a restart loses them.
      job.status = "failed";
      job.error = "The remix service restarted. Try again.";
    } else if (!res.ok) {
      throw new Error(`GET /${job.apiVersion}/remixes/${jobId} failed (${res.status})`);
    } else {
      applyBackendJob(job, (await res.json()) as BackendRemixJob);
    }
  }
  return publicJob(job);
}

function publicJob({ userId: _userId, ...job }: RemixJob & { userId: string }): RemixJob {
  return job;
}

function applyBackendJob(job: RemixJob, remote: BackendRemixJob) {
  job.status = remote.status;
  job.progress = remote.progress;
  job.stage = remote.stage;
  job.editPrompt = remote.editPrompt;
  job.promptStatus = remote.promptStatus;
  job.error = remote.error;
  if (remote.status !== "succeeded" || job.asset) return;

  const base = store.assets.get(job.base.id);
  if (!remote.result || !base?.files) {
    job.status = "failed";
    job.error = "The base rig is no longer available.";
    return;
  }
  job.asset = buildRemix(job, base, base.files, remote.result);
  store.assets.set(job.asset.id, job.asset);
}

const ACCENTS: AssetAccent[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

function buildRemix(
  job: RemixJob,
  base: SpineAsset,
  baseFiles: SpineAssetFiles,
  result: NonNullable<BackendRemixJob["result"]>,
): SpineAsset {
  const { input } = job;
  const name = result.name || `${base.name} Remix`;
  // Readable slug + short suffix for uniqueness, e.g. "crimson-ninja-wandering-monk-3f9a1c2b".
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = `${slug || "remix"}-${job.id.slice(4)}`;

  return {
    // Skeleton, bones, slots and animations come straight from the base rig.
    ...base,
    id,
    name,
    description: `Remix of ${base.name}: ${input.prompt}`,
    style: input.style === "auto" ? base.style : input.style,
    tags: [...new Set([...base.tags, "remix"])],
    prompt: input.prompt,
    remixOf: { id: base.id, name: base.name },
    // Remixes start private (noindex, not in sitemap). BACKEND: add a publish flow.
    visibility: "private",
    author: { id: "you", name: "You" },
    createdAt: new Date().toISOString(),
    accent: input.keepPalette ? base.accent : ACCENTS[(ACCENTS.indexOf(base.accent) + 1) % ACCENTS.length],
    downloads: 0,
    saves: 0,
    thumbnailUrl: null,
    // Same skeleton, new atlas pages painted by the backend.
    files: { ...baseFiles, atlasUrl: result.atlasUrl, textureUrls: result.textureUrls },
    tint: null,
  };
}
