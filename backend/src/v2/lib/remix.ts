import path from "node:path";
import { type AtlasPage, isSafePageName, parseAtlas } from "./atlas.js";
import { type PartLayout, layoutParts } from "../../lib/layout.js";
import {
  ContentPolicyError,
  STYLE_LOOKS,
  describeReference,
  describeStyle,
  keptPartProperties,
  planRemix,
  repaintPage,
  rewordForContentPolicy,
  styleInstruction,
} from "./meta.js";
import type { RemixReporter } from "../../lib/remix-live.js";
import { objectUrl, putFile } from "../../lib/storage.js";
import { decodePage, fitToPage, layoutFit, pickBackground, toDataUrl, toModelInput } from "./textures.js";
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
/** The user's reference image is sent to Muse Spark at this size. */
const REFERENCE_MAX_SIDE = 1024;
/** Rough durations of the model calls, used to keep the progress bar moving while they run. */
const PLAN_EXPECTED_MS = 6_000;
/** Muse Spark took 18–22 s to describe a 1024px reference next to a page (2026-10-28). */
const REFERENCE_EXPECTED_MS = 20_000;
const PAGE_EXPECTED_MS = 10_000;
/** A page whose painted pixels fall less inside the parts' boxes than this was rearranged by the model (see layoutFit). */
const MIN_LAYOUT_FIT = 0.85;
/**
 * For a style change, how much of the parts' painted texture is smoothed away before Muse Image
 * sees them (see softenTexture), by change amount: a median window as a share of the page's longer
 * side. At 0.007 a 1000px page loses its grit and fur strands but keeps faces, tusks and edges.
 */
const STYLE_SOFTEN = { light: 0.004, moderate: 0.007, heavy: 0.01 };
const LAYOUT_RETRY_NOTE =
  "A previous attempt moved, enlarged and duplicated parts. Repaint each part exactly where it is in the input image, at the same size, and nowhere else.";

