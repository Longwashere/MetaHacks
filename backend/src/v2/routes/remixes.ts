import { Router } from "express";
import { createRemixJob, getRemixJob } from "../lib/jobs.js";
import { REMIX_STYLES, type RemixBase, type RemixRequest, type RemixStyle } from "../lib/types.js";

type FieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength", string>>;

// Remix API v2. Started as a copy of v1 (src/routes/remixes.ts + src/lib/); change it freely.
export const remixesV2Router = Router();

/** POST /v2/remixes  body = RemixInput & { base: RemixBase } → 202 with a queued RemixJob, or 400 { errors }. */
remixesV2Router.post("/", (req, res) => {
  const parsed = parseRemixInput(req.body);
  if ("errors" in parsed) {
    res.status(400).json({ errors: parsed.errors });
    return;
  }
  res.status(202).json(createRemixJob(parsed.input));
});

/** GET /v2/remixes/:id → RemixJob, or 404. */
remixesV2Router.get("/:id", (req, res) => {
  const job = getRemixJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Remix job not found." });
    return;
  }
  res.json(job);
});

// Same rules as the action in frontend/app/routes/remix.tsx, except strength is already 0–1.
function parseRemixInput(body: unknown): { input: RemixRequest } | { errors: FieldErrors } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errors: FieldErrors = {};

  const baseAssetId = typeof b.baseAssetId === "string" ? b.baseAssetId.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const { style, strength, keepPalette, keepPosition, keepSize, keepOutline } = b;

  const base = parseBase(b.base);

  if (!baseAssetId) errors.base = "Choose a rig to remix.";
  else if (!base) errors.base = "This rig has no textures to remix.";
  if (prompt.length < 5) errors.prompt = "Describe the new look in at least 5 characters.";
  else if (prompt.length > 500) errors.prompt = "Keep it under 500 characters.";
  if (!isStyle(style)) errors.style = "Choose a style.";
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
    errors.strength = "Strength must be between 0 and 1.";
  }

  if (Object.keys(errors).length > 0 || !base || !isStyle(style) || typeof strength !== "number") return { errors };
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
      base,
    },
  };
}

/** The base rig's files. `atlasUrl` must be a plain path; it's fetched from ASSET_BASE_URL. */
function parseBase(value: unknown): RemixBase | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, atlasUrl, premultipliedAlpha } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.length > 200) return null;
  if (typeof atlasUrl !== "string" || !/^\/[\w\-./]+\.atlas$/.test(atlasUrl) || atlasUrl.includes("..") || atlasUrl.startsWith("//")) return null;
  if (typeof premultipliedAlpha !== "boolean") return null;
  return { name: name.trim(), atlasUrl, premultipliedAlpha };
}

function isStyle(value: unknown): value is RemixStyle {
  return typeof value === "string" && (REMIX_STYLES as readonly string[]).includes(value);
}
