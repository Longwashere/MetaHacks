import path from "node:path";
import { type AtlasPage, isSafePageName, parseAtlas } from "./atlas.js";
import { type PartLayout, layoutParts } from "../../lib/layout.js";
import { boxMeshes, checkMeshes, meshOutlines } from "../../lib/mesh.js";
import { type CropResult, measureCrops } from "./crop.js";
import {
  ContentPolicyError,
  currentModelCalls,
  type Inspection,
  type InspectionContext,
  type InspectionIssue,
  STYLE_LOOKS,
  describeReference,
  describeStyle,
  inspectRig,
  inspectStyle,
  keptPartProperties,
  planRemix,
  repaintPage,
  reviewTweaks,
  revisePlan,
  rewordForContentPolicy,
  type TweakPart,
  type TweakReview,
  styleInstruction,
  totalUsage,
} from "./meta.js";
import { placementOutlines, runPartFix } from "./part-fix.js";
import { drawRig, loadRig, renderRestPose } from "./render.js";
import { type MeasuredPart, type PartTransform, type SkippedTweak, applyTweaks, lostContacts, measureFixes } from "./tweak.js";
import { objectUrl, putFile } from "../../lib/storage.js";
import {
  type PageImage,
  alignGenerated,
  decodePage,
  fitToPage,
  layoutFit,
  pickBackground,
  shrinkPartsToBoxes,
  toDataUrl,
  toModelInput,
} from "./textures.js";
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
const INSPECT_EXPECTED_MS = 15_000;
/** Margin kept clear inside each part's box when a part is shrunk to fit, as in part fixes. */
const FIT_INSET = 0.02;
/**
 * A part the model drew so big it has to shrink below this to fit its box is sent to a part fix:
 * shrinking that far would hide the mistake, not fix it. Above it, shrinking just keeps the part
 * whole; job_909e5229's goblin head came out a little wide and was cut off at its box (0.84 fits it).
 */
const MIN_PART_SCALE = 0.5;
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

// The loop's limits. Every round repaints every page (one image call each, two when the layout
// check fails) and runs up to two Spark checks; every part fix is a Spark plan and an image call.
/** Full repaints of the sheet that got through the layout check and were inspected. */
const MAX_ROUNDS = 2;
/** Full repaints in all, counting ones the layout check threw out. */
const MAX_PAINT_ROUNDS = 3;
/** Image calls per page in one round, when the layout check keeps failing. */
const MAX_LAYOUT_ATTEMPTS = 2;
/** Part fixes after a failed rig check, per round. */
const MAX_PART_FIXES = 2;
/** A rig check that blames more parts than this is redone as a full repaint instead of a part fix. */
const MAX_FIX_PARTS = 6;
/** No new round or part fix starts after this long; the job's own deadline is REMIX_JOB_TIMEOUT_MS. */
const LOOP_BUDGET_MS = 8 * 60_000;
/**
 * A rig check scoring at least this, after its part fixes, ships: the first live run scored a
 * passing style 0.88, then spent three more repaints chasing the rig check (FRICTION_LOG.md, 2026-10-29).
 */
const GOOD_ENOUGH_RIG = 0.6;
/** Tries per part fix, for network errors only; the part fix retries its own bad paint. */
const PART_FIX_ATTEMPTS = 2;
/** Spark took 47 s to revise a plan with one page and a render (2026-10-29). */
const REVISE_EXPECTED_MS = 45_000;
/**
 * The tweak step's one Spark review. A free-hand review, guessing moves from the picture, took
 * 80–98 s and ~6k reasoning tokens per round on job_909e5229's goblin; now the moves are measured
 * in code and Spark only approves them.
 */
const TWEAK_EXPECTED_MS = 60_000;
/** Longest inspector summary shown in the progress stage. */
const MAX_STAGE_SUMMARY = 90;
/** Inspector feedback carried into the next repaint, at most. */
const MAX_FEEDBACK_CHARS = 700;
/** A check whose inspector reply was unusable counts as passed with this score, so it never blocks a remix. */
const UNCHECKED_SCORE = 0.7;

/** One painted version of the sheet, as stored. */
interface Candidate {
  round: number;
  atlas: string;
  textures: string[];
  /** The stored pages decoded, for drawing the assembled character. */
  images: PageImage[];
  style: Inspection | null;
  rig: Inspection | null;
  /** The last drawing of the assembled character, as a data URL, for revising the plan. */
  render: string | null;
  /** Parts drawn bigger than their box and shrunk to fit, with the scale (see shrinkPartsToBoxes). */
  shrunk: { part: string; scale: number }[];
  /** Rigid meshes swapped for a box over their region so a repaint that outgrew them shows whole (see assess). */
  boxed: string[];
  /** Regions still cut off by a mesh the game clips them to, after boxing (see crop.ts). */
  crops: CropResult[];
}

