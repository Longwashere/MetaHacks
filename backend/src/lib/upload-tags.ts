import sharp from "sharp";
import { aiFetch } from "./ai-fetch.js";
import { META_API_BASE_URL, MUSE_MODEL } from "./config.js";
import { check, db } from "./db.js";
import { apiKey, getPath, logPrompt } from "./meta.js";

// Admin uploads: after the rigs are stored, Muse Spark looks at each rig's atlas pages and
// writes search tags for it (#orc, #shield, #undead…), reusing the catalogue's existing tags
// where they fit. Rig features the pictures can't show (ik, mesh, physics…) are read from the
// skeleton in code. It runs in the background so a big batch isn't held up by model calls; the
// tags appear on the assets a little later. A failed call only leaves that rig without tags, so
// the upload itself never fails here.

export interface TagRig {
  assetId: string;
  name: string;
  category: string;
  style: string;
  skeleton: Record<string, unknown>;
  animations: string[];
  pages: Buffer[];
}

/**
 * Muse calls in flight across all uploads. The upload page sends a 50-rig batch as many small
 * requests, so one shared queue keeps them from stacking up.
 */
const CONCURRENCY = 4;
/** A short structured reply; Spark otherwise reasons for a minute or more (see FRICTION_LOG). */
const REASONING_EFFORT = "low";
const TIMEOUT_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 5_000;
/** Pages sent per rig, and their longest side: enough to recognise the character. */
const MAX_PAGES = 2;
const PAGE_SIDE = 768;
const MAX_BONE_NAMES = 80;
const MAX_MUSE_TAGS = 8;
const MAX_TAG_LENGTH = 24;
/** Existing tags shown to Muse, most used first. */
const MAX_VOCABULARY = 250;
const VOCABULARY_TTL_MS = 10 * 60 * 1000;
/** Tags that describe how an asset was made, not what it is; Muse shouldn't reuse them. */
const RESERVED_TAGS = new Set(["remix", "ik", "mesh", "physics", "skins", "path"]);

const SYSTEM_PROMPT = `You tag 2D game assets for a searchable catalogue. You are given the atlas pages of one rigged Spine asset: each page is a sprite sheet of its separate parts (head, limbs, weapons, effects…) cut apart and packed on a plain white background. You also get its name, category, art style, bone names, animation names, and the tags the catalogue already uses.
Write the tags someone would search for to find this asset:
- what it is (orc, skeleton, slime, gargoyle, treasure chest);
- notable gear or features (shield, wings, horns, lance);
- theme or setting (fantasy, dungeon, undead, sci-fi, forest);
- one game role when it's clear (hero, enemy, boss, npc, melee, ranged, mount, pickup, hud).
Rules:
- 4 to 8 tags, most useful first.
- Reuse an existing tag whenever one fits, spelt exactly as listed (e.g. "skeleton", not "skeletal"). Add a new tag only for something no existing tag covers.
- Lower case, 1 or 2 words each, no # and no punctuation except a hyphen.
- Only what you can see in the pages or is clear from the names. Don't repeat the category or the art style.
Reply with JSON only: {"tags": ["...", "..."]}`;

const queue: TagRig[] = [];
let active = 0;
let vocabulary: { tags: string[]; loadedAt: number } | null = null;

/** Queues rigs for tagging. Returns at once; never throws. */
export function tagUploads(rigs: TagRig[]): void {
  // Only the pages Muse will see stay in memory while a rig waits.
  queue.push(...rigs.map((rig) => ({ ...rig, pages: rig.pages.slice(0, MAX_PAGES) })));
  while (active < CONCURRENCY && queue.length > 0) {
    active++;
    void drain().finally(() => active--);
  }
}

