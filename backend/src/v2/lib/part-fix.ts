import path from "node:path";
import sharp from "sharp";
import { type AtlasPage, type PageRect, isSafePageName, parseAtlas } from "./atlas.js";
import { layoutParts } from "../../lib/layout.js";
import { ContentPolicyError, repaintPage, summarizeLook } from "./meta.js";
import { type RemixProgress, fetchBaseFile, withProgress } from "./remix.js";
import { putFile } from "../../lib/storage.js";
import { type PageImage, decodePage, fitToPage, layoutFit, pickBackground, toModelInput } from "./textures.js";
import type { PartFixInput } from "../../lib/types.js";

/** Same limits as a full remix (see remix.ts). */
const IMAGE_MAX_SIDE = 1536;
const PAGE_EXPECTED_MS = 10_000;
const MIN_LAYOUT_FIT = 0.85;
const LAYOUT_RETRY_NOTE =
  "A previous attempt moved, enlarged and duplicated parts. Repaint each part exactly where it is in the input image, at the same size, and nowhere else.";

export interface PartFixRequest extends PartFixInput {
  /** The remix being fixed. Its pages sit next to its atlas. */
  remix: {
    atlasUrl: string;
    premultipliedAlpha: boolean;
    /** The user's remix prompt, and Muse's edit prompt from the remix job when it's still recorded. */
    prompt: string | null;
    editPrompt: string | null;
    style: string;
  };
  /** The rig it was remixed from, to start from the original parts; null when it's gone. */
  original: { atlasUrl: string; premultipliedAlpha: boolean } | null;
}

export interface PartFixResult {
  /** Storage keys of the new .atlas and every page, in atlas order. */
  atlas: string;
  textures: string[];
}

/**
 * Repaints only the chosen regions of a finished remix. The chosen parts are packed into a
 * square of their own (from the original rig, or the remix itself), Muse Image repaints them
 * to the remix's look, described in text, and the result is keyed and copied back into just
 * those regions. Every other pixel of the remix is kept.
 *
 * Muse Image gets only the one image: given the rest of the remix as a second, reference
 * image, it repainted that busier image instead (see FRICTION_LOG.md, 2026-10-28).
 *
 * The atlas and all pages are written to a new folder, since the Spine runtime loads pages
 * next to the atlas. Throws an Error with a user-facing message on failure.
 */
