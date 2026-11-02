// Domain types shared by the server data layer and the UI.
// These are the shapes the real backend should return — see BACKEND.md.

/** Built-in categories, always listed. Admin uploads can add more (GET /assets/categories lists them). */
export const ASSET_CATEGORIES = [
  "character",
  "creature",
  "effect",
  "prop",
  "ui",
] as const;
/** A built-in category or one Muse added: a lowercase slug like "vehicle". */
export type AssetCategory = string;

/** Same pattern as the backend and the database's assets_category_check. */
export const isCategorySlug = (v: string | null | undefined): v is AssetCategory =>
  typeof v === "string" && /^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$/.test(v);

export const ART_STYLES = [
  "cartoon",
  "anime",
  "pixel",
  "painterly",
  "flat",
] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

/** Remix styles: "auto" lets the prompt pick the style, or keeps the base rig's when it doesn't. */
export const REMIX_STYLES = ["auto", ...ART_STYLES] as const;
export type RemixStyle = (typeof REMIX_STYLES)[number];

export const SORT_OPTIONS = ["popular", "newest", "name"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/** View modes for previewing Spine assets: full textured skin, rig skeleton only, or overlay. */
export type SpineViewMode = "skin" | "skeleton" | "overlay";

/** Theme token used to tint the asset's preview. Maps to --chart-N in app.css. */
export type AssetAccent = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

export interface SpineAnimation {
  name: string;
  durationSec: number;
  loop: boolean;
}

export interface SpineAssetFiles {
  /** Skeleton data (.json or binary .skel). */
  skeletonUrl: string;
  /** Texture atlas (.atlas). Page images are resolved relative to it. */
  atlasUrl: string;
  /** Atlas page images (.png). */
  textureUrls: string[];
  /** Whether the atlas uses premultiplied alpha (Spine's "pma" export). */
  premultipliedAlpha: boolean;
  /** Skin to show; required for rigs whose default skin is empty. */
  skin: string | null;
}

export interface SpineAsset {
  id: string;
  name: string;
  description: string;
  category: AssetCategory;
  style: ArtStyle;
  tags: string[];
  /** Texture prompt for remixes; null for original rigs. */
  prompt: string | null;
  /** The rig this asset was re-textured from. Null for original rigs. */
  remixOf: { id: string; name: string } | null;
  /** The remix this asset is a free copy of (same files, new owner). Null unless it's a copy. */
  copyOf: { id: string; name: string } | null;
  /** The rig an upload shares its art or its skeleton with (a re-rig, re-skin or new animations). */
  basedOn: { id: string; name: string } | null;
  /** Only public assets appear in Explore, the sitemap, and search engines. */
  visibility: "public" | "private";
  author: { id: string; name: string };
  createdAt: string; // ISO 8601
  spineVersion: string;
  boneCount: number;
  slotCount: number;
  animations: SpineAnimation[];
  accent: AssetAccent;
  downloads: number;
  saves: number;
  /** Optional rendered thumbnail. */
  thumbnailUrl: string | null;
  /** Exported Spine files. Null when none exist yet (the UI draws a placeholder rig). */
  files: SpineAssetFiles | null;
  /**
   * MOCK ONLY: hex color multiplied over the base rig's textures to fake a
   * re-textured remix. Real remixes ship their own textures — drop this field then.
   */
  tint: string | null;
}

export type RemixStatus = "queued" | "running" | "succeeded" | "failed";

export type PromptStatus = "original" | "rewording" | "reworded";

/**
 * A remix keeps the base rig's skeleton, bones, slots and animations and only
 * regenerates the texture (atlas pages) from a prompt.
 */
/** Which backend remix pipeline runs the job. v2 is the default; v3 loops paint and inspection until its checks pass; v1 is kept for comparison. */
export const REMIX_API_VERSIONS = ["v2", "v3", "v1"] as const;
export type RemixApiVersion = (typeof REMIX_API_VERSIONS)[number];

/** What remixes and part fixes cost from the monthly credits (Account.credits). */
export interface CreditRules {
  /** Credits per atlas page a remix repaints, by API version. */
  perPage: Record<RemixApiVersion, number>;
  partFix: number;
  /** Generated animations and edits are metered: their Muse cost over `creditUsd`, rounded up, at least `min`. */
  animation: { creditUsd: number; min: number };
  /** Each plan's credits per month. */
  monthly: { free: number; pro: number };
}

/** One remix, part fix or animation job this month and what it cost (GET /me/credits). */
export interface CreditHistoryEntry {
  jobId: string;
  createdAt: string;
  kind: "remix" | "part-fix" | "animation" | "animation-edit";
  /** Null for animation jobs. */
  apiVersion: RemixApiVersion | null;
  status: "queued" | "running" | "succeeded" | "failed";
  /** The rig remixed, or the remix whose parts were fixed; null once deleted. */
  rigName: string | null;
  /** The remix it made or fixed; null until saved, or if it failed or was deleted. */
  assetId: string | null;
  /** Atlas pages repainted; null for part fixes and animation jobs. */
  pages: number | null;
  /** The animation an animation job made or edited; null for remixes and part fixes. */
  animation: string | null;
  /** What it costs; failed jobs are refunded. */
  credits: number;
}

/** Credits a remix of `asset` costs with `apiVersion`: per page, at least one page. */
export function remixCredits(rules: CreditRules, apiVersion: RemixApiVersion, asset: Pick<SpineAsset, "files">): number {
  return rules.perPage[apiVersion] * Math.max(asset.files?.textureUrls.length ?? 1, 1);
}

export interface RemixInput {
  baseAssetId: string;
  /** Describes the new look, e.g. "black and crimson ninja robes". */
  prompt: string;
  style: RemixStyle;
  /** 0–1. Low keeps close to the original texture, high reinterprets it freely. */
  strength: number;
  /** Keep the original palette and only change details. */
  keepPalette: boolean;
  /** Ask the models to keep each part's exact position, size and outline in the atlas. */
  keepPosition: boolean;
  keepSize: boolean;
  keepOutline: boolean;
  /** Who can see the finished remix. Public remixes appear in Explore and anyone can remix them. */
  visibility: SpineAsset["visibility"];
  /** Storage key of the reference image the user uploaded, or null. */
  referenceImage: string | null;
}

export interface RemixJob {
  id: string;
  status: RemixStatus;
  /** 0–1 */
  progress: number;
  /** Human-readable step, e.g. "Painting textures". */
  stage: string;
  input: RemixInput;
  apiVersion: RemixApiVersion;
  /** Summary of the base rig so the progress UI can render without another fetch. */
  base: PreviewableAsset & Pick<SpineAsset, "id" | "name">;
  createdAt: string;
  /** Muse's expanded prompt for the image model; null until the look is planned. */
  editPrompt: string | null;
  /**
   * "rewording" while Muse re-words `editPrompt` after the image model's content policy
   * rejected it, "reworded" once the new prompt is in use.
   */
  promptStatus: PromptStatus;
  /** URL of the user's reference image, or null. */
  referenceUrl: string | null;
  /** What a running v2 or v3 remix is painting (and, in v3, checking), for the live view; null otherwise. */
  live: RemixLive | null;
  asset: SpineAsset | null;
  error: string | null;
}

/** What the remix is working on right now. */
export interface RemixActivity {
  kind: "reading" | "reference" | "planning" | "painting" | "checking-style" | "checking-rig" | "fixing" | "revising" | "tweaking" | "packing";
  /** Paint round, from 1; 0 outside the paint loop. */
  round: number;
  /** Atlas page being painted. */
  page?: string;
  /** Atlas regions being repainted by a part fix. */
  regions?: string[];
}

/**
 * The version the live view draws. Every version keeps the base atlas's regions and page names,
 * so the base atlas loads it with these page images swapped in.
 */
export interface RemixPreview {
  round: number;
  /** Page image URL by atlas page name; pages not listed are still the base rig's. */
  pages: Record<string, string>;
  /** Skeleton to draw it with (boxed meshes or tweaks), or null for the base rig's. */
  skeletonUrl: string | null;
}

export interface RemixIssue {
  /** Atlas region the problem is in, or null for the whole character. */
  part: string | null;
  problem: string;
  fix: string;
}

/** Something that happened in a remix, for the live view's timeline. */
/**
 * How the shipped version did against the quality bar: every check passed, a check failed, or a
 * check couldn't run (no drawing of the character, or Spark gave no usable verdict).
 */
export type RemixQuality = "passed" | "below-bar" | "unchecked";

export type RemixEvent = { at: string } & (
  | { type: "planned"; name: string; editPrompt: string; style: string | null; referenceLook: string | null }
  /** `prompt` is the exact text Muse Image got for the kept paint. */
  | { type: "painted"; round: number; page: string; url: string; shrunk: { part: string; scale: number }[]; prompt: string }
  /** Muse Image moved the parts on a page; `url` is its raw output. */
  | { type: "rejected"; round: number; page: string; attempt: number; insideBoxes: number; url: string; prompt: string }
  /** Muse Image declined the edit prompt under its content policy, and Spark re-worded it. */
  | { type: "reworded"; round: number; editPrompt: string }
  | { type: "checked"; round: number; check: "style" | "rig"; pass: boolean; score: number; summary: string; issues: RemixIssue[]; renderUrl: string | null }
  /**
   * `prompt` is the check's request, `plan` Spark's expansion of it (null when unusable or not
   * reached), and `imagePrompts` the text Muse Image got for each page, without retry notes.
   */
  | { type: "fixed"; round: number; regions: string[]; prompt: string; plan: string | null; imagePrompts: string[]; error: string | null }
  /** The plan was rewritten for the next round, or (null) the issues were added to its prompt instead. */
  | { type: "revised"; round: number; editPrompt: string | null }
  /** The version that ships, and whether it cleared the quality bar (see RemixQuality). */
  | { type: "chosen"; round: number; score: number; quality: RemixQuality }
  /** The tweak step moved or scaled this many parts back into place. */
  | { type: "tweaked"; parts: number }
);

export interface RemixLive {
  activity: RemixActivity | null;
  events: RemixEvent[];
  preview: RemixPreview | null;
  /** How many earlier events `events` leaves out: non-zero only in a poll that asked to skip them. */
  eventsFrom: number;
}

/** Where a part fix starts: the original rig's part, or the remix's current one. */
export const PART_FIX_SOURCES = ["original", "remix"] as const;
export type PartFixSource = (typeof PART_FIX_SOURCES)[number];

/** Repaints a few regions of a finished remix, leaving the rest of it as it is. */
export interface PartFixInput {
  /** Atlas region names to repaint. */
  regions: string[];
  prompt: string;
  source: PartFixSource;
}

export interface PartFixJob {
  id: string;
  /** The remix being fixed. */
  assetId: string;
  status: RemixStatus;
  /** 0–1 */
  progress: number;
  stage: string;
  input: PartFixInput;
  createdAt: string;
  /** Muse's expanded prompt for the image model; null until it's planned, or when its reply was unusable. */
  editPrompt: string | null;
  /** The updated remix once the fix succeeds. */
  asset: SpineAsset | null;
  error: string | null;
}

/** One state of a remix's sprite sheet, from GET /me/remixes/:assetId/versions (newest first). */
export interface AssetVersion {
  /** The version's id, or "original" for the remix before its first part fix. */
  id: string;
  kind: "original" | "part_fix";
  /** The fix's prompt. */
  label: string;
  /** Regions a part fix repainted. */
  regions: string[];
  createdAt: string;
  /** True for the version the remix is on now. */
  current: boolean;
}

/** The fields a preview needs to render an asset. */
export type PreviewableAsset = Pick<SpineAsset, "category" | "accent" | "animations" | "files" | "tint">;

export interface AssetQuery {
  q?: string;
  category?: AssetCategory;
  sort?: SortOption;
}

/**
 * How a part's pixels compare with the original's: `measured` has a fix, `aligned` already
 * matches, `reshaped` changed silhouette (so a measurement would undo the new look), and
 * `unmeasured` couldn't be compared (no setup-pose attachment or too few pixels).
 */
export type AutoTweakStatus = "measured" | "aligned" | "reshaped" | "unmeasured";

/** A part transform as Muse sees it: moves are % of the rig's size, +x right and +y up on screen; rotate is degrees counter-clockwise. */
export interface AutoTweakTransform {
  x: number;
  y: number;
  scale: number;
  rotate: number;
}

/** One part sent for review. `id` is the number tagged on the snapshots. */
export interface AutoTweakPart {
  id: number;
  name: string;
  status: AutoTweakStatus;
  measured: AutoTweakTransform | null;
  /** The user's own tweak on this part, or null for none. */
  current: AutoTweakTransform | null;
}

/** Body of POST /me/remixes/:assetId/auto-tweak. Images are JPEG/PNG data URLs, one per pose. */
export interface AutoTweakInput {
  animation: string;
  images: string[];
  parts: AutoTweakPart[];
}

/** Muse's verdict: the final transform for each part it changes. Parts it leaves out stay as they are. */
export interface AutoTweakReview {
  changes: (AutoTweakTransform & { part: string; reason: string })[];
  notes: string;
}

/** Limits of a generated animation's length, in seconds. Same as DURATION_LIMITS in backend/src/lib/animate.ts. */
export const ANIMATE_DURATION = { min: 0.5, max: 8 };

/** Body of POST /me/remixes/:assetId/animations. `skeleton` is the rig as JSON, sent only when the stored file is a binary .skel. */
export interface AnimateInput {
  prompt: string;
  durationSec: number;
  loop: boolean;
  skeleton?: object;
  /** The rig sheet (rest pose with bone names, frames of its own attack) as a JPEG data URL. */
  images?: string[];
}

/** An edit of one of the remix's generated animations: POST /me/remixes/:assetId/animations/:name/edit with AnimateInput & { keepOriginal }. */
export interface AnimateEdit {
  /** The animation to edit. */
  name: string;
  /** Add the edited one beside it instead of replacing it. */
  keepOriginal: boolean;
}

/** A new animation Muse wrote and saved into the remix's skeleton. */
export interface AnimateResult {
  /** The remix with the new skeleton and the animation added to `animations`. */
  asset: SpineAsset;
  animation: SpineAnimation;
  notes: string;
  /** Muse's choreography: the request expanded into timed beats and poses, which the keys follow. */
  plan: string;
  /** Bones Muse keyed that were left out, with the reason. */
  dropped: string[];
  /** For an edit that replaced the original: its name, which the edited animation keeps. */
  replaced?: string;
  /** Credits the job was charged, from Muse's token use. */
  credits: number;
}

// ---------------------------------------------------------------------------
// Auto-rig (/autoRig; backend/src/lib/autorig, AUTO_RIG_PLAN.md)
// ---------------------------------------------------------------------------

/** "front" faces the viewer; "right" is turned toward the right of the image. */
export type AutoRigView = "front" | "right";

/** Joints in cutout pixels. `_l` / `_r` are the character's own sides, so `_r` is on the image's left. */
export const AUTO_RIG_JOINTS = [
  "head",
  "neck",
  "pelvis",
  "shoulder_l",
  "elbow_l",
  "wrist_l",
  "hand_l",
  "shoulder_r",
  "elbow_r",
  "wrist_r",
  "hand_r",
  "hip_l",
  "knee_l",
  "ankle_l",
  "toe_l",
  "hip_r",
  "knee_r",
  "ankle_r",
  "toe_r",
] as const;
export type AutoRigJointName = (typeof AUTO_RIG_JOINTS)[number];
export type AutoRigJoints = Record<AutoRigJointName, { x: number; y: number }>;

/** POST /me/autorig/prepare: the character keyed out of Muse's redraw, with joints guessed from its silhouette. */
export interface PreparedAutoRig {
  /** PNG data URL. */
  cutout: string;
  width: number;
  height: number;
  joints: AutoRigJoints;
  /** Joints Muse Spark couldn't place sensibly (all inner joints if it failed); outlined for the user to check. */
  flagged: AutoRigJointName[];
  /** Who placed the inner joints: Muse Spark, or the outline finder when Spark failed. */
  jointsBy: "spark" | "outline";
  /** False when the upload was rigged as-is. */
  posed: boolean;
}
