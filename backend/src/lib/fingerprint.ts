import { createHash } from "node:crypto";
import type { AssetFileKeys } from "./db.js";
import { skelToJson } from "./spine-skel-json.js";
import { objectUrl } from "./storage.js";

// Fingerprints of a rig, for spotting re-uploads (lib/uploads.ts). Uploads and remixes carry them,
// and every save that changes an asset's files updates them. The art hash covers
// the page PNGs in any order and under any file name. The rig hash covers the skeleton JSON with
// its keys sorted and the header fields Spine rewrites on every export dropped, so re-exporting
// the same project gives the same hash.

/** Fields of the skeleton JSON's `skeleton` header that change between exports of the same rig. */
const EXPORT_FIELDS = new Set(["hash", "spine", "images", "audio", "fps"]);

export interface RigFingerprint {
  artHash: string;
  rigHash: string;
}

export function fingerprintRig(skeleton: Record<string, unknown>, pages: Buffer[]): RigFingerprint {
  const pageHashes = pages.map((page) => sha256(page)).sort();
  return { artHash: sha256(pageHashes.join("\n")), rigHash: rigHashOf(skeleton) };
}

/** The rig hash alone, for saves that change only the skeleton (tweaks, Muse animations). */
export function rigHashOf(skeleton: Record<string, unknown>): string {
  const header = skeleton.skeleton;
  const rig =
    typeof header === "object" && header !== null
      ? { ...skeleton, skeleton: Object.fromEntries(Object.entries(header).filter(([key]) => !EXPORT_FIELDS.has(key))) }
      : skeleton;
  return sha256(stableStringify(rig));
}

/**
 * The fingerprint columns of a stored rig, read from its files' public URLs. A binary .skel is
 * converted to JSON the way the upload page converts it, so it hashes like an upload. Both are null when a
 * file can't be read: an unfingerprinted asset is only left out of the re-upload check, while a
 * stale fingerprint would match the wrong uploads.
 */
export async function fingerprintFiles(files: AssetFileKeys): Promise<{ art_hash: string | null; rig_hash: string | null }> {
  try {
    const signal = AbortSignal.timeout(30_000);
    const read = async (key: string) => {
      const res = await fetch(objectUrl(key), { signal });
      if (!res.ok) throw new Error(`couldn't fetch ${key} (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    };
    const [skeleton, ...pages] = await Promise.all([read(files.skeleton), ...files.textures.map(read)]);
    const parsed: unknown = files.skeleton.toLowerCase().endsWith(".skel") ? skelToJson(skeleton!) : JSON.parse(skeleton!.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the skeleton isn't a JSON object");
    const { artHash, rigHash } = fingerprintRig(parsed as Record<string, unknown>, pages);
    return { art_hash: artHash, rig_hash: rigHash };
  } catch (error) {
    console.warn(`Couldn't fingerprint ${files.skeleton}:`, error instanceof Error ? error.message : error);
    return { art_hash: null, rig_hash: null };
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted, so key order doesn't change the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
