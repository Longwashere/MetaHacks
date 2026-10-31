import sharp from "sharp";
import { aiFetch } from "./ai-fetch.js";
import { META_API_BASE_URL, MUSE_MODEL } from "./config.js";
import { check, db } from "./db.js";
import { apiKey, getPath, logPrompt } from "./meta.js";
import { ART_STYLES, type ArtStyle } from "./types.js";
import { nameSlug, storeRenamedFiles, type RenameFiles } from "./upload-rename.js";

// Uploads: after the rigs are stored, Muse Spark looks at each rig's atlas pages, picks its art
// style, and writes search tags for it (#orc, #shield, #undead…), reusing the catalogue's existing
// tags where they fit. Every upload gets its style this way; only admin uploads keep the tags. Admin
// uploads are also renamed: Muse names the creature, and its files are stored again under that
// name (upload-rename.ts). Rig
// features the pictures can't show (ik, mesh, physics…) are read from the skeleton in code. It
// runs in the background so a big batch isn't held up by model calls; the style and tags appear
// on the assets a little later. A failed call only leaves that rig with the default style and no
// tags, so the upload itself never fails here.

export interface TagRig {
  assetId: string;
  name: string;
  category: string;
  /** Admin uploads only; other rigs just get their style. */
  saveTags: boolean;
  /** Admin uploads only: Muse names the rig, and these files are stored again under that name. */
  rename?: RenameFiles;
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
const MAX_NAME_LENGTH = 40;
/** Existing tags shown to Muse, most used first. */
const MAX_VOCABULARY = 250;
/** Existing asset names shown to Muse when it names a rig, so it doesn't repeat one. */
const MAX_NAMES = 300;
const VOCABULARY_TTL_MS = 10 * 60 * 1000;
/** Tags that describe how an asset was made, not what it is; Muse shouldn't reuse them. */
const RESERVED_TAGS = new Set(["remix", "ik", "mesh", "physics", "skins", "path"]);

const SYSTEM_PROMPT = `You tag 2D game assets for a searchable catalogue. You are given the atlas pages of one rigged Spine asset: each page is a sprite sheet of its separate parts (head, limbs, weapons, effects…) cut apart and packed on a plain white background. You also get its name, category, bone names, animation names, and the tags the catalogue already uses.
Pick its art style, the one of these that best matches how the pages are drawn:
- cartoon: bold dark outlines, bright colours, simple cel shading;
- anime: thin clean outlines, flat cel colours, crisp shading and soft highlights;
- pixel: visible square pixels, limited palette, no anti-aliasing;
- painterly: hand-painted look, brush texture, blended shading, soft or no outlines;
- flat: solid colour shapes, no gradients or texture, minimal outlines.
Then write the tags someone would search for to find this asset:
- what it is (orc, skeleton, slime, gargoyle, treasure chest);
- notable gear or features (shield, wings, horns, lance);
- theme or setting (fantasy, dungeon, undead, sci-fi, forest);
- one game role when it's clear (hero, enemy, boss, npc, melee, ranged, mount, pickup, hud).
Rules:
- 4 to 8 tags, most useful first.
- Reuse an existing tag whenever one fits, spelt exactly as listed (e.g. "skeleton", not "skeletal"). Add a new tag only for something no existing tag covers.
- Lower case, 1 or 2 words each, no # and no punctuation except a hyphen.
- Only what you can see in the pages or is clear from the names. Don't repeat the category or the art style.
Reply with JSON only: {"style": "...", "tags": ["...", "..."]}`;

/** Added for admin uploads, which are renamed. */
const NAME_PROMPT = `
Also give the asset a name for the catalogue, replacing its file-name-like current name:
- for a creature or character, a memorable creature name of 1 to 3 words in Title Case (e.g. "Grimtusk Raider", "Bog Lurker", "Emberwing");
- for a prop, effect or ui piece, a short descriptive title (e.g. "Rune-Locked Chest");
- don't reuse any of the existing names, and leave out the art style and words like rig, sprite, spine or asset.
Reply with JSON only: {"name": "...", "style": "...", "tags": ["...", "..."]}`;

const queue: TagRig[] = [];
let active = 0;
let vocabulary: { tags: string[]; names: string[]; loadedAt: number } | null = null;

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
      const suggestion = await suggestTagsWithRetry(rig);
      const tags = rig.saveTags ? [...new Set([...suggestion.tags, ...rigFeatureTags(rig.skeleton)])] : [];
      const renamed = await renameRig(rig, suggestion.name);
      const update = { ...(suggestion.style && { style: suggestion.style }), ...(tags.length > 0 && { tags }), ...renamed };
      if (Object.keys(update).length === 0) continue;
      check(await db().from("assets").update(update).eq("id", rig.assetId));
      // Later rigs in the same batch reuse what this one added.
      if (vocabulary) {
        vocabulary.tags = [...new Set([...vocabulary.tags, ...tags])];
        if (renamed) vocabulary.names.push(renamed.name);
      }
      const named = renamed ? `"${rig.name}" → "${renamed.name}"; ` : "";
      console.log(`[upload-tags] ${rig.assetId}: ${named}${suggestion.style ?? "(default style)"}; ${tags.join(", ") || "(no tags)"}`);
    } catch (error) {
      console.error(`[upload-tags] ${rig.assetId} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

/**
 * In a 62-rig batch about 1 in 8 calls failed and the same rig tagged fine on a retry, so try
 * twice. If Muse still fails the rig keeps its skeleton tags.
 */
async function suggestTagsWithRetry(rig: TagRig): Promise<Suggestion> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await suggestTags(rig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2) {
        console.error(`[upload-tags] ${rig.assetId} Muse failed twice, keeping the default style and skeleton tags only:`, message);
        return { name: null, style: null, tags: [] };
      }
      console.warn(`[upload-tags] ${rig.assetId} Muse failed, retrying:`, message);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

/** The new name and file keys, or nothing when the rig isn't renamed or storing the files fails (it keeps its name). */
async function renameRig(rig: TagRig, name: string | null) {
  if (!rig.rename || !name || name === rig.name) return undefined;
  try {
    return { name, files: await storeRenamedFiles(name, rig.rename) };
  } catch (error) {
    console.error(`[upload-tags] ${rig.assetId} couldn't be renamed to "${name}":`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

interface Suggestion {
  /** Null when the rig isn't being renamed, or Muse's name isn't usable. */
  name: string | null;
  /** Null when Muse's answer isn't one of the styles. */
  style: ArtStyle | null;
  tags: string[];
}

async function suggestTags(rig: TagRig): Promise<Suggestion> {
  const [pageImages, existing] = await Promise.all([Promise.all(rig.pages.map(toPageDataUrl)), catalogue()]);
  const request = [
    `Name: ${rig.name}`,
    `Category: ${rig.category}`,
    `Bones: ${boneNames(rig.skeleton).join(", ") || "(none)"}`,
    `Animations: ${rig.animations.join(", ") || "(none)"}`,
    `Existing tags: ${existing.tags.join(", ") || "(none yet)"}`,
    ...(rig.rename ? [`Existing names: ${existing.names.slice(-MAX_NAMES).join(", ") || "(none yet)"}`] : []),
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
        { role: "system", content: rig.rename ? SYSTEM_PROMPT + NAME_PROMPT : SYSTEM_PROMPT },
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
  const suggestion = parseSuggestion(getPath(await res.json(), ["choices", 0, "message", "content"]), rig.category);
  return rig.rename ? suggestion : { ...suggestion, name: null };
}

/** The catalogue's tags, most used first, and its asset names; cached for a few minutes. */
async function catalogue(): Promise<{ tags: string[]; names: string[] }> {
  if (vocabulary && Date.now() - vocabulary.loadedAt < VOCABULARY_TTL_MS) return vocabulary;
  const rows =
    check(await db().from("assets").select("tags, name").overrideTypes<{ tags: string[]; name: string }[], { merge: false }>()) ?? [];
  const counts = new Map<string, number>();
  for (const tag of rows.flatMap((row) => row.tags)) {
    if (!RESERVED_TAGS.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_VOCABULARY).map(([tag]) => tag);
  vocabulary = { tags, names: [...new Set(rows.map((row) => row.name))], loadedAt: Date.now() };
  return vocabulary;
}

/** Muse's reply is untrusted: keep a plain short name, a known style and only short, plain, distinct tags. */
function parseSuggestion(content: unknown, category: string): Suggestion {
  const none: Suggestion = { name: null, style: null, tags: [] };
  if (typeof content !== "string") return none;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return none;
  let reply: unknown;
  try {
    reply = JSON.parse(content.slice(start, end + 1));
  } catch {
    return none;
  }
  const rawStyle = getPath(reply, ["style"]);
  const style = ART_STYLES.find((s) => typeof rawStyle === "string" && s === rawStyle.trim().toLowerCase()) ?? null;
  return { name: parseName(getPath(reply, ["name"])), style, tags: parseTags(getPath(reply, ["tags"]), [category, ...(style ? [style] : [])]) };
}

function parseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}"#]/gu, "").trim();
  return name && name.length <= MAX_NAME_LENGTH && nameSlug(name) ? name : null;
}

function parseTags(raw: unknown, exclude: string[]): string[] {
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