export async function runPartFix(
  jobId: string,
  input: PartFixRequest,
  onProgress: RemixProgress,
  signal: AbortSignal,
): Promise<PartFixResult> {
  onProgress(0.05, "Reading the remix");
  const atlasText = (await fetchBaseFile(input.remix.atlasUrl, signal)).toString("utf8");
  const pages = parseAtlas(atlasText);
  if (pages.length === 0 || !pages.every((p) => isSafePageName(p.name))) throw new Error("This remix's atlas can't be edited.");

  const wanted = new Set(input.regions);
  const selected = pages.map((p) => p.regions.flatMap((name, j) => (wanted.has(name) ? [j] : [])));
  if (selected.every((s) => s.length === 0)) throw new Error("None of the chosen parts are in this remix's atlas.");

  const remixDir = dirOf(input.remix.atlasUrl);
  const remixFiles = await Promise.all(pages.map((p) => fetchBaseFile(remixDir + p.name, signal)));
  const remixImages = await Promise.all(remixFiles.map((f) => decodePage(f, input.remix.premultipliedAlpha)));
  const sources = await sourcePages(input, atlasText, pages, selected, remixImages, signal);
  const source = sources ? "original" : "remix";

  const look = input.remix.editPrompt
    ? await withProgress(onProgress, 0.07, 0.1, "Reading the remix's look", 6_000, async () =>
        (await summarizeLook(input.remix.editPrompt ?? "", signal)) ?? input.remix.prompt,
      )
    : input.remix.prompt;

  const touched = selected.flatMap((s, i) => (s.length > 0 ? [i] : []));
  const background = pickBackground(
    touched.flatMap((i) => [remixImages[i], sources?.[i] ?? remixImages[i]]),
    [input.prompt, look ?? ""].join(" "),
  );

  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_${jobId}`;
  const layoutChecks: { page: string; attempt: number; insideBoxes: number }[] = [];
  const prompts: Record<string, string> = {};
  const writeLog = () =>
    putFile(
      folder,
      "prompts.json",
      JSON.stringify(
        { jobId, createdAt: new Date().toISOString(), kind: "parts", request: { ...input, sourceUsed: source }, look, prompts, layoutChecks },
        null,
        2,
      ),
    );

  const out = [...remixFiles];
  for (const [step, i] of touched.entries()) {
    const page = pages[i];
    const rects = selected[i].map((j) => page.rects[j]);
    const sourceImage = sources?.[i] ?? remixImages[i];
    const modelInput = await toModelInput(sourceImage, IMAGE_MAX_SIDE, background, layoutParts(rects, sourceImage));
    const prompt = buildPrompt(input, look, rects.length, background.name, source);
    prompts[page.name] = prompt;
    await writeLog();

    const generated = await withProgress(
      onProgress,
      0.1 + (0.8 * step) / touched.length,
      0.1 + (0.8 * (step + 1)) / touched.length,
      touched.length > 1 ? `Repainting parts on page ${step + 1} of ${touched.length}` : "Repainting the parts",
      PAGE_EXPECTED_MS,
      async () => {
        const paint = async (note: string) => {
          try {
            return await repaintPage(modelInput, [prompt, note].filter(Boolean).join(" "), null, signal);
          } catch (error) {
            // The user wrote this prompt themselves, so they re-word it rather than Muse.
            if (error instanceof ContentPolicyError) throw new Error("The image model declined this prompt. Try describing the fix differently.");
            throw error;
          }
        };
        const check = async (image: Buffer, attempt: number) => {
          const fit = await layoutFit(image, modelInput);
          layoutChecks.push({ page: page.name, attempt, insideBoxes: Math.round(fit * 100) / 100 });
          await writeLog();
          return fit >= MIN_LAYOUT_FIT;
        };
        const first = await paint("");
        if (await check(first, 1)) return first;
        await putFile(folder, `${path.parse(page.name).name}.rejected.png`, first);
        const second = await paint(LAYOUT_RETRY_NOTE);
        if (await check(second, 2)) return second;
        await putFile(folder, `${path.parse(page.name).name}.generated.png`, second);
        throw new Error("The image model moved the parts out of place twice. Try again, or pick fewer parts.");
      },
    );
    signal.throwIfAborted();
    await putFile(folder, `${path.parse(page.name).name}.generated.png`, generated);

    // Parts take the model's new silhouettes, keyed out within their own regions.
    const fixed = await fitToPage(generated, modelInput, sourceImage, input.remix.premultipliedAlpha, rects);
    out[i] = await replaceRegions(remixFiles[i], fixed, rects);
  }

  onProgress(0.95, "Saving the remix");
  const textures = await Promise.all(pages.map((p, i) => putFile(folder, p.name, out[i])));
  const atlas = await putFile(folder, "remix.atlas", atlasText);
  return { atlas, textures };
}

function dirOf(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

/**
 * The original rig's pages to start from, decoded, or null to start from the remix. Only used
 * when the original has the same atlas (a remix keeps its base's atlas), so the regions match.
 */
async function sourcePages(
  input: PartFixRequest,
  atlasText: string,
  pages: AtlasPage[],
  selected: number[][],
  remixImages: PageImage[],
  signal: AbortSignal,
): Promise<(PageImage | null)[] | null> {
  if (input.source !== "original" || !input.original) return null;
  try {
    const originalAtlas = (await fetchBaseFile(input.original.atlasUrl, signal)).toString("utf8");
    if (originalAtlas.trim() !== atlasText.trim()) return null;
    const dir = dirOf(input.original.atlasUrl);
    const original = input.original;
    const images = await Promise.all(
      pages.map(async (p, i) => (selected[i].length > 0 ? decodePage(await fetchBaseFile(dir + p.name, signal), original.premultipliedAlpha) : null)),
    );
    const sameSize = images.every((img, i) => !img || (img.width === remixImages[i].width && img.height === remixImages[i].height));
    return sameSize ? images : null;
  } catch (error) {
    signal.throwIfAborted();
    console.error("Couldn't load the original rig for a part fix; using the remix's own parts", error);
    return null;
  }
}

function buildPrompt(input: PartFixRequest, look: string | null, count: number, background: string, source: "original" | "remix"): string {
  return [
    `This image shows ${count === 1 ? "one part" : `${count} separate parts`} cut from a 2D game character's sprite atlas, on a solid ${background} background.`,
    source === "original" ? "They are the character's original parts, before restyling." : "They are the character's current parts, which need fixing.",
    look ? `The rest of the character has already been restyled, and these parts must match it: ${look}` : "",
    `Repaint ${count === 1 ? "this part" : "these parts"}: ${input.prompt}.`,
    `Art style: ${input.remix.style}.`,
    `Repaint every part in place, at the same size. Do not add or merge parts. Keep the background solid ${background}, and leave the empty ${background} areas empty.`,
    "Each part is a separate cut-out piece. Don't complete it into a whole object: no heads inside helmets, no legs inside boots or greaves, no hands or feet on limb segments.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The stored remix page with `rects` replaced by the same areas of `fixed`. Both are encoded
 * pages of the same size and alpha mode, so pixels are copied as they are.
 */
async function replaceRegions(page: Buffer, fixed: Buffer, rects: PageRect[]): Promise<Buffer> {
  const { data: base, info } = await sharp(page).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: patch } = await sharp(fixed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  for (const r of rects) {
    const x0 = Math.max(r.x, 0), x1 = Math.min(r.x + r.width, width);
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.height, height); y++) {
      patch.copy(base, (y * width + x0) * 4, (y * width + x0) * 4, (y * width + x1) * 4);
    }
  }
  return sharp(base, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
