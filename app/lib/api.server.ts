// Data layer for the app. Every route loader/action goes through these functions,
// so connecting the real backend means replacing the bodies below — the UI
// doesn't need to change. See BACKEND.md for the endpoint contract.
//
// Right now everything is an in-memory mock that resets when the server restarts.

import { MOCK_ASSETS } from "~/lib/mock-data.server";
import type {
  AssetAccent,
  AssetQuery,
  RemixInput,
  RemixJob,
  SpineAsset,
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

const MOCK_LATENCY_MS = 150;
const MOCK_REMIX_MS = 6000;
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

/**
 * BACKEND: POST /remixes  body = RemixInput
 * Should return immediately with a queued job; the UI polls getRemixJob.
 * Returns null if the base asset doesn't exist (or the user can't access it).
 */
export async function createRemixJob(userId: string, input: RemixInput): Promise<RemixJob | null> {
  await delay();
  const base = store.assets.get(input.baseAssetId);
  if (!base) return null;
  const id = `job_${crypto.randomUUID().slice(0, 8)}`;
  const job: RemixJob & { userId: string } = {
    id,
    userId,
    status: "queued",
    progress: 0,
    stage: "Queued",
    input,
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
    asset: null,
    error: null,
  };
  store.jobs.set(id, job);
  return publicJob(job);
}

/** BACKEND: GET /remixes/:id (or push updates over SSE/WebSocket). */
export async function getRemixJob(userId: string, jobId: string): Promise<RemixJob | null> {
  const job = store.jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  advanceMockJob(job);
  return publicJob(job);
}

function publicJob({ userId: _userId, ...job }: RemixJob & { userId: string }): RemixJob {
  return job;
}

const STAGES = [
  "Queued",
  "Reading rig & atlas regions",
  "Painting new textures",
  "Matching seams across slots",
  "Packing atlas",
  "Exporting Spine project",
];

const ACCENTS: AssetAccent[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];
const TINTS = ["#ff8a80", "#80d8ff", "#b9f6ca", "#ffd180", "#ea80fc"];

/** Fake progress based on elapsed time. Delete with the mock. */
function advanceMockJob(job: RemixJob) {
  if (job.status === "succeeded" || job.status === "failed") return;
  const elapsed = Date.now() - new Date(job.createdAt).getTime();
  const progress = Math.min(1, elapsed / MOCK_REMIX_MS);
  job.progress = progress;
  job.status = progress >= 1 ? "succeeded" : progress > 0.05 ? "running" : "queued";
  job.stage = STAGES[Math.min(STAGES.length - 1, Math.floor(progress * STAGES.length))];

  if (job.status === "succeeded" && !job.asset) {
    const base = store.assets.get(job.base.id);
    if (!base) {
      job.status = "failed";
      job.error = "The base rig is no longer available.";
      return;
    }
    job.stage = "Done";
    job.asset = buildMockRemix(job, base);
    store.assets.set(job.asset.id, job.asset);
  }
}

function buildMockRemix(job: RemixJob, base: SpineAsset): SpineAsset {
  const { input } = job;
  const words = input.prompt.split(/\s+/).filter((w) => w.length > 3).slice(0, 2);
  const flavor = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  const name = flavor ? `${flavor} ${base.name}` : `${base.name} Remix`;
  // Readable slug + short suffix for uniqueness, e.g. "crimson-ninja-wandering-monk-3f9a1c2b".
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = `${slug || "remix"}-${job.id.slice(4)}`;

  return {
    // Skeleton, bones, slots and animations come straight from the base rig.
    ...base,
    id,
    name,
    description: `Remix of ${base.name}: ${input.prompt}`,
    style: input.style,
    tags: [...new Set([...base.tags, "remix"])],
    prompt: input.prompt,
    remixOf: { id: base.id, name: base.name },
    // Remixes start private (noindex, not in sitemap). BACKEND: add a publish flow.
    visibility: "private",
    author: { id: "you", name: "You" },
    createdAt: new Date().toISOString(),
    accent: input.keepPalette ? base.accent : ACCENTS.filter((a) => a !== base.accent)[Math.floor(Math.random() * 4)],
    downloads: 0,
    saves: 0,
    thumbnailUrl: null,
    // The mock can't paint textures, so it reuses the base rig's files and tints them.
    files: base.files,
    tint: input.keepPalette ? null : TINTS[Math.floor(Math.random() * TINTS.length)],
  };
}
