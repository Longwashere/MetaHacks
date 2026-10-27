import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafePageName, parseAtlas } from "./atlas.js";
import { ASSET_BASE_URL, PUBLIC_URL, REMIX_OUTPUT_DIR } from "./config.js";
import { planRemix, repaintPage } from "./meta.js";
import { decodePage, fitToPage, toDataUrl, toModelInput } from "./textures.js";
import type { RemixRequest, RemixResult } from "./types.js";

export interface RemixProgress {
  (progress: number, stage: string): void;
}

/** Longest side of the images sent to Muse Image (its quality tops out around 1600px). */
const IMAGE_MAX_SIDE = 1536;
/** Muse only needs to see what the rig looks like, so it gets smaller pages, and at most a few. */
const PLAN_MAX_SIDE = 768;
const PLAN_MAX_PAGES = 4;

/**
 * Re-textures the base rig: fetches its atlas pages, has Muse plan the new look,
 * repaints each page with Muse Image and fits it back onto the original regions.
 * Writes the new .atlas and pages under REMIX_OUTPUT_DIR/<jobId>/.
 *
 * Throw an Error with a user-facing message on failure; the job runner stores it as
 * `job.error`. `signal` fires when the whole job runs out of time — pass it through.
 */
export async function runRemix(
  jobId: string,
  input: RemixRequest,
  onProgress: RemixProgress,
  signal: AbortSignal,
): Promise<RemixResult> {
  const { base } = input;

  onProgress(0.05, "Reading rig & atlas regions");
  const atlasText = (await fetchBaseFile(base.atlasUrl, signal)).toString("utf8");
  const pages = parseAtlas(atlasText);
  if (pages.length === 0) throw new Error("The base rig's atlas has no pages.");
  if (!pages.every((p) => isSafePageName(p.name))) throw new Error("The base rig's atlas can't be remixed.");

  const atlasDir = base.atlasUrl.slice(0, base.atlasUrl.lastIndexOf("/") + 1);
  const images = await Promise.all(
    pages.map(async (p) => decodePage(await fetchBaseFile(atlasDir + p.name, signal), base.premultipliedAlpha)),
  );

  onProgress(0.1, "Planning the new look");
  const plan = await planRemix(
    input,
    {
      name: base.name,
      regions: pages.flatMap((p) => p.regions),
      pageImages: await Promise.all(
        images.slice(0, PLAN_MAX_PAGES).map(async (img) => (await toModelInput(img, PLAN_MAX_SIDE)).dataUrl),
      ),
    },
    signal,
  );

  const prompt = [
    plan.editPrompt,
    `Art style: ${input.style}.`,
    "This image is a sprite atlas of separate character parts on a plain grey background.",
    "Keep every part in exactly the same position, size and outline. Do not add, move, merge or resize parts. Keep the background plain grey.",
  ].join(" ");

  const outDir = path.join(REMIX_OUTPUT_DIR, jobId);
  await mkdir(outDir, { recursive: true });

  let reference: string | null = null;
  for (const [i, page] of pages.entries()) {
    onProgress(0.2 + (0.7 * i) / pages.length, pages.length > 1 ? `Painting page ${i + 1} of ${pages.length}` : "Painting new textures");
    const modelInput = await toModelInput(images[i], IMAGE_MAX_SIDE);
    const generated = await repaintPage(
      modelInput,
      reference ? `${prompt} The second image is an already repainted page of the same asset; match its colors and materials.` : prompt,
      reference,
      signal,
    );
    signal.throwIfAborted();
    await writeFile(path.join(outDir, page.name), await fitToPage(generated, modelInput, images[i], base.premultipliedAlpha));
    reference ??= await toDataUrl(generated, PLAN_MAX_SIDE);
  }

  onProgress(0.95, "Packing atlas");
  // Regions are unchanged and page names are kept, so the base atlas works as-is.
  await writeFile(path.join(outDir, "remix.atlas"), atlasText);

  const fileUrl = (name: string) => `${PUBLIC_URL}/files/remixes/${jobId}/${encodeURIComponent(name)}`;
  return {
    name: plan.name,
    atlasUrl: fileUrl("remix.atlas"),
    textureUrls: pages.map((p) => fileUrl(p.name)),
  };
}

/** Fetches a base rig file. Paths come from the request, so they stay on ASSET_BASE_URL. */
async function fetchBaseFile(filePath: string, signal: AbortSignal): Promise<Buffer> {
  const url = new URL(filePath, `${ASSET_BASE_URL}/`);
  if (url.origin !== new URL(ASSET_BASE_URL).origin) throw new Error("The base rig's files aren't available.");
  const res = await fetch(url, { signal });
  if (!res.ok) {
    console.error(`Fetching ${url} failed (${res.status})`);
    throw new Error("The base rig's files aren't available.");
  }
  return Buffer.from(await res.arrayBuffer());
}