/**
 * Re-textures the base rig: fetches its atlas pages, has Muse plan the new look,
 * repaints each page with Muse Image and fits it back onto the original regions.
 * Stores the new .atlas and pages under <timestamp>_<jobId>/ (see storage.ts), plus a
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
  report: RemixReporter,
  signal: AbortSignal,
): Promise<RemixResult> {
  const { base } = input;

  report.activity({ kind: "reading", round: 0 });
  onProgress(0.05, "Reading rig & atlas regions");
  const atlasText = (await fetchBaseFile(base.atlasUrl, signal)).toString("utf8");
  const pages = parseAtlas(atlasText);
  if (pages.length === 0) throw new Error("The base rig's atlas has no pages.");
  if (!pages.every((p) => isSafePageName(p.name))) throw new Error("The base rig's atlas can't be remixed.");

  const atlasDir = base.atlasUrl.slice(0, base.atlasUrl.lastIndexOf("/") + 1);
  const images = await Promise.all(
    pages.map(async (p) => decodePage(await fetchBaseFile(atlasDir + p.name, signal), base.premultipliedAlpha, p.size)),
  );

  // One background for every page, so the reference page matches the one being painted.
  const background = pickBackground(images, input.prompt);
  // Every model call sees the parts in the same square layout, so positions match across them.
  const layouts = pages.map((p, i) => layoutParts(p.rects, images[i]));
  const pageImages = await Promise.all(
    images
      .slice(0, PLAN_MAX_PAGES)
      .map(async (img, i) => (await toModelInput(img, PLAN_MAX_SIDE, background, layouts[i])).dataUrl),
  );
  const parts = describeParts(pages.slice(0, PLAN_MAX_PAGES), layouts);
  // The uploaded reference image is described first, on its own; Muse Image never sees it, since
  // it repaints a reference image instead of the atlas (see FRICTION_LOG.md, part fixes).
  const { referenceUrl } = input;
  if (referenceUrl) report.activity({ kind: "reference", round: 0 });
  const referenceLook = referenceUrl
    ? await withProgress(onProgress, 0.06, 0.1, "Studying the reference image", REFERENCE_EXPECTED_MS, async () =>
        describeReference(await toDataUrl(await fetchBaseFile(referenceUrl, signal), REFERENCE_MAX_SIDE), pageImages[0], input.prompt, signal),
      )
    : null;
  if (referenceUrl && !referenceLook) throw new Error("Muse couldn't read the reference image. Try again or use another image.");
  // An art style the user picked beats the reference image's.
  const referenceStyle = input.style === "auto" ? (referenceLook?.style ?? null) : null;
  report.activity({ kind: "planning", round: 0 });
  const { plan, describedStyle } = await withProgress(onProgress, 0.1, 0.2, "Planning the new look", PLAN_EXPECTED_MS, async () => {
    const plan = await planRemix(input, { name: base.name, parts, pageImages, background: background.name }, referenceLook, signal);
    // A named reference is described on its own, which Spark does far better than inside the plan.
    // The reference image's style, when there is one, already is that description.
    return { plan, describedStyle: plan.reference && !referenceStyle ? await describeStyle(plan.reference, signal) : null };
  });

  onPrompt(plan.editPrompt, "original");

  // The target style for a style change: the reference image's, else a named reference described
  // on its own, else the plan's own description, else the picked preset. Null when the remix keeps
  // the pages' style.
  const styleLook = referenceStyle ?? describedStyle ?? plan.style ?? (input.style === "auto" ? null : STYLE_LOOKS[input.style]);
  report.event({ type: "planned", name: plan.name, editPrompt: plan.editPrompt, style: styleLook, referenceLook: referenceLook?.look ?? null });
  const soften = !styleLook ? 0 : input.strength < 0.34 ? STYLE_SOFTEN.light : input.strength < 0.67 ? STYLE_SOFTEN.moderate : STYLE_SOFTEN.heavy;
  const kept = keptPartProperties(input);
  const buildImagePrompt = (editPrompt: string) => [
    styleLook ? styleInstruction(styleLook, background.name) : "",
    editPrompt,
    `This image is a sprite atlas of separate character parts on a solid ${background.name} background.`,
    `Every shape that is not the ${background.name} background is a part; repaint all of them, including thin ones like bones, shafts and straps.`,
    kept ? `Keep every part in exactly the same ${kept}.` : "",
    `Do not add or merge parts. Keep the background solid ${background.name}.`,
    `Leave the empty ${background.name} areas empty; don't paint anything new there.`,
    "Each part is a separate cut-out piece. Don't complete it into a whole object: no heads inside helmets, no legs inside boots or greaves, no hands or feet on limb segments.",
  ]
    .filter(Boolean)
    .join(" ");
  let editPrompt = plan.editPrompt;
  let reworded: string | null = null;
  /** Each painted page's layoutFit, rounded, so failed and retried pages can be told apart afterwards. */
  const layoutChecks: { page: string; attempt: number; insideBoxes: number }[] = [];

  // Timestamp first so folders sort by creation time when browsing the output.
  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_${jobId}`;
  const { base: _base, ...request } = input;
  const writePrompts = () =>
    putFile(
      folder,
      "prompts.json",
      JSON.stringify(
        {
          jobId,
          createdAt: new Date().toISOString(),
          base: base.name,
          request,
          parts,
          referenceLook,
          plan,
          styleLook,
          imagePrompt: buildImagePrompt(editPrompt),
          soften,
          ...(reworded ? { rewordedForContentPolicy: true } : {}),
          layoutChecks,
        },
        null,
        2,
      ),
    );
  await writePrompts();

  let reference: string | null = null;
  const pageKeys: string[] = [];
  // The live view's pages, swapped in as each one is painted. v2 paints once, so it's round 1.
  const shown: Record<string, string> = {};
  for (const [i, page] of pages.entries()) {
    report.activity({ kind: "painting", round: 1, page: page.name });
    // The text of the newest paint request, for the live view.
    let sent = "";
    const modelInput = await toModelInput(images[i], IMAGE_MAX_SIDE, background, layouts[i], soften);
    const generated = await withProgress(
      onProgress,
      0.2 + (0.75 * i) / pages.length,
      0.2 + (0.75 * (i + 1)) / pages.length,
      pages.length > 1 ? `Painting page ${i + 1} of ${pages.length}` : "Painting new textures",
      PAGE_EXPECTED_MS,
      async () => {
        const paint = (note: string) => {
          const prompt = [buildImagePrompt(editPrompt), note].filter(Boolean).join(" ");
          sent = reference ? `${prompt} The second image is an already repainted page of the same asset; match its colors and materials.` : prompt;
          return repaintPage(modelInput, sent, reference, signal);
        };
        const paintOnce = async (note: string) => {
          try {
            return await paint(note);
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
            report.event({ type: "reworded", round: 1, editPrompt });
            await writePrompts();
            return await paint(note);
          }
        };
        // Muse Image sometimes draws a new layout instead of repainting the parts in place;
        // fitting that back would scramble the sheet, so the page is painted once more.
        let insideBoxes = 0;
        const check = async (image: Buffer, attempt: number) => {
          const fit = await layoutFit(image, modelInput);
          insideBoxes = Math.round(fit * 100) / 100;
          layoutChecks.push({ page: page.name, attempt, insideBoxes });
          await writePrompts();
          return fit >= MIN_LAYOUT_FIT;
        };
        const first = await paintOnce("");
        if (await check(first, 1)) return first;
        const rejected = await putFile(folder, `${path.parse(page.name).name}.rejected.png`, first);
        report.event({ type: "rejected", round: 1, page: page.name, attempt: 1, insideBoxes, url: objectUrl(rejected), prompt: sent });
        const second = await paintOnce(LAYOUT_RETRY_NOTE);
        if (await check(second, 2)) return second;
        await putFile(folder, `${path.parse(page.name).name}.generated.png`, second);
        throw new Error("The image model moved the parts out of place twice. Try a smaller change or a lower strength.");
      },
    );
    signal.throwIfAborted();
    // The raw model output, kept for debugging how well it lined up with the page.
    await putFile(folder, `${path.parse(page.name).name}.generated.png`, generated);
    // Kept outlines reuse the original alpha; otherwise the model's own shapes are keyed out.
    const keyedRects = input.keepOutline ? null : page.rects;
    const pageKey = await putFile(
      folder,
      page.name,
      await fitToPage(generated, modelInput, images[i], base.premultipliedAlpha, keyedRects),
    );
    pageKeys.push(pageKey);
    shown[page.name] = objectUrl(pageKey);
    report.event({ type: "painted", round: 1, page: page.name, url: shown[page.name], shrunk: [], prompt: sent });
    report.preview({ round: 1, pages: { ...shown }, skeletonUrl: null });
    reference ??= await toDataUrl(generated, PLAN_MAX_SIDE);
  }

  report.activity({ kind: "packing", round: 0 });
  onProgress(0.95, "Packing atlas");
  // Regions are unchanged and page names are kept, so the base atlas works as-is.
  const atlasKey = await putFile(folder, "remix.atlas", atlasText);

  return {
    name: plan.name,
    atlas: atlasKey,
    textures: pageKeys,
  };
}

/** Fetches a base rig file. URLs are built by the backend from the asset's storage keys. */
export async function fetchBaseFile(url: string, signal: AbortSignal): Promise<Buffer> {
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
export async function withProgress<T>(
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

/**
 * One line per region for Muse, e.g. "head_2: page 1, x 0–11%, y 75–83%". Positions are
 * percentages of the square image Muse sees, where `layouts` drew the parts.
 */
function describeParts(pages: AtlasPage[], layouts: PartLayout[]): string[] {
  const pct = (v: number) => Math.round(100 * v);
  return pages.flatMap((page, i) =>
    page.regions.flatMap((name, j) => {
      const p = layouts[i].placements[layouts[i].regionPlacement[j]];
      if (!p) return [];
      return [`${name}: page ${i + 1}, x ${pct(p.x)}–${pct(p.x + p.width)}%, y ${pct(p.y)}–${pct(p.y + p.height)}%`];
    }),
  );
}