/** What the tweak step did, for prompts.json. */
interface TweakLog {
  /** Each part's status and measured fix. */
  measured: Record<string, MeasuredPart>;
  /** Spark's review, or null when it was unusable and the measured fixes went in as they were. */
  review: TweakReview | null;
  /** Tweaks the damage check undid, with the neighbours each one pulled the part away from. */
  reverted: Record<string, string[]>;
  skipped: SkippedTweak[];
  /** The final tweaks by slot. */
  tweaks: Record<string, PartTransform>;
  /** Regions the final remix still has cut off by their mesh (texture space, so tweaks don't change it). */
  crops: CropResult[];
}

/** What each round did, for prompts.json. */
interface RoundLog {
  round: number;
  feedback: string;
  layoutChecks: { page: string; attempt: number; insideBoxes: number }[];
  layoutFailed?: boolean;
  /** Parts the crop check found cut off by a mesh that can't be boxed, so they were fitted inside its outline. */
  fittedToOutline?: string[];
  /** Rigid meshes boxed, and regions still cut off by their mesh (see Candidate). */
  boxed?: string[];
  crops?: CropResult[];
  /** Parts shrunk to fit their box, by atlas region (see Candidate.shrunk). */
  shrunk?: { part: string; scale: number }[];
  /** Spark's rewritten edit prompt after this round's checks, used by the next round. */
  revisedEditPrompt?: string;
  style?: Inspection | null;
  rig?: Inspection | null;
  partFixes: { regions: string[]; prompt: string; rig?: Inspection | null; error?: string }[];
  score?: number;
  /** The tweak step (on a "round 0" entry after the loop). */
  tweak?: TweakLog;
}

/**
 * Re-textures the base rig in a loop of painting and inspection:
 *
 * 1. Muse Spark plans the new look (as in v2).
 * 2. Muse Image repaints every page. A page whose parts moved (layoutFit, checked in code) is
 *    painted once more; if it fails again the round is thrown out and repainted, same plan.
 * 3. Style check: Spark compares the assembled character before and after (render.ts) with the
 *    request. On a failure Spark rewrites the edit prompt from the issues (revisePlan) and the
 *    whole sheet is repainted.
 * 4. Rig check: Spark looks at how the repainted parts hold together. Problems pinned to a few
 *    parts go to a part fix (part-fix.ts) and are checked again, and the loop ends there either
 *    way. Broader problems rewrite the edit prompt and repaint the sheet.
 *
 * It stops when both checks pass, when the rig check reaches GOOD_ENOUGH_RIG, when a round scores
 * no better than the best so far, or after MAX_ROUNDS / LOOP_BUDGET_MS, and then returns the
 * best-scoring version. Each round is stored under <timestamp>_<jobId>/round-<n>/, with
 * prompts.json in the job folder recording every check.
 *
 * Throw an Error with a user-facing message on failure; the job runner stores it as
 * `job.error`. `signal` fires when the whole job runs out of time — pass it through.
 */
