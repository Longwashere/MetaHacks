import { randomUUID } from "node:crypto";
import * as spine from "@esotericsoftware/spine-core";
import { ASSET_CATEGORIES } from "./assets.js";
import { getProfile } from "./billing.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset, type Visibility } from "./db.js";
import { isSafePageName } from "./atlas.js";
import { putFile } from "./storage.js";
import { ART_STYLES, type ArtStyle } from "./types.js";
import { parseSkeleton } from "./validate.js";

// Bulk upload: users add their own Spine rigs (skeleton JSON, .atlas and its page images), one
// folder per rig. The page converts binary .skel files to JSON first, so the backend only reads
// JSON. Each rig is loaded with the Spine runtime against its atlas before anything is stored,
// so a rig that's missing a region or page is rejected with the reason. Uploads are original
// rigs (no remix_of), owned by the uploader, and can be remixed like the official ones.

/** Rigs per upload for everyone but admins. */
export const MAX_RIGS_PER_UPLOAD = 3;
/** Upper bound per request for admins, so one request can't hold the server for long. */
const MAX_RIGS_PER_REQUEST = 50;
const MAX_PAGES = 16;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_ATLAS_CHARS = 1024 * 1024;
const MAX_NAME_LENGTH = 80;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LOOPING = /idle|walk|run|loop|fly|hover|breath|swim|float|wave/i;
const ACCENTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

interface UploadRig {
  name: string;
  skeleton: Record<string, unknown>;
  atlas: string;
  pages: { name: string; data: Buffer }[];
  /** Read by the Spine runtime while validating. */
  meta: {
    spineVersion: string;
    boneCount: number;
    slotCount: number;
    animations: AssetRow["animations"];
    premultipliedAlpha: boolean;
    skin: string | null;
  };
}

export interface UploadInput {
  category: string;
  style: ArtStyle;
  visibility: Visibility;
  rigs: UploadRig[];
}

export type ParseUploadResult =
  | { ok: true; input: UploadInput }
  /** `rigErrors` maps a rig's index in the request to what's wrong with it. */
  | { ok: false; error: string; rigErrors?: Record<number, string> };

export function parseUploadInput(body: unknown, isAdmin: boolean): ParseUploadResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Expected { category, style, visibility, rigs }." };
  const { category, style, visibility, rigs } = body as Record<string, unknown>;
  if (typeof category !== "string" || !(ASSET_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: "Pick a category." };
  }
  if (typeof style !== "string" || !(ART_STYLES as readonly string[]).includes(style)) return { ok: false, error: "Pick an art style." };
  if (visibility !== "public" && visibility !== "private") return { ok: false, error: "Choose public or private." };
  if (!Array.isArray(rigs) || rigs.length === 0) return { ok: false, error: "Add at least one rig folder." };
  const max = isAdmin ? MAX_RIGS_PER_REQUEST : MAX_RIGS_PER_UPLOAD;
  if (rigs.length > max) return { ok: false, error: `You can upload up to ${max} rigs at a time.` };

  const parsed: UploadRig[] = [];
  const rigErrors: Record<number, string> = {};
  rigs.forEach((raw: unknown, i) => {
    const rig = parseRig(raw);
    if (typeof rig === "string") rigErrors[i] = rig;
    else parsed.push(rig);
  });
  if (Object.keys(rigErrors).length > 0) {
    return { ok: false, error: "Some rigs couldn't be read. Nothing was uploaded.", rigErrors };
  }
  return { ok: true, input: { category, style: style as ArtStyle, visibility, rigs: parsed } };
}

