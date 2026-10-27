// Mirrors the remix shapes in frontend/app/lib/types.ts. Keep the two in sync.

export const ART_STYLES = ["cartoon", "anime", "pixel", "painterly", "flat"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

export type RemixStatus = "queued" | "running" | "succeeded" | "failed";

export interface RemixInput {
  baseAssetId: string;
  /** Describes the new look, e.g. "black and crimson ninja robes". */
  prompt: string;
  style: ArtStyle;
  /** 0–1. Low keeps close to the original texture, high reinterprets it freely. */
  strength: number;
  /** Keep the original palette and only change details. */
  keepPalette: boolean;
}

/** The base rig's files the remix repaints. Sent by the frontend with the input. */
export interface RemixBase {
  name: string;
  /** Path of the base .atlas on ASSET_BASE_URL, e.g. "/spine/spineboy/Spineboy.atlas". */
  atlasUrl: string;
  premultipliedAlpha: boolean;
}

export interface RemixRequest extends RemixInput {
  base: RemixBase;
}

/** The new atlas and its repainted page images. Page names match the base atlas. */
export interface RemixResult {
  /** Short name for the remix, suggested by Muse. */
  name: string;
  atlasUrl: string;
  textureUrls: string[];
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
  result: RemixResult | null;
  error: string | null;
}