export async function runRemix(
  jobId: string,
  input: RemixRequest,
  onProgress: RemixProgress,
  onPrompt: RemixPromptUpdate,
  signal: AbortSignal,
): Promise<RemixResult> {
  const started = Date.now();
  const hasTime = () => Date.now() - started < LOOP_BUDGET_MS;
  const { base } = input;

  onProgress(0.05, "Reading rig & atlas regions");
  const atlasText = (await fetchBaseFile(base.atlasUrl, signal)).toString("utf8");
  const pages = parseAtlas(atlasText);
  if (pages.length === 0) throw new Error("The base rig's atlas has no pages.");
  if (!pages.every((p) => isSafePageName(p.name))) throw new Error("The base rig's atlas can't be remixed.");

  const atlasDir = base.atlasUrl.slice(0, base.atlasUrl.lastIndexOf("/") + 1);
  const [images, skeletonFile] = await Promise.all([
    Promise.all(pages.map(async (p) => decodePage(await fetchBaseFile(atlasDir + p.name, signal), base.premultipliedAlpha, p.size))),
    fetchBaseFile(base.skeletonUrl, signal),
  ]);
  const binarySkeleton = !new URL(base.skeletonUrl).pathname.toLowerCase().endsWith(".json");

  // One background for every page, so the reference page matches the one being painted.
  const background = pickBackground(images, input.prompt);
  /** Draws the rig at rest with these pages, and a candidate's boxed meshes when given. */
  const render = async (pageImages: PageImage[], candidate?: Candidate) => {
    const png = await renderRestPose(
      candidate ? skeletonFor(candidate) : skeletonFile,
      binarySkeleton,
      atlasText,
      pages.map((p, i) => ({ name: p.name, image: pageImages[i] })),
      background.hex,
    );
    return png && { png, dataUrl: await toDataUrl(png, PLAN_MAX_SIDE) };
  };
  // Without a drawing of the character (e.g. a skeleton spine-core can't read), both checks are skipped.
  const before = await render(images);

  // Meshes: rigid ones can become a box when a repaint outgrows them; the rest (weighted or
  // deformed) can't, so a part the crop check finds cut off by one is fitted inside its outline
  // when painted. Fitting every such part up front over-shrinks: on job_909e5229 it shrank six
  // goblin parts (a leg to 0.68) that the crop check found uncut, as the original art spills past
  // those outlines too. A .skel can't be read for either; the crop check still reports its cuts.
  const baseJson: unknown = binarySkeleton ? null : JSON.parse(skeletonFile.toString("utf8"));
  const allRegions = [...new Set(pages.flatMap((p) => p.regions))];
  const boxable = new Set(baseJson ? checkMeshes(baseJson, allRegions).filter((c) => c.reason === null).map((c) => c.region) : []);
  const fixedOutlines = baseJson ? meshOutlines(baseJson, allRegions) : {};
  /** The skeleton a candidate is drawn with: the base one, with its boxed meshes. */
  const skeletonFor = (candidate: Candidate): Buffer | string => {
    if (!baseJson || candidate.boxed.length === 0) return skeletonFile;
    const json = structuredClone(baseJson);
    boxMeshes(json, candidate.boxed);
    return JSON.stringify(json);
  };
  const originalByName = new Map(pages.map((p, i) => [p.name, images[i]]));
  const baseRig = loadRig(skeletonFile, binarySkeleton, atlasText);
  /**
   * The crop check on a candidate: rigid meshes that cut off its paint are boxed, and what's still
   * cut off is kept in `crops` for the rig check (withPartProblems). Takes milliseconds.
   */
  const assess = (candidate: Candidate) => {
    const rig = loadRig(skeletonFor(candidate), binarySkeleton, atlasText);
    if (!rig) return;
    const remixByName = new Map(pages.map((p, i) => [p.name, candidate.images[i]]));
    const cropped = measureCrops(rig, remixByName, originalByName).filter((c) => c.cropped);
    const toBox = cropped.filter((c) => boxable.has(c.region) && !candidate.boxed.includes(c.region)).map((c) => c.region);
    candidate.boxed = [...candidate.boxed, ...toBox];
    candidate.crops = cropped.filter((c) => !toBox.includes(c.region));
  };

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
  const referenceImage = referenceUrl ? await toDataUrl(await fetchBaseFile(referenceUrl, signal), REFERENCE_MAX_SIDE) : null;
  const referenceLook = referenceImage
    ? await withProgress(onProgress, 0.06, 0.1, "Studying the reference image", REFERENCE_EXPECTED_MS, () =>
        describeReference(referenceImage, pageImages[0], input.prompt, signal),
      )
    : null;
  if (referenceUrl && !referenceLook) throw new Error("Muse couldn't read the reference image. Try again or use another image.");
  // An art style the user picked beats the reference image's.
  const referenceStyle = input.style === "auto" ? (referenceLook?.style ?? null) : null;
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
  const regionNames = [...new Set(pages.flatMap((p) => p.regions))];
  const inspection = (): InspectionContext => ({
    prompt: input.prompt,
    editPrompt,
    styleLook,
    referenceLook: referenceLook?.look ?? null,
    keepPalette: input.keepPalette,
    parts: regionNames,
  });
  const rounds: RoundLog[] = [];

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
          api: "v3",
          base: base.name,
          request,
          parts,
          referenceLook,
          plan,
          styleLook,
          imagePrompt: buildImagePrompt(editPrompt),
          soften,
          ...(reworded ? { rewordedForContentPolicy: true } : {}),
          rendered: Boolean(before),
          rounds,
          // Token use so far, from each Meta response's `usage` (see recordModelCalls in jobs.ts).
          usage: totalUsage(currentModelCalls() ?? []),
          modelCalls: currentModelCalls() ?? [],
        },
        null,
        2,
      ),
    );
  await writePrompts();
  if (before) await putFile(folder, "before.png", before.png);

  /** Paints every page once more, with `feedback` from the last checks. Null when the layout check failed twice on a page. */
  const paintRound = async (log: RoundLog, from: number, to: number): Promise<Candidate | null> => {
    const roundFolder = `${folder}/round-${log.round}`;
    const label = log.round > 1 ? `Attempt ${log.round}: ` : "";
    let reference: string | null = null;
    const pageKeys: string[] = [];
    const fitted: PageImage[] = [];
    const shrunk: Candidate["shrunk"] = [];
    for (const [i, page] of pages.entries()) {
      const modelInput = await toModelInput(images[i], IMAGE_MAX_SIDE, background, layouts[i], soften);
      const generated = await withProgress(
        onProgress,
        from + ((to - from) * i) / pages.length,
        from + ((to - from) * (i + 1)) / pages.length,
        label + (pages.length > 1 ? `Painting page ${i + 1} of ${pages.length}` : "Painting new textures"),
        PAGE_EXPECTED_MS,
        async () => {
          const paint = (note: string) => {
            const prompt = [buildImagePrompt(editPrompt), log.feedback, note].filter(Boolean).join(" ");
            return repaintPage(
              modelInput,
              reference ? `${prompt} The second image is an already repainted page of the same asset; match its colors and materials.` : prompt,
              reference,
              signal,
            );
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
              await writePrompts();
              return await paint(note);
            }
          };
          // Muse Image sometimes draws a new layout instead of repainting the parts in place;
          // fitting that back would scramble the sheet, so the page is painted again.
          for (let attempt = 1; attempt <= MAX_LAYOUT_ATTEMPTS; attempt++) {
            const image = await paintOnce(attempt > 1 ? LAYOUT_RETRY_NOTE : "");
            const fit = await layoutFit(image, modelInput);
            log.layoutChecks.push({ page: page.name, attempt, insideBoxes: Math.round(fit * 100) / 100 });
            await writePrompts();
            if (fit >= MIN_LAYOUT_FIT) return image;
            await putFile(roundFolder, `${path.parse(page.name).name}.rejected-${attempt}.png`, image);
          }
          return null;
        },
      );
      signal.throwIfAborted();
      if (!generated) return null;
      // The raw model output, kept for debugging how well it lined up with the page.
      await putFile(roundFolder, `${path.parse(page.name).name}.generated.png`, generated);
      // Kept outlines reuse the original alpha; otherwise the model's own shapes are keyed out, and
      // a part drawn bigger than its box is shrunk to fit rather than cut off at the box's edge.
      let pagePng: Buffer;
      if (input.keepOutline) {
        pagePng = await fitToPage(generated, modelInput, images[i], base.premultipliedAlpha, null);
      } else {
        const aligned = await alignGenerated(generated, modelInput, images[i], page.rects);
        let fit = await shrinkPartsToBoxes(aligned, modelInput, { inset: FIT_INSET, anchor: "part" });
        pagePng = await fitToPage(fit.image, modelInput, images[i], base.premultipliedAlpha, page.rects, false);
        // A part the game would cut off at a mesh that can't be boxed is fitted inside its outline too.
        const cut = baseRig
          ? measureCrops(baseRig, new Map([[page.name, await decodePage(pagePng, base.premultipliedAlpha)]]), originalByName)
              .filter((c) => c.cropped && fixedOutlines[c.region])
              .map((c) => c.region)
          : [];
        if (cut.length > 0) {
          const outlines = await placementOutlines(
            Object.fromEntries(cut.map((r) => [r, fixedOutlines[r]])),
            page,
            page.regions.map((_, j) => j),
            layouts[i],
            images[i],
          );
          fit = await shrinkPartsToBoxes(aligned, modelInput, { inset: FIT_INSET, anchor: "part", outlines, minOutlineScale: MIN_PART_SCALE });
          pagePng = await fitToPage(fit.image, modelInput, images[i], base.premultipliedAlpha, page.rects, false);
          log.fittedToOutline = [...(log.fittedToOutline ?? []), ...cut];
        }
        for (const [k, scale] of fit.scales.entries()) {
          if (scale >= 1) continue;
          const regions = page.regions.filter((_, j) => layouts[i].regionPlacement[j] === k);
          for (const part of regions) shrunk.push({ part, scale });
        }
      }
      pageKeys.push(await putFile(roundFolder, page.name, pagePng));
      fitted.push(await decodePage(pagePng, base.premultipliedAlpha));
      reference ??= await toDataUrl(generated, PLAN_MAX_SIDE);
    }
    // Regions are unchanged and page names are kept, so the base atlas works as-is.
    const atlas = await putFile(roundFolder, "remix.atlas", atlasText);
    log.shrunk = shrunk;
    const candidate: Candidate = { round: log.round, atlas, textures: pageKeys, images: fitted, style: null, rig: null, render: null, shrunk, boxed: [], crops: [] };
    assess(candidate);
    log.boxed = candidate.boxed;
    log.crops = candidate.crops;
    return candidate;
  };

  /** Draws the candidate and runs one check on it; a check that can't run passes. */
  const check = async (
    candidate: Candidate,
    kind: "style" | "rig",
    name: string,
    from: number,
    to: number,
    stage: string,
  ): Promise<Inspection | null> => {
    const after = before && (await render(candidate.images, candidate));
    if (!before || !after) return null;
    candidate.render = after.dataUrl;
    await putFile(`${folder}/round-${candidate.round}`, `${name}.png`, after.png);
    return withProgress(onProgress, from, to, stage, INSPECT_EXPECTED_MS, () =>
      kind === "style"
        ? inspectStyle(inspection(), before.dataUrl, after.dataUrl, referenceImage, signal)
        : inspectRig({ ...inspection(), shrunk: candidate.shrunk }, before.dataUrl, after.dataUrl, signal),
    );
  };

  // Mesh outlines the game clips parts to, so part fixes keep inside them (see part-fix.ts).
  // A binary .skel can't be read for them; its parts fit their boxes only.
  const meshes = binarySkeleton ? [] : checkMeshes(JSON.parse(skeletonFile.toString("utf8")), regionNames);

  /** Repaints the parts the rig check blamed. Returns the fixed candidate, or null when the fix failed. */
  const fixParts = async (candidate: Candidate, issues: InspectionIssue[], log: RoundLog, from: number, to: number): Promise<Candidate | null> => {
    const regions = [...new Set(issues.flatMap((i) => (i.part ? [i.part] : [])))];
    const prompt = issues.filter((i) => i.part).map((i) => `${i.part}: ${i.fix}`).join(" ");
    const entry: RoundLog["partFixes"][number] = { regions, prompt };
    log.partFixes.push(entry);
    const fixMeshes = meshes.filter((m) => regions.includes(m.region) && m.hull.length >= 6);
    const runFix = () =>
      runPartFix(
        `${jobId}-r${log.round}-fix${log.partFixes.length}`,
        {
          regions,
          prompt,
          source: "remix",
          keepOutline: fixMeshes.length > 0,
          outlines: Object.fromEntries(fixMeshes.map((m) => [m.region, m.hull])),
          remix: {
            atlasUrl: objectUrl(candidate.atlas),
            premultipliedAlpha: base.premultipliedAlpha,
            prompt: input.prompt,
            editPrompt,
            style: input.style,
          },
          original: { atlasUrl: base.atlasUrl, premultipliedAlpha: base.premultipliedAlpha },
        },
        (p, stage) => onProgress(from + (to - from) * p, `Fixing ${regions.join(", ").slice(0, 60)}: ${stage}`),
        () => {},
        signal,
      );
    try {
      let result: Awaited<ReturnType<typeof runPartFix>>;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await runFix();
          break;
        } catch (error) {
          // fetch throws a TypeError on network failures; anything else is the fix itself failing.
          if (!(error instanceof TypeError) || attempt >= PART_FIX_ATTEMPTS) throw error;
          signal.throwIfAborted();
          console.warn(`Part fix in remix ${jobId} hit a network error; retrying`, error);
        }
      }
      const fixedImages = await Promise.all(
        result.textures.map(async (key) => decodePage(await fetchBaseFile(objectUrl(key), signal), base.premultipliedAlpha)),
      );
      // The part fix fitted the parts it repainted; the rest keep their shrink.
      const shrunk = candidate.shrunk.filter((s) => !regions.includes(s.part));
      const fixed: Candidate = { ...candidate, atlas: result.atlas, textures: result.textures, images: fixedImages, rig: null, render: null, shrunk };
      assess(fixed);
      return fixed;
    } catch (error) {
      signal.throwIfAborted();
      // A failed part fix keeps the candidate as it was.
      console.warn(`Part fix in remix ${jobId} failed`, error);
      entry.error = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      await writePrompts();
    }
  };

  let best: { candidate: Candidate; score: number } | null = null;
  const keep = (candidate: Candidate, log: RoundLog) => {
    const score = scoreOf(candidate);
    log.score = Math.round(score * 100) / 100;
    if (!best || score > best.score) best = { candidate, score };
  };

  /**
   * Has Spark rewrite the edit prompt from the issues, so the next round tells the image model
   * something different. Falls back to adding the fixes to the image prompt.
   */
  const revise = async (candidate: Candidate, issues: InspectionIssue[], log: RoundLog, from: number, to: number, stage: string) => {
    const revised = candidate.render
      ? await withProgress(onProgress, from, to, stage, REVISE_EXPECTED_MS, () =>
          revisePlan({ prompt: input.prompt, editPrompt, parts, issues }, pageImages, candidate.render ?? "", signal),
        )
      : null;
    if (revised) {
      editPrompt = revised;
      log.revisedEditPrompt = revised;
      onPrompt(editPrompt, reworded ? "reworded" : "original");
      feedback = "";
    } else {
      feedback = feedbackNote(issues);
    }
    await writePrompts();
  };
  const summary = (inspection: Inspection) => {
    const text = inspection.summary.replace(/[.\s]+$/, "");
    return text.length > MAX_STAGE_SUMMARY ? `${text.slice(0, MAX_STAGE_SUMMARY - 1)}…` : text;
  };

  let feedback = "";
  let inspected = 0;
  for (let round = 1; round <= MAX_PAINT_ROUNDS && inspected < MAX_ROUNDS; round++) {
    if (round > 1 && !hasTime()) break;
    const at = (share: number) => 0.2 + (0.75 * (round - 1 + share)) / MAX_PAINT_ROUNDS;
    const label = round > 1 ? `Attempt ${round}: ` : "";
    const log: RoundLog = { round, feedback, layoutChecks: [], partFixes: [] };
    rounds.push(log);
    const bestBefore = best === null ? null : (best as { score: number }).score;

    let candidate = await paintRound(log, at(0), at(0.5));
    if (!candidate) {
      // The plan and any feedback carry over: the next round retries the same improvement.
      log.layoutFailed = true;
      await writePrompts();
      continue;
    }
    inspected++;

    // Style first: a wrong look repaints everything, so there's no point fixing joints yet.
    candidate.style = (await check(candidate, "style", "style", at(0.5), at(0.6), `${label}Checking the style`)) ?? null;
    log.style = candidate.style;
    await writePrompts();
    if (candidate.style && !candidate.style.pass) {
      keep(candidate, log);
      if (bestBefore !== null && scoreOf(candidate) <= bestBefore) break;
      if (inspected < MAX_ROUNDS && hasTime()) {
        await revise(candidate, candidate.style.issues, log, at(0.9), at(1), `Style off (${summary(candidate.style)}). Rewriting the plan`);
      }
      continue;
    }

    candidate.rig = withPartProblems(candidate, await check(candidate, "rig", "rig", at(0.6), at(0.68), `${label}${candidate.style ? `Style looks right (${summary(candidate.style)}). ` : ""}Checking how the parts fit`));
    log.rig = candidate.rig;
    await writePrompts();
    for (let fix = 0; candidate.rig && !candidate.rig.pass && fix < MAX_PART_FIXES && hasTime(); fix++) {
      if (!isLocal(candidate.rig)) break;
      keep(candidate, log);
      const span = 0.22 / MAX_PART_FIXES;
      const fixed = await fixParts(candidate, candidate.rig.issues.filter((i) => i.part), log, at(0.68 + span * fix), at(0.68 + span * (fix + 0.8)));
      if (!fixed) break;
      fixed.rig = withPartProblems(
        fixed,
        await check(fixed, "rig", `rig.fix-${fix + 1}`, at(0.68 + span * (fix + 0.8)), at(0.68 + span * (fix + 1)), `${label}Checking the fixed parts`),
      );
      log.partFixes[log.partFixes.length - 1].rig = fixed.rig;
      await writePrompts();
      candidate = fixed;
    }
    log.rig = candidate.rig;
    keep(candidate, log);
    await writePrompts();
    const rig = candidate.rig;
    if (!rig || rig.pass || rig.score >= GOOD_ENOUGH_RIG) break;
    // Problems in a few parts were the part fixes' to solve; repainting the sheet would throw away
    // everything that passed. A round that didn't beat the last one won't be beaten by another.
    if (isLocal(rig) || (bestBefore !== null && scoreOf(candidate) <= bestBefore)) break;
    if (inspected < MAX_ROUNDS && hasTime()) {
      await revise(candidate, rig.issues, log, at(0.9), at(1), `Parts don't fit (${summary(rig)}). Rewriting the plan`);
    }
  }

  // Assigned inside closures, so TypeScript can't see it; read it back through a typed local.
  const chosen = best as { candidate: Candidate; score: number } | null;
  if (!chosen) throw new Error("The image model moved the parts out of place every time. Try a smaller change or a lower strength.");
  await writePrompts();

  // Tweak step: parts are moved and scaled back to fit like the original. Only a JSON skeleton can
  // be rewritten; a .skel keeps its parts as painted.
  const tweakLog: TweakLog = { measured: {}, review: null, reverted: {}, skipped: [], tweaks: {}, crops: [] };
  const tweakedSkeleton = binarySkeleton || !before ? null : await tweakParts(chosen.candidate, tweakLog);
  // Boxed meshes have to ship with the remix even when nothing was tweaked.
  const skeleton =
    tweakedSkeleton ?? (chosen.candidate.boxed.length > 0 ? await putFile(folder, "skeleton.json", skeletonFor(chosen.candidate).toString()) : null);
  if (Object.keys(tweakLog.measured).length > 0) {
    rounds.push({ round: 0, feedback: "", layoutChecks: [], partFixes: [], tweak: tweakLog });
    await writePrompts();
  }
  onProgress(0.98, "Packing atlas");
  return {
    name: plan.name,
    atlas: chosen.candidate.atlas,
    textures: chosen.candidate.textures,
    ...(skeleton ? { skeleton } : {}),
  };

  /**
   * The tweak step on the chosen version:
   * 1. Measure each part's fix in code, comparing the original and the untweaked remix drawn in
   *    the same pose (measureFixes), and scale shrunk parts back up.
   * 2. Spark approves, drops or adjusts the fixes and may nudge other parts, in one call.
   * 3. Damage check in code: a tweak that pulls a part away from a neighbour it touched is undone.
   * Stores the tweaked skeleton and returns its key, or null when nothing was changed.
   */
  async function tweakParts(candidate: Candidate, log: TweakLog): Promise<string | null> {
    const startSkeleton = skeletonFor(candidate);
    const baseJson: unknown = JSON.parse(startSkeleton.toString());
    const posed = loadRig(startSkeleton, false, atlasText);
    log.crops = candidate.crops;
    if (!posed) return null;
    const originalPages = pages.map((p, i) => ({ name: p.name, image: images[i] }));
    const remixPages = pages.map((p, i) => ({ name: p.name, image: candidate.images[i] }));
    const [original, remix] = await Promise.all([
      drawRig(posed, originalPages, background.hex, { measure: true }),
      drawRig(posed, remixPages, background.hex, { measure: true }),
    ]);
    if (!original || !remix) return null;
    const draw = (tweaks: Record<string, PartTransform>, options: Parameters<typeof drawRig>[3]) => {
      const { skeleton, skipped } = applyTweaks(baseJson, tweaks, posed, remix.rigSize);
      const rig = loadRig(JSON.stringify(skeleton), false, atlasText);
      return { json: JSON.stringify(skeleton), skipped, drawing: rig ? drawRig(rig, remixPages, background.hex, options) : Promise.resolve(null) };
    };

    // 1. Measure.
    const regionOf = new Map(remix.parts.map((p) => [p.slot, p.region]));
    const shrunkBy = new Map(candidate.shrunk.map((s) => [s.part, s.scale]));
    const shrunkSlots = new Map([...regionOf].flatMap(([slot, region]) => (shrunkBy.has(region) ? [[slot, shrunkBy.get(region) ?? 1] as const] : [])));
    const measured = measureFixes(original, remix, shrunkSlots);
    log.measured = Object.fromEntries(measured);
    const fixes: Record<string, PartTransform> = Object.fromEntries([...measured].flatMap(([slot, m]) => (m.fix ? [[slot, m.fix]] : [])));

    // 2. Spark approves.
    const ids = new Map([...measured.keys()].map((slot, i) => [slot, i + 1]));
    const highlight = new Set(Object.keys(fixes));
    const [originalTagged, remixTagged, fixedTagged] = await Promise.all([
      drawRig(posed, originalPages, background.hex, { tags: ids, highlight }),
      drawRig(posed, remixPages, background.hex, { tags: ids, highlight }),
      draw(fixes, { tags: ids, highlight }).drawing,
    ]);
    if (!originalTagged || !remixTagged || !fixedTagged) return null;
    await Promise.all([
      putFile(folder, "tweak-original.png", originalTagged.png),
      putFile(folder, "tweak-remix.png", remixTagged.png),
      putFile(folder, "tweak-measured.png", fixedTagged.png),
    ]);
    const parts: TweakPart[] = [...ids].map(([slot, id]) => ({
      id,
      slot,
      region: regionOf.get(slot) ?? slot,
      status: measured.get(slot)?.status ?? "unmeasured",
      fix: measured.get(slot)?.fix ?? null,
    }));
    const fixCount = Object.keys(fixes).length;
    const review = await withProgress(
      onProgress,
      0.95,
      0.98,
      fixCount > 0 ? `Tweaking the parts (${fixCount} measured ${fixCount === 1 ? "fix" : "fixes"} to check)` : "Checking how the parts fit",
      TWEAK_EXPECTED_MS,
      async () =>
        reviewTweaks(
          parts,
          {
            original: await toDataUrl(originalTagged.png, PLAN_MAX_SIDE),
            remix: await toDataUrl(remixTagged.png, PLAN_MAX_SIDE),
            fixed: await toDataUrl(fixedTagged.png, PLAN_MAX_SIDE),
          },
          signal,
        ),
    );
    log.review = review;
    // An unusable review falls back to the measured fixes; the damage check still guards them.
    const tweaks: Record<string, PartTransform> = review
      ? Object.fromEntries(review.changes.map((c) => [c.slot, { x: c.x, y: c.y, scale: c.scale, rotate: c.rotate }]))
      : { ...fixes };

    // 3. Damage check.
    const tweaked = draw(tweaks, { measure: true });
    const after = await tweaked.drawing;
    if (after) {
      const lost = lostContacts(remix, after, Object.keys(tweaks));
      for (const [slot, neighbours] of lost) {
        log.reverted[slot] = neighbours;
        // A shrunk part keeps its scale-up, so it isn't left smaller than it was painted; only the
        // move on top of the measured fix is undone.
        const fix = measured.get(slot);
        if (fix?.status === "shrunk" && fix.fix) tweaks[slot] = fix.fix;
        else delete tweaks[slot];
      }
    }
    log.tweaks = tweaks;
    await writePrompts();
    const changed = Object.values(tweaks).some((t) => t.x !== 0 || t.y !== 0 || t.scale !== 1 || t.rotate !== 0);
    if (!changed) return null;
    const final = Object.keys(log.reverted).length > 0 ? draw(tweaks, {}) : tweaked;
    log.skipped = final.skipped;
    const drawing = await final.drawing;
    if (drawing) await putFile(folder, "tweak-final.png", drawing.png);
    await writePrompts();
    return putFile(folder, "skeleton.json", final.json);
  }
}

