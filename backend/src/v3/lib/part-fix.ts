import path from "node:path";
import sharp from "sharp";
import { type AtlasPage, type PageRect, isSafePageName, parseAtlas, uvToPage } from "./atlas.js";
import { type PartLayout, layoutParts } from "../../lib/layout.js";
import { ContentPolicyError, planPartFix, repaintPage } from "./meta.js";
import { type RemixProgress, fetchBaseFile, withProgress } from "./remix.js";
import { putFile } from "../../lib/storage.js";
import {
  type Background,
  type ModelInput,
  type PageImage,
  attachedFit,
  decodePage,
  fitToPage,
  hexToRgb,
  pickBackground,
  pickOffLimits,
  shrinkPartsToBoxes,
  toDataUrl,
  toModelInput,
} from "./textures.js";
import type { PartFixInput } from "../../lib/types.js";

/** Same limits as a full remix (see remix.ts). */
const IMAGE_MAX_SIDE = 1536;
/** Muse Spark only needs to see what the parts are. */
const PLAN_MAX_SIDE = 768;
const PLAN_EXPECTED_MS = 8_000;
const PAGE_EXPECTED_MS = 10_000;
/**
 * Least share of the painted pixels that must touch a chosen part (see attachedFit). A part may
 * grow past its box, since it's shrunk to fit; paint elsewhere means the model drew the part
 * again or rearranged the image.
 */
const MIN_ATTACHED_FIT = 0.85;
/** Smallest shrink a part may need to fit its box; below this the model drew it far too big. */
const MIN_PART_SCALE = 0.5;
/**
 * When at least CLEAN_ATTACHED_FIT of the paint touches the chosen parts, the model drew them where
 * they belong, only too big, so they may shrink as far as MIN_CLEAN_PART_SCALE. A 70×72 goblin
 * shield came back well placed both times but needed 0.36 and 0.38 (see FRICTION_LOG.md, 2026-10-29).
 */
const CLEAN_ATTACHED_FIT = 0.95;
const MIN_CLEAN_PART_SCALE = 0.25;
/** Margin kept clear inside each part's box and outline, as a share of the box's shorter side, so soft edges aren't cut. */
const FIT_INSET = 0.02;
/**
 * A mesh outline is only trusted when it holds at least this share of the original part's opaque
 * pixels; otherwise the atlas and skeleton may not match, and the part fits its box alone.
 */
const MIN_OUTLINE_COVER = 0.85;
const LAYOUT_RETRY_NOTE =
  "A previous attempt drew the parts too big or away from where they are. Draw each new part over the old one, centred on it and no bigger than it, and nowhere else.";

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
  /**
   * True when a chosen part is drawn with a mesh that can't be boxed (see lib/mesh.ts): the game
   * shows only what's inside its outline, so the model is asked to keep to it.
   */
  keepOutline: boolean;
  /**
   * Outlines the game clips parts to, by region, as mesh UV pairs: for parts drawn by a mesh that
   * can't be boxed (see lib/mesh.ts). The repainted part is shrunk to fit inside.
   */
  outlines: Record<string, number[]>;
  /** The rig it was remixed from, to start from the original parts; null when it's gone. */
  original: { atlasUrl: string; premultipliedAlpha: boolean } | null;
}

export interface PartFixResult {
  /** Storage folder the files went to, for the job to add the skeleton next to them. */
  folder: string;
  /** Storage keys of the new .atlas and every page, in atlas order. */
  atlas: string;
  textures: string[];
  /** The image prompt for each page it repainted, without retry notes. */
  imagePrompts: string[];
}

