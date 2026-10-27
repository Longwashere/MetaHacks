import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafePageName, parseAtlas } from "./atlas.js";
import { ASSET_BASE_URL, PUBLIC_URL, REMIX_OUTPUT_DIR } from "./config.js";
import { ContentPolicyError, keptPartProperties, planRemix, repaintPage, rewordForContentPolicy } from "./meta.js";
import { decodePage, fitToPage, pickBackground, toDataUrl, toModelInput } from "./textures.js";
import type { PromptStatus, RemixRequest, RemixResult } from "./types.js";

export interface RemixProgress {
  (progress: number, stage: string): void;
}

/** Called with the edit prompt Muse Image is given, and whether it's being re-worded for the content policy. */
export interface RemixPromptUpdate {
  (editPrompt: string, status: PromptStatus): void;
}

/** Longest side of the images sent to Muse Image (its quality tops out around 1600px). */
const IMAGE_MAX_SIDE = 1536;
/** Muse only needs to see what the rig looks like, so it gets smaller pages, and at most a few. */
const PLAN_MAX_SIDE = 768;
const PLAN_MAX_PAGES = 4;
/** Rough durations of the model calls, used to keep the progress bar moving while they run. */
const PLAN_EXPECTED_MS = 6_000;
const PAGE_EXPECTED_MS = 10_000;

/**
 * Re-textures the base rig: fetches its atlas pages, has Muse plan the new look,
 * repaints each page with Muse Image and fits it back onto the original regions.
 * Writes the new .atlas and pages under REMIX_OUTPUT_DIR/<timestamp>_<jobId>/, plus a
 * prompts.json recording what was asked for and sent to the models.
 *
 * Throw an Error with a user-facing message on failure; the job runner stores it as
 * `job.error`. `signal` fires when the whole job runs out of time — pass it through.
 *
 * If Muse Image rejects the prompt under its content policy, Muse re-words the edit
 * prompt once and the page is retried; the new prompt is used for the remaining pages.
 */
export async function runRemix(
  jobId: string,
  input: RemixRequest,
  onProgress: RemixProgress,
  onPrompt: RemixPromptUpdate,
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

  // One background for every page, so the reference page matches the one being painted.
  const background = pickBackground(images, input.prompt);
  const pageImages = await Promise.all(
    images.slice(0, PLAN_MAX_PAGES).map(async (img) => (await toModelInput(img, PLAN_MAX_SIDE, background)).dataUrl),
  );
  const plan = await withProgress(onProgress, 0.1, 0.2, "Planning the new look", PLAN_EXPECTED_MS, () =>
    planRemix(
      input,
      { name: base.name, regions: pages.flatMap((p) => p.regions), pageImages, background: background.name },
      signal,
    ),
  );

  onPrompt(plan.editPrompt, "original");

  const kept = keptPartProperties(input);
  const buildImagePrompt = (editPrompt: string) => [
    editPrompt,
    // With "auto", the plan already carries the style (the original one, or the prompt's).
    input.style === "auto" ? "" : `Art style: ${input.style}.`,
    `This image is a sprite atlas of separate character parts on a solid ${background.name} background.`,
    `Every shape that is not the ${background.name} background is a part; repaint all of them, including thin ones like bones, shafts and straps.`,
    kept ? `Keep every part in exactly the same ${kept}.` : "",
    `Do not add or merge parts. Keep the background solid ${background.name}.`,
  ]
    .filter(Boolean)
    .join(" ");
  let editPrompt = plan.editPrompt;
  let reworded: string | null = null;

  // Timestamp first so folders sort by creation time when browsing REMIX_OUTPUT_DIR.
  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_${jobId}`;
  const outDir = path.join(REMIX_OUTPUT_DIR, folder);
  await mkdir(outDir, { recursive: true });
  const { base: _base, ...request } = input;
  const writePrompts = () =>
    writeFile(
      path.join(outDir, "prompts.json"),
      JSON.stringify(
        {
          jobId,
          createdAt: new Date().toISOString(),
          base: base.name,
          request,
          plan,
          imagePrompt: buildImagePrompt(editPrompt),
          ...(reworded ? { rewordedForContentPolicy: true } : {}),
        },
        null,
        2,
      ),
    );
  await writePrompts();

  let reference: string | null = null;
  for (const [i, page] of pages.entries()) {
    const modelInput = await toModelInput(images[i], IMAGE_MAX_SIDE, background);
    const generated = await withProgress(
      onProgress,
      0.2 + (0.75 * i) / pages.length,
      0.2 + (0.75 * (i + 1)) / pages.length,
      pages.length > 1 ? `Painting page ${i + 1} of ${pages.length}` : "Painting new textures",
      PAGE_EXPECTED_MS,
      async () => {
        const paint = () => {
          const prompt = buildImagePrompt(editPrompt);
          return repaintPage(
            modelInput,
            reference ? `${prompt} The second image is an already repainted page of the same asset; match its colors and materials.` : prompt,
            reference,
            signal,
          );
        };
        try {
          return await paint();
        } catch (error) {
          // Re-word once per job; a second rejection reaches the user.
          if (!(error instanceof ContentPolicyError) || reworded) throw error;
          onPrompt(editPrompt, "rewording");
          reworded = await rewordForContentPolicy(editPrompt, signal);
          if (!reworded) {
            onPrompt(editPrompt, "original");
            throw error;
          }
          editPrompt = reworded;
          onPrompt(editPrompt, "reworded");
          await writePrompts();
          return await paint();
        }
      },
    );
    signal.throwIfAborted();
    // The raw model output, kept for debugging how well it lined up with the page.
    await writeFile(path.join(outDir, `${path.parse(page.name).name}.generated.png`), generated);
    // Kept outlines reuse the original alpha; otherwise the model's own shapes are keyed out.
    const keyedRects = input.keepOutline ? null : page.rects;
    await writeFile(
      path.join(outDir, page.name),
      await fitToPage(generated, modelInput, images[i], base.premultipliedAlpha, keyedRects),
    );
    reference ??= await toDataUrl(generated, PLAN_MAX_SIDE);
  }

  onProgress(0.95, "Packing atlas");
  // Regions are unchanged and page names are kept, so the base atlas works as-is.
  await writeFile(path.join(outDir, "remix.atlas"), atlasText);

  const fileUrl = (name: string) => `${PUBLIC_URL}/files/remixes/${folder}/${encodeURIComponent(name)}`;
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

/**
 * Runs a slow model call, easing progress from `from` toward `to` while it waits so
 * the bar doesn't sit still. Reaches about two thirds of the way after `expectedMs`
 * and never quite gets to `to` until the call returns.
 */
async function withProgress<T>(
  onProgress: RemixProgress,
  from: number,
  to: number,
  stage: string,
  expectedMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  onProgress(from, stage);
  const timer = setInterval(() => {
    const eased = 1 - Math.exp(-(Date.now() - start) / expectedMs);
    onProgress(from + (to - from) * 0.95 * eased, stage);
  }, 1000);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}