/**
 * Ranks painted versions: one that passed the style check and was rig-checked beats one that
 * failed on style, whatever the scores. A check that couldn't run counts as UNCHECKED_SCORE.
 */
function scoreOf(candidate: Candidate): number {
  const style = candidate.style?.score ?? UNCHECKED_SCORE;
  if (candidate.style && !candidate.style.pass) return style / 2;
  return 0.5 + (style + (candidate.rig?.score ?? UNCHECKED_SCORE)) / 4;
}

/**
 * The rig check with the problems code can measure added as issues, so they go to a part fix even
 * when Spark misses them: parts that had to shrink below MIN_PART_SCALE (drawn far too big), and
 * parts still cut off by a mesh that couldn't be boxed (crop.ts). Null when there was no check and
 * nothing was found.
 */
function withPartProblems(candidate: Candidate, rig: Inspection | null): Inspection | null {
  const oversized = candidate.shrunk.filter((s) => s.scale < MIN_PART_SCALE);
  const issues: InspectionIssue[] = [
    ...oversized.map((s) => ({
      part: s.part,
      problem: `Painted about ${Math.round(1 / s.scale)}× too big for its slot, so it had to shrink to ${Math.round(s.scale * 100)}%.`,
      fix: "Draw this piece at the size of the original part, filling its box without spilling out of it.",
    })),
    ...candidate.crops
      .filter((c) => !oversized.some((s) => s.part === c.region))
      .map((c) => ({
        part: c.region,
        problem: `${Math.round(c.share * 100)}% of it is cut off in the game: it spills past the outline the game draws it inside.`,
        fix: "Draw this piece no bigger than the original part, inside its outline, so none of it is cut off.",
      })),
  ];
  if (issues.length === 0) return rig;
  const known = new Set(issues.map((i) => i.part));
  return {
    pass: false,
    score: Math.min(rig?.score ?? 1, 0.5),
    summary: rig?.summary ?? `${[...known].join(", ")} ${oversized.length > 0 ? "drawn too big or cut off" : "cut off"}.`,
    issues: [...issues, ...(rig?.issues.filter((i) => !i.part || !known.has(i.part)) ?? [])],
  };
}

/** Whether a failed rig check's problems sit in a few named parts, so part fixes can solve them. */
function isLocal(rig: Inspection): boolean {
  const pinned = rig.issues.filter((i) => i.part);
  const regions = new Set(pinned.map((i) => i.part));
  return pinned.length > 0 && regions.size <= MAX_FIX_PARTS && pinned.length >= rig.issues.length / 2;
}

/** The inspectors' fixes as an instruction for the next repaint, kept short so the look still leads the prompt. */
function feedbackNote(issues: InspectionIssue[]): string {
  if (issues.length === 0) return "";
  let note = "A previous attempt was rejected. Fix these:";
  for (const issue of issues) {
    const line = ` ${issue.part ? `${issue.part}: ` : ""}${issue.fix.replace(/[.\s]+$/, "")}.`;
    if (note.length + line.length > MAX_FEEDBACK_CHARS) break;
    note += line;
  }
  return note;
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
