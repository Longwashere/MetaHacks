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
}

export interface RemixJob {
  id: string;
  status: RemixStatus;
  /** 0–1 */
  progress: number;
  /** Human-readable step, e.g. "Painting textures". */
  stage: string;
  input: RemixInput;
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

/** The fields a preview needs to render an asset. */
export type PreviewableAsset = Pick<SpineAsset, "category" | "accent" | "animations" | "files" | "tint">;

export interface AssetQuery {
  q?: string;
  category?: AssetCategory;
  sort?: SortOption;
}