/** The rig, or what's wrong with it. */
function parseRig(raw: unknown): UploadRig | string {
  if (typeof raw !== "object" || raw === null) return "Expected { name, skeleton, atlas, pages }.";
  const { name: rawName, skeleton, atlas, pages } = raw as Record<string, unknown>;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME_LENGTH || /\p{Cc}|\p{Cf}/u.test(name)) return `Give the rig a name of 1–${MAX_NAME_LENGTH} characters.`;
  if (!parseSkeleton(skeleton)) return "Missing the skeleton, or it isn't a Spine skeleton JSON.";
  if (typeof atlas !== "string" || !atlas.trim() || atlas.length > MAX_ATLAS_CHARS) return "Missing the .atlas file.";
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) return `Expected 1–${MAX_PAGES} page images.`;

  let textureAtlas: spine.TextureAtlas;
  try {
    textureAtlas = new spine.TextureAtlas(atlas);
  } catch (error) {
    return `The .atlas couldn't be read: ${message(error)}`;
  }
  if (textureAtlas.pages.length === 0) return "The .atlas has no pages.";

  const images = new Map<string, Buffer>();
  for (const page of pages) {
    const { name: pageName, data } = (typeof page === "object" && page !== null ? page : {}) as Record<string, unknown>;
    if (typeof pageName !== "string" || !isSafePageName(pageName) || !pageName.toLowerCase().endsWith(".png")) {
      return "Page images must be PNG files with plain names.";
    }
    if (typeof data !== "string") return `${pageName} is empty.`;
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_PAGE_BYTES) return `${pageName} is over ${MAX_PAGE_BYTES / 1024 / 1024} MB.`;
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return `${pageName} isn't a PNG.`;
    images.set(pageName, bytes);
  }
  const missing = textureAtlas.pages.map((p) => p.name).filter((p) => !images.has(p));
  if (missing.length > 0) return `The .atlas needs ${missing.join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} in the folder.`;

  let data: spine.SkeletonData;
  try {
    data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(textureAtlas)).readSkeletonData(JSON.stringify(skeleton));
  } catch (error) {
    return `The skeleton doesn't load with its atlas: ${message(error)}`;
  }
  const version = data.version ?? "";
  if (!version.startsWith("4.2")) return `Exported with Spine ${version || "an unknown version"}; re-export it for Spine 4.2.`;
  if (data.bones.length === 0) return "The skeleton has no bones.";

  // Rigs whose default skin is empty (every attachment in named skins) show their first named skin.
  const defaultSkin = data.defaultSkin;
  const defaultIsEmpty = !defaultSkin || defaultSkin.attachments.every((slot) => !slot || Object.keys(slot).length === 0);
  const skin = defaultIsEmpty ? (data.skins.find((s) => s.name !== "default")?.name ?? null) : null;

  return {
    name,
    skeleton: skeleton as Record<string, unknown>,
    atlas,
    // Only the pages the atlas uses, in its order.
    pages: textureAtlas.pages.map((p) => ({ name: p.name, data: images.get(p.name)! })),
    meta: {
      spineVersion: "4.2",
      boneCount: data.bones.length,
      slotCount: data.slots.length,
      animations: data.animations.map((a) => ({
        name: a.name,
        durationSec: Math.round(a.duration * 100) / 100,
        loop: LOOPING.test(a.name),
      })),
      premultipliedAlpha: textureAtlas.pages.some((p) => p.pma),
      skin,
    },
  };
}

/** Stores every rig's files, then creates their assets in one insert. */
export async function createUploads(userId: string, input: UploadInput): Promise<SpineAsset[]> {
  const profile = await getProfile(userId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rows = await Promise.all(
    input.rigs.map(async (rig) => {
      const suffix = randomUUID().slice(0, 8);
      const slug = rig.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "rig";
      const folder = `${stamp}_upload_${suffix}`;
      const [skeletonKey, atlasKey, ...textureKeys] = await Promise.all([
        putFile(folder, `${slug}.json`, JSON.stringify(rig.skeleton)),
        putFile(folder, `${slug}.atlas`, rig.atlas),
        ...rig.pages.map((p) => putFile(folder, p.name, p.data)),
      ]);
      return {
        id: `${slug}-${suffix}`,
        owner_id: userId,
        author_id: userId,
        author_name: profile.name || "Anonymous",
        name: rig.name,
        description: `A Spine ${rig.meta.spineVersion} rig uploaded by ${profile.name || "a RigForge user"}.`,
        category: input.category,
        style: input.style,
        tags: [],
        visibility: input.visibility,
        spine_version: rig.meta.spineVersion,
        bone_count: rig.meta.boneCount,
        slot_count: rig.meta.slotCount,
        animations: rig.meta.animations,
        accent: ACCENTS[parseInt(suffix.slice(0, 2), 16) % ACCENTS.length],
        files: {
          skeleton: skeletonKey,
          atlas: atlasKey,
          textures: textureKeys,
          premultipliedAlpha: rig.meta.premultipliedAlpha,
          skin: rig.meta.skin,
        },
      };
    }),
  );
  const inserted = check(await db().from("assets").insert(rows).select(ASSET_COLUMNS).overrideTypes<AssetRow[], { merge: false }>());
  return (inserted ?? []).map(toSpineAsset);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