/**
 * Repaints only the chosen regions of a finished remix. The chosen parts are packed into a
 * square of their own (from the original rig, or the remix itself). Muse Spark looks at that
 * square and expands the user's request into the image prompt: the remix's art style in paint
 * terms and what each part becomes, named by where it sits. Muse Image repaints the square, and
 * the result is keyed and copied back into just those regions. Every other pixel is kept.
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
  /** Called with Muse's expanded prompt for the image model (pages joined by blank lines). */
  onPrompt: (editPrompt: string) => void,
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
  const remixImages = await Promise.all(remixFiles.map((f, i) => decodePage(f, input.remix.premultipliedAlpha, pages[i].size)));
  const sources = await sourcePages(input, atlasText, pages, selected, remixImages, signal);
  const source = sources ? "original" : "remix";

  // Spark's own plan for the remix describes its materials best; it's told to ignore the positions in it.
  const look = input.remix.editPrompt ?? input.remix.prompt;

  const touched = selected.flatMap((s, i) => (s.length > 0 ? [i] : []));
  const colourPages = touched.flatMap((i) => [remixImages[i], sources?.[i] ?? remixImages[i]]);
  const colourPrompt = [input.prompt, look ?? ""].join(" ");
  const background = pickBackground(colourPages, colourPrompt);
  const offLimits = pickOffLimits(colourPages, colourPrompt, background);

  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_${jobId}`;
  const layoutChecks: { page: string; attempt: number; attached: number; scales: number[]; clippedByOutline?: string[] }[] = [];
  const prompts: Record<string, string> = {};
  /** Muse's expanded prompt per page, or null where its reply was unusable and the request went as-is. */
  const plans: Record<string, string | null> = {};
  const expanded: string[] = [];
  const writeLog = () =>
    putFile(
      folder,
      "prompts.json",
      JSON.stringify(
        { jobId, createdAt: new Date().toISOString(), kind: "parts", request: { ...input, sourceUsed: source }, look, plans, prompts, layoutChecks },
        null,
        2,
      ),
    );

  const out = [...remixFiles];
  for (const [step, i] of touched.entries()) {
    const page = pages[i];
    const part = await preparePartPage(page, selected[i], sources?.[i] ?? remixImages[i], sources?.[i] ? remixImages[i] : null, background, offLimits, input.outlines);
    const { rects, modelInput } = part;
    const blocked = part.offLimits;
    const from = 0.1 + (0.8 * step) / touched.length;
    const to = 0.1 + (0.8 * (step + 1)) / touched.length;
    const onPage = touched.length > 1 ? ` on page ${step + 1} of ${touched.length}` : "";

    const plan = await withProgress(onProgress, from, from + (to - from) * 0.25, `Planning the fix${onPage}`, PLAN_EXPECTED_MS, async () =>
      planPartFix(
        {
          image: await toDataUrl(Buffer.from(modelInput.dataUrl.slice(modelInput.dataUrl.indexOf(",") + 1), "base64"), PLAN_MAX_SIDE),
          background: background.name,
          offLimits: blocked?.name ?? null,
          parts: describeParts(selected[i].map((j) => page.regions[j]), modelInput.layout),
          source,
          look,
          style: input.remix.style,
          request: input.prompt,
        },
        signal,
      ),
    );
    plans[page.name] = plan;
    if (plan) {
      expanded.push(plan);
      onPrompt(expanded.join("\n\n"));
    }
    const prompt = buildPrompt(input, plan, rects.length, background.name, blocked?.name ?? null, source);
    prompts[page.name] = prompt;
    await writeLog();

    const { generated, fitted } = await withProgress(
      onProgress,
      from + (to - from) * 0.25,
      to,
      `Repainting the parts${onPage}`,
      PAGE_EXPECTED_MS,
      async () => {
        const paint = async (note: string) => {
          try {
            return await repaintPage(modelInput, [prompt, note].filter(Boolean).join(" "), null, signal);
          } catch (error) {
            if (error instanceof ContentPolicyError) throw new Error("The image model declined this prompt. Try describing the fix differently.");
            throw error;
          }
        };
        // Returns the image with every part shrunk into its box, or null to paint again.
        const check = async (painted: Buffer, attempt: number) => {
          const { attached: fit, scales, outlineDropped, fitted: shrunk } = await fitRepaint(painted, part);
          const clipped = selected[i].filter((_, k) => outlineDropped[modelInput.layout.regionPlacement[k]]).map((j) => page.regions[j]);
          layoutChecks.push({ page: page.name, attempt, attached: Math.round(fit * 100) / 100, scales, ...(clipped.length > 0 && { clippedByOutline: clipped }) });
          await writeLog();
          const minScale = fit >= CLEAN_ATTACHED_FIT ? MIN_CLEAN_PART_SCALE : MIN_PART_SCALE;
          return fit >= MIN_ATTACHED_FIT && Math.min(...scales) >= minScale ? { generated: painted, fitted: shrunk } : null;
        };
        const first = await paint("");
        const firstFit = await check(first, 1);
        if (firstFit) return firstFit;
        await putFile(folder, `${path.parse(page.name).name}.rejected.png`, first);
        const second = await paint(LAYOUT_RETRY_NOTE);
        const secondFit = await check(second, 2);
        if (secondFit) return secondFit;
        await putFile(folder, `${path.parse(page.name).name}.generated.png`, second);
        throw new Error("The image model moved the parts out of place twice. Try again, or pick fewer parts.");
      },
    );
    signal.throwIfAborted();
    await putFile(folder, `${path.parse(page.name).name}.generated.png`, generated);

    out[i] = (await placeRepaint(fitted, part, remixFiles[i], input.remix.premultipliedAlpha)).page;
  }

  onProgress(0.95, "Saving the remix");
  const textures = await Promise.all(pages.map((p, i) => putFile(folder, p.name, out[i])));
  const atlas = await putFile(folder, "remix.atlas", atlasText);
  return { folder, atlas, textures, imagePrompts: Object.values(prompts) };
}

/** One page's chosen parts, ready to paint and to fit a repaint back. */
export interface PartPage {
  rects: PageRect[];
  /** The page the parts start from, with the neighbours sharing their boxes made transparent. */
  sourceImage: PageImage;
  /** Neighbours' pixels inside the chosen boxes, kept on the page; null when there are none. */
  keep: Uint8Array | null;
  /** The colour the neighbours are drawn in for the models, or null when there are none. */
  offLimits: Background | null;
  modelInput: ModelInput;
  /** The outline each placement must fit inside, or null for its box (see placementOutlines). */
  outlines: (number[] | null)[];
}

/**
 * Packs the `chosen` regions of `startImage` into the square the models see. Other parts sharing
 * the chosen boxes are kept on the page, and the models see them as flat `offLimits` shapes:
 * hidden as background, the new parts were drawn straight over them and lost there
 * (job_c61a09e7's sword lost its grip to a kneepad). `remixImage` is the remix's own page when
 * starting from the original rig: neighbours are kept where either page has them, since a remix
 * can shrink a neighbour but its mesh still shows its old area.
 */
export async function preparePartPage(
  page: AtlasPage,
  chosen: number[],
  startImage: PageImage,
  remixImage: PageImage | null,
  background: Background,
  offLimits: Background,
  outlines: Record<string, number[]>,
): Promise<PartPage> {
  const rects = chosen.map((j) => page.rects[j]);
  const hidden = neighbourPixels(startImage, page.rects, chosen);
  const sourceImage = withoutPixels(startImage, hidden);
  const keep = union(hidden, remixImage ? neighbourPixels(remixImage, page.rects, chosen) : null);
  const modelImage = hidden ? withColour(sourceImage, hidden, offLimits) : sourceImage;
  const modelInput = await toModelInput(modelImage, IMAGE_MAX_SIDE, background, centreLayout(layoutParts(rects, sourceImage)));
  return {
    rects,
    sourceImage,
    keep,
    offLimits: hidden ? offLimits : null,
    modelInput,
    outlines: await placementOutlines(outlines, page, chosen, modelInput.layout, sourceImage),
  };
}

/**
 * Fits Muse Image's repaint of `part` back into the square: the off-limits shapes cleared to
 * background, then each part shrunk into its box. Returns the fitted square, how much paint is
 * attached to the parts (see attachedFit), each part's shrink, and which dropped their outline.
 */
export async function fitRepaint(
  painted: Buffer,
  part: PartPage,
): Promise<{ attached: number; scales: number[]; outlineDropped: boolean[]; fitted: Buffer }> {
  const { modelInput } = part;
  const image = part.offLimits ? await clearColour(painted, part.offLimits, modelInput.background) : painted;
  const attached = await attachedFit(image, modelInput);
  // A part drawn bigger than its box (an axe for a sword) is shrunk to fit, not cut off.
  // A part too big for its mesh outline keeps its size and is clipped in the game until the
  // outline is grown, rather than failing a run the user has paid for.
  const { image: fitted, scales, outlineDropped } = await shrinkPartsToBoxes(image, modelInput, {
    inset: FIT_INSET,
    outlines: part.outlines,
    minOutlineScale: MIN_PART_SCALE,
    // Drawn around off-limits neighbours, where the model put the part matters: don't centre it.
    anchor: part.offLimits ? "part" : "box",
  });
  return { attached, scales, outlineDropped, fitted };
}

/**
 * Copies a fitted repaint onto the stored remix page `remixPage`: the parts take the model's new
 * silhouettes, keyed out within their own regions, and the kept neighbours stay. Returns the
 * keyed page (`fixed`) and the new remix page.
 */
export async function placeRepaint(
  fitted: Buffer,
  part: PartPage,
  remixPage: Buffer,
  premultipliedAlpha: boolean,
): Promise<{ fixed: Buffer; page: Buffer }> {
  // Already placed by shrinkPartsToBoxes, so no drift correction.
  const fixed = await fitToPage(fitted, part.modelInput, part.sourceImage, premultipliedAlpha, part.rects, false);
  return { fixed, page: await replaceRegions(remixPage, fixed, part.rects, part.keep) };
}

/**
 * Moves the packed parts to the middle of the square. With one or two parts most of the square
 * is empty, and Muse Image tends to draw in the middle whatever the input shows (see
 * FRICTION_LOG.md, 2026-10-28), so a centred part is where it draws anyway.
 */
function centreLayout(layout: PartLayout): PartLayout {
  const { placements } = layout;
  if (placements.length === 0) return layout;
  const left = Math.min(...placements.map((p) => p.x));
  const top = Math.min(...placements.map((p) => p.y));
  const dx = (1 - (Math.max(...placements.map((p) => p.x + p.width)) - left)) / 2 - left;
  const dy = (1 - (Math.max(...placements.map((p) => p.y + p.height)) - top)) / 2 - top;
  return { ...layout, placements: placements.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
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
      pages.map(async (p, i) => (selected[i].length > 0 ? decodePage(await fetchBaseFile(dir + p.name, signal), original.premultipliedAlpha, p.size) : null)),
    );
    const sameSize = images.every((img, i) => !img || (img.width === remixImages[i].width && img.height === remixImages[i].height));
    return sameSize ? images : null;
  } catch (error) {
    signal.throwIfAborted();
    console.error("Couldn't load the original rig for a part fix; using the remix's own parts", error);
    return null;
  }
}

/**
 * The image prompt: Muse's expanded `plan`, or, when its reply was unusable, the user's request
 * as-is with the remix's own prompt for the look, wrapped in the fixed layout rules.
 */
function buildPrompt(
  input: PartFixRequest,
  plan: string | null,
  count: number,
  background: string,
  offLimits: string | null,
  source: "original" | "remix",
): string {
  return [
    `This image shows ${count === 1 ? "one part" : `${count} separate parts`} cut from a 2D game character's sprite atlas, on a solid ${background} background.`,
    ...(plan
      ? [plan]
      : [
          source === "original" ? "They are the character's original parts, before restyling." : "They are the character's current parts, which need fixing.",
          input.remix.prompt ? `The rest of the character has been restyled as: ${input.remix.prompt}.` : "",
          `Repaint ${count === 1 ? "this part" : "these parts"}: ${input.prompt}.`,
          `Art style: ${input.remix.style}.`,
        ]),
    input.keepOutline ? "Keep each part inside its original outline: the game only shows what's inside it." : "",
    `Repaint every part in place, at the same size. Do not add or merge parts. Keep the background solid ${background}, and leave the empty ${background} areas empty.`,
    offLimits
      ? `The flat solid ${offLimits} shapes are space other parts use: leave them exactly as they are, solid ${offLimits}, and keep every new part off them, even where that changes its shape.`
      : "",
    "Each part is a separate cut-out piece. Don't complete it into a whole object: no heads inside helmets, no legs inside boots or greaves, no hands or feet on limb segments.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * For each placement in the square, the outline its part must fit inside (fractions of the
 * square), or null for its box alone. Each mesh outline is mapped from UVs to the page and then
 * into the square, and kept only when it holds most of the original part (MIN_OUTLINE_COVER).
 */
