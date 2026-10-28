// Domain types shared by the server data layer and the UI.
// These are the shapes the real backend should return — see BACKEND.md.

export const ASSET_CATEGORIES = [
  "character",
  "creature",
  "effect",
  "prop",
  "ui",
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

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
/** Which backend remix pipeline runs the job. v2 is the default; v1 is kept for comparison. */
export const REMIX_API_VERSIONS = ["v2", "v1"] as const;
export type RemixApiVersion = (typeof REMIX_API_VERSIONS)[number];

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
  asset: SpineAsset | null;
  error: string | null;
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
  /** The updated remix once the fix succeeds. */
  asset: SpineAsset | null;
  error: string | null;
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
