import { REMIX_STYLES, type RemixInput, type RemixStyle } from "./types.js";

// Request body checks shared by the routes. Bodies are untrusted.

export type RemixFieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength" | "apiVersion", string>>;

/** Same rules as the action in frontend/app/routes/remix.tsx, except strength is already 0–1. */
export function parseRemixInput(body: unknown): { input: RemixInput } | { errors: RemixFieldErrors } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errors: RemixFieldErrors = {};

  const baseAssetId = typeof b.baseAssetId === "string" ? b.baseAssetId.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const { style, strength, keepPalette, keepPosition, keepSize, keepOutline, visibility } = b;

  if (!baseAssetId || baseAssetId.length > 200) errors.base = "Choose a rig to remix.";
  if (prompt.length < 5) errors.prompt = "Describe the new look in at least 5 characters.";
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
      // Private unless the user chose public.
      visibility: visibility === "public" ? "public" : "private",
    },
  };
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