export async function placementOutlines(
  outlines: Record<string, number[]>,
  page: AtlasPage,
  chosen: number[],
  layout: PartLayout,
  image: PageImage,
): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = layout.placements.map(() => null);
  for (const [k, j] of chosen.entries()) {
    const uvs = outlines[page.regions[j]];
    const p = layout.placements[layout.regionPlacement[k]];
    if (!uvs || !p) continue;
    const onPage: number[] = [];
    for (let n = 0; n + 1 < uvs.length; n += 2) onPage.push(...uvToPage(page.rects[j], page.frames[j], uvs[n], uvs[n + 1]));
    if ((await outlineCover(onPage, page.rects[j], image)) < MIN_OUTLINE_COVER) continue;
    out[layout.regionPlacement[k]] = onPage.map((v, n) =>
      n % 2 === 0 ? p.x + ((v - p.src.x) / p.src.width) * p.width : p.y + ((v - p.src.y) / p.src.height) * p.height,
    );
  }
  return out;
}

/** Share of the opaque pixels in `rect` that lie inside the polygon `points` (page pixels). */
async function outlineCover(points: number[], rect: PageRect, image: PageImage): Promise<number> {
  const coords = [];
  for (let n = 0; n + 1 < points.length; n += 2) coords.push(`${points[n] - rect.x},${points[n + 1] - rect.y}`);
  const svg = `<svg width="${rect.width}" height="${rect.height}" xmlns="http://www.w3.org/2000/svg"><polygon points="${coords.join(" ")}" fill="#fff"/></svg>`;
  const alpha = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer();
  let opaque = 0, inside = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (image.rgba[((rect.y + y) * image.width + rect.x + x) * 4 + 3] < 128) continue;
      opaque++;
      if (alpha[y * rect.width + x] >= 128) inside++;
    }
  }
  return opaque === 0 ? 0 : inside / opaque;
}

