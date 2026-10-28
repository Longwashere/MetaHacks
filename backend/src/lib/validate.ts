import { PART_FIX_SOURCES, REMIX_STYLES, type PartFixInput, type RemixInput, type RemixStyle } from "./types.js";

// Request body checks shared by the routes. Bodies are untrusted.

export type RemixFieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength" | "apiVersion" | "referenceImage", string>>;

/** Same rules as the action in frontend/app/routes/remix.tsx, except strength is already 0–1. */
export function parseRemixInput(body: unknown): { input: RemixInput } | { errors: RemixFieldErrors } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errors: RemixFieldErrors = {};

  const baseAssetId = typeof b.baseAssetId === "string" ? b.baseAssetId.trim() : "";
  const typed = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const { style, strength, keepPalette, keepPosition, keepSize, keepOutline } = b;
  const hasReference = b.referenceImage !== undefined && b.referenceImage !== null;
  // With a reference image the prompt is optional: the image says what the look is.
  const prompt = typed || (hasReference ? REFERENCE_ONLY_PROMPT : "");

  if (!baseAssetId || baseAssetId.length > 200) errors.base = "Choose a rig to remix.";
  if (prompt.length < 5) errors.prompt = "Describe the new look in at least 5 characters, or add a reference image.";
  else if (prompt.length > 500) errors.prompt = "Keep it under 500 characters.";
  if (!isStyle(style)) errors.style = "Choose a style.";
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
    errors.strength = "Strength must be between 0 and 1.";
  }

  if (Object.keys(errors).length > 0 || !isStyle(style) || typeof strength !== "number") return { errors };
  return {
    input: {
      baseAssetId,
      prompt,
      style,
      strength,
      keepPalette: keepPalette === true,
      keepPosition: keepPosition === true,
      keepSize: keepSize === true,
      keepOutline: keepOutline === true,
      // Every remix is public for now.
      visibility: "public",
      // Set by startRemix once the upload is stored.
      referenceImage: null,
    },
  };
}

/** The remix prompt when the user gave only a reference image. */
export const REFERENCE_ONLY_PROMPT = "Match the look of the reference image.";

/** Largest reference image accepted, decoded. The page sends a JPEG of at most 1024px. */
export const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

/**
 * The reference image from a remix request body: a base64 JPEG, PNG or WebP data URL. Returns
 * null when there is none, or an error message. The bytes are checked again when decoded.
 */
export function parseReferenceImage(value: unknown): { image: Buffer | null } | { error: string } {
  if (value === undefined || value === null || value === "") return { image: null };
  const match = typeof value === "string" ? /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match) return { error: "The reference must be a JPEG, PNG or WebP image." };
  const image = Buffer.from(match[1], "base64");
  if (image.length === 0) return { error: "The reference image is empty." };
  if (image.length > MAX_REFERENCE_BYTES) return { error: "The reference image is too large. Use one under 4 MB." };
  return { image };
}

/** Most parts a single fix repaints; more is a remix. */
export const MAX_PART_FIX_REGIONS = 20;

/** Same rules as the fix-parts branch of the action in frontend/app/routes/remix.tsx. */
export function parsePartFixInput(body: unknown): { input: PartFixInput } | { error: string } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const regions = Array.isArray(b.regions)
    ? [...new Set(b.regions.filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 200))]
    : [];
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const source = PART_FIX_SOURCES.find((s) => s === b.source) ?? "original";

  if (regions.length === 0) return { error: "Pick at least one part on the sprite sheet." };
  if (regions.length > MAX_PART_FIX_REGIONS) return { error: `Pick at most ${MAX_PART_FIX_REGIONS} parts at a time.` };
  if (prompt.length < 5) return { error: "Describe the fix in at least 5 characters." };
  if (prompt.length > 500) return { error: "Keep it under 500 characters." };
  return { input: { regions, prompt, source } };
}

function isStyle(value: unknown): value is RemixStyle {
  return typeof value === "string" && (REMIX_STYLES as readonly string[]).includes(value);
}

/** Checks the top-level shape the Spine runtime needs; the rest is the runtime's to validate. */
export function parseSkeleton(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const header = s.skeleton;
  if (typeof header !== "object" || header === null) return null;
  if (typeof (header as Record<string, unknown>).spine !== "string") return null;
  if (!Array.isArray(s.bones) || s.bones.length === 0) return null;
  if (s.slots !== undefined && !Array.isArray(s.slots)) return null;
  if (s.skins !== undefined && !Array.isArray(s.skins)) return null;
  return s;
}

/** A positive integer query param, capped at `max`. */
export function parseLimit(value: unknown, fallback: number, max = 200): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