async function drain(): Promise<void> {
  for (let rig = queue.shift(); rig; rig = queue.shift()) {
    try {
      const tags = [...new Set([...(await suggestTagsWithRetry(rig)), ...rigFeatureTags(rig.skeleton)])];
      if (tags.length === 0) continue;
      check(await db().from("assets").update({ tags }).eq("id", rig.assetId));
      // Later rigs in the same batch reuse what this one added.
      if (vocabulary) vocabulary.tags = [...new Set([...vocabulary.tags, ...tags])];
      console.log(`[upload-tags] ${rig.assetId}: ${tags.join(", ")}`);
    } catch (error) {
      console.error(`[upload-tags] ${rig.assetId} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

/**
 * In a 62-rig batch about 1 in 8 calls failed and the same rig tagged fine on a retry, so try
 * twice. If Muse still fails the rig keeps its skeleton tags.
 */
async function suggestTagsWithRetry(rig: TagRig): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await suggestTags(rig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2) {
        console.error(`[upload-tags] ${rig.assetId} Muse failed twice, keeping skeleton tags only:`, message);
        return [];
      }
      console.warn(`[upload-tags] ${rig.assetId} Muse failed, retrying:`, message);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function suggestTags(rig: TagRig): Promise<string[]> {
  const [pageImages, existing] = await Promise.all([Promise.all(rig.pages.map(toPageDataUrl)), existingTags()]);
  const request = [
    `Name: ${rig.name}`,
    `Category: ${rig.category}`,
    `Art style: ${rig.style}`,
    `Bones: ${boneNames(rig.skeleton).join(", ") || "(none)"}`,
    `Animations: ${rig.animations.join(", ") || "(none)"}`,
    `Existing tags: ${existing.join(", ") || "(none yet)"}`,
  ].join("\n");
  logPrompt(`chat/completions (${MUSE_MODEL}) upload tags + ${pageImages.length} page image(s)`, request);

  const res = await aiFetch(`${META_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MUSE_MODEL,
      reasoning_effort: REASONING_EFFORT,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "text", text: request }, ...pageImages.map((url) => ({ type: "image_url", image_url: { url } }))],
        },
      ],
    }),
    timeoutMs: TIMEOUT_MS,
    signal: AbortSignal.timeout(TIMEOUT_MS + 10_000),
  });
  if (!res.ok) throw new Error(`Muse request failed (${res.status}) with ${MUSE_MODEL}: ${(await res.text()).slice(0, 300)}`);
  return parseTags(getPath(await res.json(), ["choices", 0, "message", "content"]), [rig.category, rig.style]);
}

/** The catalogue's tags, most used first; cached for a few minutes. */
async function existingTags(): Promise<string[]> {
  if (vocabulary && Date.now() - vocabulary.loadedAt < VOCABULARY_TTL_MS) return vocabulary.tags;
  const rows = check(await db().from("assets").select("tags").overrideTypes<{ tags: string[] }[], { merge: false }>()) ?? [];
  const counts = new Map<string, number>();
  for (const tag of rows.flatMap((row) => row.tags)) {
    if (!RESERVED_TAGS.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_VOCABULARY).map(([tag]) => tag);
  vocabulary = { tags, loadedAt: Date.now() };
  return tags;
}

/** Muse's reply is untrusted: keep only short, plain, distinct tags. */
function parseTags(content: unknown, exclude: string[]): string[] {
  if (typeof content !== "string") return [];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = getPath(JSON.parse(content.slice(start, end + 1)), ["tags"]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const tags = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, " ").trim();
    if (tag && tag.length <= MAX_TAG_LENGTH && !exclude.includes(tag) && !RESERVED_TAGS.has(tag)) tags.add(tag);
    if (tags.size === MAX_MUSE_TAGS) break;
  }
  return [...tags];
}

/** Rig features read from the skeleton JSON, using the catalogue's existing tag names. */
function rigFeatureTags(skeleton: Record<string, unknown>): string[] {
  const nonEmpty = (key: string) => Array.isArray(skeleton[key]) && (skeleton[key] as unknown[]).length > 0;
  const skins = Array.isArray(skeleton.skins) ? (skeleton.skins as unknown[]) : [];
  const hasMesh = skins.some((skin) =>
    Object.values(objectAt(skin, "attachments")).some((slot) =>
      Object.values(objectAt(slot)).some((attachment) => {
        const type = getPath(attachment, ["type"]);
        return type === "mesh" || type === "linkedmesh";
      }),
    ),
  );
  return [
    nonEmpty("ik") && "ik",
    hasMesh && "mesh",
    nonEmpty("physics") && "physics",
    nonEmpty("path") && "path",
    skins.length > 1 && "skins",
  ].filter((tag): tag is string => typeof tag === "string");
}

function objectAt(value: unknown, key?: string): Record<string, unknown> {
  const inner = key === undefined ? value : getPath(value, [key]);
  return typeof inner === "object" && inner !== null && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
}

function boneNames(skeleton: Record<string, unknown>): string[] {
  const bones = skeleton.bones;
  if (!Array.isArray(bones)) return [];
  return bones
    .map((bone) => getPath(bone, ["name"]))
    .filter((name): name is string => typeof name === "string")
    .slice(0, MAX_BONE_NAMES);
}

/** Transparent areas would read as black; put the parts on white, at a size the model reads well. */
async function toPageDataUrl(page: Buffer): Promise<string> {
  const png = await sharp(page, { limitInputPixels: 50_000_000 })
    .resize({ width: PAGE_SIDE, height: PAGE_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