/**
 * One line per chosen part for Muse, e.g. "sward: x 38–62%, y 9–91%": where it sits in the
 * square both models see, as percentages from the left and top.
 */
function describeParts(names: string[], layout: PartLayout): string[] {
  const pct = (v: number) => Math.round(100 * v);
  return names.flatMap((name, k) => {
    const p = layout.placements[layout.regionPlacement[k]];
    return p ? [`${name}: x ${pct(p.x)}–${pct(p.x + p.width)}%, y ${pct(p.y)}–${pct(p.y + p.height)}%`] : [];
  });
}

/** Alpha at which a pixel counts as painted when tracing which part it belongs to. */
const PAINTED_ALPHA = 16;
/** Pixels kept around a neighbour's paint, so its soft edge and the margin its mesh shows aren't painted over. */
const NEIGHBOUR_MARGIN = 2;

/**
 * Pixels inside the chosen regions' boxes that belong to other regions, or null when no other
 * box overlaps a chosen one. Polygon-packed atlases overlap their boxes (the fire knight's chest
 * box holds a corner of its axe, job_31687ecf), so the box alone doesn't say whose a pixel is.
 * Each painted pixel in an overlap goes to the part it's joined to, by a flood over painted
 * pixels from where only one side's boxes reach. Paint joined to neither is kept as the
 * neighbour's, with NEIGHBOUR_MARGIN around it.
 */
