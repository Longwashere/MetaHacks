import { randomUUID } from "node:crypto";
import * as spine from "@esotericsoftware/spine-core";
import { ASSET_CATEGORIES } from "./assets.js";
import { getProfile } from "./billing.js";
import { ASSET_COLUMNS, check, db, toSpineAsset, type AssetRow, type SpineAsset, type Visibility } from "./db.js";
import { isSafePageName } from "./atlas.js";
import { fingerprintRig, type RigFingerprint } from "./fingerprint.js";
import { putFile } from "./storage.js";
import { tagUploads } from "./upload-tags.js";
import { ART_STYLES, type ArtStyle } from "./types.js";
import { parseSkeleton } from "./validate.js";

// Bulk upload: users add their own Spine rigs (skeleton JSON, .atlas and its page images), one
// folder per rig. The page converts binary .skel files to JSON first, so the backend only reads
// JSON. Each rig is loaded with the Spine runtime against its atlas before anything is stored,
// so a rig that's missing a region or page is rejected with the reason. Uploads are original
// rigs (no remix_of), owned by the uploader, and can be remixed like the official ones.
//
// Re-uploads: each rig is fingerprinted by its art (page PNGs) and its rig (skeleton), as are
// remixes (lib/fingerprint.ts). A rig whose art and rig both match a public rig or remix, or one
// of the uploader's own, is rejected. New art on an
// existing rig, or new animations on existing art, is new work: it's accepted and credited with
// based_on. A rig reusing someone else's art stays private (publishBlocked), so it's in the
// uploader's workspace but not listed twice in Explore. Admins can publish anything.

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
  fingerprint: RigFingerprint;
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

  // Only the pages the atlas uses, in its order.
  const usedPages = textureAtlas.pages.map((p) => ({ name: p.name, data: images.get(p.name)! }));
  return {
    name,
    skeleton: skeleton as Record<string, unknown>,
    atlas,
    pages: usedPages,
    fingerprint: fingerprintRig(skeleton as Record<string, unknown>, usedPages.map((p) => p.data)),
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

export type CreateUploadsResult =
  /** `notes` maps a rig's index to a remark on how it was stored (e.g. kept private). */
  | { ok: true; assets: SpineAsset[]; notes: Record<number, string> }
  | { ok: false; error: string; rigErrors: Record<number, string> };

/**
 * Checks every rig against the library, stores their files, then creates their assets in one
 * insert. For admin uploads, Muse Spark then writes each asset's tags in the background
 * (lib/upload-tags.ts).
 */
export async function createUploads(userId: string, input: UploadInput, isAdmin = false): Promise<CreateUploadsResult> {
  const matched = await matchExisting(userId, input.rigs, isAdmin);
  if (!matched.ok) return { ok: false, error: "Some rigs are already in the library. Nothing was uploaded.", rigErrors: matched.rigErrors };
  const notes: Record<number, string> = {};
  const profile = await getProfile(userId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rows = await Promise.all(
    input.rigs.map(async (rig, i) => {
      const { basedOn, privateOnly } = matched.matches[i]!;
      if (privateOnly && input.visibility === "public") {
        notes[i] = "Kept private: its art matches a rig already in the library, so it's only in your workspace.";
      }
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
        visibility: privateOnly ? "private" : input.visibility,
        based_on: basedOn?.id ?? null,
        based_on_name: basedOn?.name ?? null,
        art_hash: rig.fingerprint.artHash,
        rig_hash: rig.fingerprint.rigHash,
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
  const res = await db().from("assets").insert(rows).select(ASSET_COLUMNS).overrideTypes<AssetRow[], { merge: false }>();
  // assets_owner_fingerprint: the same rig went in from another request since matchExisting ran.
  if (res.error?.code === "23505") return { ok: false, error: "You just uploaded one of these rigs. Check your library.", rigErrors: {} };
  const inserted = check(res);
  if (isAdmin) {
    tagUploads(
      input.rigs.map((rig, i) => ({
        assetId: rows[i]!.id,
        name: rig.name,
        category: input.category,
        style: input.style,
        skeleton: rig.skeleton,
        animations: rig.meta.animations.map((a) => a.name),
        pages: rig.pages.map((p) => p.data),
      })),
    );
  }
  return { ok: true, assets: (inserted ?? []).map(toSpineAsset), notes };
}

interface FingerprintedRow {
  id: string;
  name: string;
  owner_id: string | null;
  visibility: Visibility;
  art_hash: string;
  rig_hash: string;
}

type MatchResult =
  | { ok: true; matches: { basedOn: { id: string; name: string } | null; privateOnly: boolean }[] }
  | { ok: false; rigErrors: Record<number, string> };

/** Each rig's credit and whether it has to stay private, or why it's a re-upload. */
async function matchExisting(userId: string, rigs: UploadRig[], isAdmin: boolean): Promise<MatchResult> {
  const artHashes = [...new Set(rigs.map((r) => r.fingerprint.artHash))];
  const rigHashes = [...new Set(rigs.map((r) => r.fingerprint.rigHash))];
  // Hashes are hex, so they're safe in the filter string. Oldest first: credit goes to the earliest rig.
  const existing = check(
    await db()
      .from("assets")
      .select("id, name, owner_id, visibility, art_hash, rig_hash")
      .or(`art_hash.in.(${artHashes.join(",")}),rig_hash.in.(${rigHashes.join(",")})`)
      .order("created_at", { ascending: true })
      .overrideTypes<FingerprintedRow[], { merge: false }>(),
  );
  // Someone else's private rig is never named or credited.
  const visible = (row: FingerprintedRow) => row.visibility === "public" || row.owner_id === userId;

  const matches: Extract<MatchResult, { ok: true }>["matches"] = [];
  const rigErrors: Record<number, string> = {};
  rigs.forEach((rig, i) => {
    const { artHash, rigHash } = rig.fingerprint;
    const twin = rigs.findIndex((r) => r.fingerprint.artHash === artHash && r.fingerprint.rigHash === rigHash);
    if (twin < i) {
      rigErrors[i] = `This is the same rig as “${rigs[twin]!.name}” in this upload.`;
      return;
    }
    const sameArt = existing.filter((row) => row.art_hash === artHash);
    const same = sameArt.find((row) => row.rig_hash === rigHash && visible(row));
    if (same) {
      rigErrors[i] = same.owner_id === userId ? `You already have this rig as “${same.name}”.` : `This rig is already in the library as “${same.name}”.`;
      return;
    }
    const credit = sameArt.find(visible) ?? existing.find((row) => row.rig_hash === rigHash && visible(row));
    matches[i] = {
      basedOn: credit ? { id: credit.id, name: credit.name } : null,
      privateOnly: !isAdmin && sameArt.some((row) => row.owner_id !== userId),
    };
  });
  return Object.keys(rigErrors).length > 0 ? { ok: false, rigErrors } : { ok: true, matches };
}

/**
 * Why the user can't make `assetId` public, or null if they can: an upload whose art was in the
 * library first under someone else (an official rig, or another user's upload or remix) stays private.
 */
export async function publishBlocked(assetId: string, userId: string): Promise<string | null> {
  const row = check(
    await db()
      .from("assets")
      .select("art_hash, remix_of, created_at")
      .eq("id", assetId)
      .maybeSingle()
      .overrideTypes<{ art_hash: string | null; remix_of: string | null; created_at: string } | null, { merge: false }>(),
  );
  if (!row?.art_hash || row.remix_of) return null;
  const { count, error } = await db()
    .from("assets")
    .select("id", { count: "exact", head: true })
    .eq("art_hash", row.art_hash)
    .lt("created_at", row.created_at)
    .or(`owner_id.is.null,owner_id.neq.${userId}`);
  if (error) throw new Error(`Database error: ${error.message}`);
  return count ? "This rig's art is already in the library under someone else, so it stays private. Remix it to make it your own." : null;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
