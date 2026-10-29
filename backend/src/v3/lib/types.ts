// Mirrors the remix shapes in frontend/app/lib/types.ts. Keep the two in sync.

export const ART_STYLES = ["cartoon", "anime", "pixel", "painterly", "flat"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

/** Remix styles: "auto" lets the prompt pick the style, or keeps the base rig's when it doesn't. */
export const REMIX_STYLES = ["auto", ...ART_STYLES] as const;
export type RemixStyle = (typeof REMIX_STYLES)[number];

export type RemixStatus = "queued" | "running" | "succeeded" | "failed";

export type PromptStatus = "original" | "rewording" | "reworded";

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
  visibility: "public" | "private";
  /** Storage key of the user's uploaded reference image (see storage.ts), or null. Muse Spark matches its look. */
  referenceImage: string | null;
}

/** The base rig's files the remix repaints, looked up by the backend from `baseAssetId`. */
export interface RemixBase {
  name: string;
  /** URL of the base .atlas, built by the backend from the asset's storage key. Pages sit next to it. */
  atlasUrl: string;
  /** URL of the base skeleton (.json or binary .skel), for drawing the assembled character. */
  skeletonUrl: string;
  premultipliedAlpha: boolean;
}

export interface RemixRequest extends RemixInput {
  base: RemixBase;
  /** Public URL of `referenceImage`, built by the backend. */
  referenceUrl?: string | null;
}

/** The new atlas and its repainted page images. Page names match the base atlas. */
export interface RemixResult {
  /** Short name for the remix, suggested by Muse. */
  name: string;
  /** Storage keys of the new .atlas and its pages (see storage.ts). */
  atlas: string;
  textures: string[];
  /** Storage key of the tweaked skeleton JSON, when the tweak step changed any part; else the base rig's is kept. */
  skeleton?: string;
}

export interface RemixJob {
  id: string;
  status: RemixStatus;
  /** 0–1 */
  progress: number;
  /** Human-readable step, e.g. "Painting new textures". */
  stage: string;
  input: RemixRequest;
  createdAt: string; // ISO 8601
  /** Muse's expanded prompt for the image model; null until the look is planned. */
  editPrompt: string | null;
  /**
   * "rewording" while Muse re-words `editPrompt` after the image model's content policy
   * rejected it, "reworded" once the new prompt is in use.
   */
  promptStatus: PromptStatus;
  result: RemixResult | null;
  error: string | null;
}