function neighbourPixels(image: PageImage, rects: PageRect[], chosen: number[]): Uint8Array | null {
  const mine = new Set(chosen);
  const overlaps = (a: PageRect, b: PageRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const others = rects.flatMap((r, j) => (!mine.has(j) && chosen.some((k) => overlaps(r, rects[k])) ? [j] : []));
  if (others.length === 0) return null;

  const { width, height, rgba } = image;
  // Per pixel: 1 inside a chosen box, 2 inside an overlapping other box, 3 inside both.
  const cover = new Uint8Array(width * height);
  const mark = (r: PageRect, side: number) => {
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.height, height); y++) {
      for (let x = Math.max(r.x, 0); x < Math.min(r.x + r.width, width); x++) cover[y * width + x] |= side;
    }
  };
  for (const j of chosen) mark(rects[j], 1);
  for (const j of others) mark(rects[j], 2);
  const painted = (p: number) => rgba[p * 4 + 3] >= PAINTED_ALPHA;

  // Flood both sides at once, so paint joined to both goes to the nearer one.
  const owner = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  for (let p = 0; p < cover.length; p++) {
    if ((cover[p] === 1 || cover[p] === 2) && painted(p)) {
      owner[p] = cover[p];
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
      if (q < 0 || q >= cover.length || !cover[q] || owner[q] || !painted(q)) continue;
      owner[q] = owner[p];
      queue[tail++] = q;
    }
  }

  const theirs = new Uint8Array(width * height);
  let found = false;
  for (let p = 0; p < cover.length; p++) {
    if (cover[p] === 3 && painted(p) && owner[p] !== 1) {
      theirs[p] = 1;
      found = true;
    }
  }
  if (!found) return null;
  for (let step = 1; step <= NEIGHBOUR_MARGIN; step++) {
    const grown = Uint8Array.from(theirs);
    for (let p = 0; p < cover.length; p++) {
      if (theirs[p] !== step) continue;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < cover.length && cover[q] === 3 && !grown[q] && owner[q] !== 1) grown[q] = step + 1;
      }
    }
    theirs.set(grown);
  }
  return theirs;
}

