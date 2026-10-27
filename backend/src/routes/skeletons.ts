import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import { PUBLIC_URL, REMIX_OUTPUT_DIR } from "../lib/config.js";

/** Large rigs export several hundred KB of JSON; leave headroom without accepting anything huge. */
const MAX_SKELETON_BYTES = "8mb";

// Stores a Spine skeleton JSON the user edited on the remix page (tweaks baked in by the
// frontend). The file is served next to the remix atlases from /files/remixes/.
export const skeletonsRouter = Router();

/** POST /skeletons  body = { skeleton: <Spine 4.2 JSON> } → 201 { skeletonUrl }, or 400 { error }. */
skeletonsRouter.post("/", express.json({ limit: MAX_SKELETON_BYTES }), async (req, res) => {
  const skeleton = parseSkeleton(req.body);
  if (!skeleton) {
    res.status(400).json({ error: "Expected { skeleton } with a Spine skeleton JSON." });
    return;
  }

  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_tweak_${randomUUID().slice(0, 8)}`;
  const outDir = path.join(REMIX_OUTPUT_DIR, folder);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "skeleton.json"), JSON.stringify(skeleton));
  res.status(201).json({ skeletonUrl: `${PUBLIC_URL}/files/remixes/${folder}/skeleton.json` });
});

/** Checks the top-level shape the Spine runtime needs; the rest is the runtime's to validate. */
function parseSkeleton(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const { skeleton } = body as Record<string, unknown>;
  if (typeof skeleton !== "object" || skeleton === null || Array.isArray(skeleton)) return null;
  const s = skeleton as Record<string, unknown>;
  const header = s.skeleton;
  if (typeof header !== "object" || header === null) return null;
  if (typeof (header as Record<string, unknown>).spine !== "string") return null;
  if (!Array.isArray(s.bones) || s.bones.length === 0) return null;
  if (s.slots !== undefined && !Array.isArray(s.slots)) return null;
  if (s.skins !== undefined && !Array.isArray(s.skins)) return null;
  return s;
}