function union(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (!a || !b) return a ?? b;
  return a.map((v, p) => (v || b[p] ? 1 : 0));
}

/** The image with the `mask` pixels made opaque `colour`, flat. */
function withColour(image: PageImage, mask: Uint8Array, colour: Background): PageImage {
  const [r, g, b] = hexToRgb(colour.hex);
  const rgba = Buffer.from(image.rgba);
  for (let p = 0; p < mask.length; p++) if (mask[p]) rgba.set([r, g, b, 255], p * 4);
  return { ...image, rgba };
}

/**
 * Colour distance within which a pixel of the model's image counts as `colour` (the off-limits
 * key) in clearColour. The key is picked to stay far from the art (see pickOffLimits).
 */
const OFF_LIMITS_MATCH = 80;

/**
 * The model's image with the off-limits shapes turned into `background`, so the checks and
 * keying see only the parts: every pixel near `colour`, and the blended edge between it and the
 * background next to those pixels. Returned as a PNG.
 */
async function clearColour(image: Buffer, colour: Background, background: Background): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const key = hexToRgb(colour.hex), bg = hexToRgb(background.hex);
  const near = new Uint8Array(width * height);
  for (let p = 0; p < near.length; p++) {
    if (Math.hypot(data[p * 3] - key[0], data[p * 3 + 1] - key[1], data[p * 3 + 2] - key[2]) < OFF_LIMITS_MATCH) near[p] = 1;
  }
  // A blend of key and background sits on the line between them; only checked next to the key,
  // since that line can cross art colours (magenta to green passes grey).
  const [dx, dy, dz] = [bg[0] - key[0], bg[1] - key[1], bg[2] - key[2]];
  const len2 = dx * dx + dy * dy + dz * dz;
  const onEdge = (p: number) => {
    const [r, g, b] = [data[p * 3] - key[0], data[p * 3 + 1] - key[1], data[p * 3 + 2] - key[2]];
    const t = Math.min(1, Math.max(0, (r * dx + g * dy + b * dz) / len2));
    return Math.hypot(r - t * dx, g - t * dy, b - t * dz) < OFF_LIMITS_MATCH;
  };
  const clear = Uint8Array.from(near);
  for (let p = 0; p < near.length; p++) {
    if (near[p]) continue;
    const x = p % width, y = (p - x) / width;
    let touches = false;
    for (let ny = Math.max(0, y - 2); ny <= Math.min(height - 1, y + 2) && !touches; ny++) {
      for (let nx = Math.max(0, x - 2); nx <= Math.min(width - 1, x + 2) && !touches; nx++) touches = near[ny * width + nx] === 1;
    }
    if (touches && onEdge(p)) clear[p] = 1;
  }
  for (let p = 0; p < clear.length; p++) if (clear[p]) data.set(bg, p * 3);
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** The image with the `hidden` pixels made transparent, so they're painted as background. */
function withoutPixels(image: PageImage, hidden: Uint8Array | null): PageImage {
  if (!hidden) return image;
  const rgba = Buffer.from(image.rgba);
  for (let p = 0; p < hidden.length; p++) if (hidden[p]) rgba.fill(0, p * 4, p * 4 + 4);
  return { ...image, rgba };
}

/**
 * The stored remix page with `rects` replaced by the same areas of `fixed`, except the `keep`
 * pixels (other parts sharing the boxes). Both are encoded pages of the same size and alpha
 * mode, so pixels are copied as they are.
 */
async function replaceRegions(page: Buffer, fixed: Buffer, rects: PageRect[], keep: Uint8Array | null): Promise<Buffer> {
  const { data: base, info } = await sharp(page).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: patch } = await sharp(fixed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  for (const r of rects) {
    const x0 = Math.max(r.x, 0), x1 = Math.min(r.x + r.width, width);
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.height, height); y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * width + x;
        if (!keep?.[p]) patch.copy(base, p * 4, p * 4, p * 4 + 4);
      }
    }
  }
  return sharp(base, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
