import { randomUUID } from "node:crypto";
import * as spine from "@esotericsoftware/spine-core";
import type { AssetFileKeys } from "./db.js";
import { putFile } from "./storage.js";

// Admin uploads: once Muse has named a rig (upload-tags.ts), its files are stored again under that
// name: <slug>.json, <slug>.atlas and <slug>.png, <slug>2.png… for the pages, with the .atlas's page
// lines rewritten to match. They go in a new folder, so they can't overwrite the originals (R2
// caches them as immutable), and the original files are kept: anything that loaded the rig before
// the rename still finds them.

export interface RenameFiles {
  atlas: string;
  /** In the atlas's page order, named as the atlas names them. */
  pages: { name: string; data: Buffer }[];
  skeleton: Record<string, unknown>;
  /** The asset's current file keys; flags like premultipliedAlpha and skin carry over. */
  files: AssetFileKeys;
}

export function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Stores the rig's files under `name` and returns their keys. Throws if the slug is empty or the rewritten atlas doesn't load. */
export async function storeRenamedFiles(name: string, rig: RenameFiles): Promise<AssetFileKeys> {
  const slug = nameSlug(name);
  if (!slug) throw new Error(`"${name}" has no letters or digits to name files with.`);
  const pageNames = new Map(rig.pages.map((page, i) => [page.name, `${slug}${i === 0 ? "" : i + 1}.png`]));
  const atlas = renameAtlasPages(rig.atlas, pageNames);

  const folder = `${new Date().toISOString().replace(/[:.]/g, "-")}_upload_${randomUUID().slice(0, 8)}`;
  const [skeleton, atlasKey, ...textures] = await Promise.all([
    putFile(folder, `${slug}.json`, JSON.stringify(rig.skeleton)),
    putFile(folder, `${slug}.atlas`, atlas),
    ...rig.pages.map((page) => putFile(folder, pageNames.get(page.name)!, page.data)),
  ]);
  return { ...rig.files, skeleton, atlas: atlasKey, textures };
}

/**
 * Renames the page lines of a Spine .atlas: the first line and each line after a blank one (the
 * same rule parseAtlas in atlas.ts reads them by). Checks the result with the Spine runtime.
 */
export function renameAtlasPages(atlas: string, pageNames: Map<string, string>): string {
  let expectPage = true;
  const lines = atlas.split(/(\r?\n)/).map((part, i) => {
    // Odd parts are the line breaks split() kept.
    if (i % 2 === 1) return part;
    const line = part.trim();
    if (!line) {
      expectPage = true;
      return part;
    }
    if (!expectPage) return part;
    expectPage = false;
    const renamed = pageNames.get(line);
    if (!renamed) throw new Error(`The atlas page "${line}" wasn't uploaded.`);
    return renamed;
  });
  const result = lines.join("");
  const pages = new spine.TextureAtlas(result).pages.map((p) => p.name);
  const expected = [...pageNames.values()];
  if (pages.length !== expected.length || pages.some((p, i) => p !== expected[i])) {
    throw new Error(`The renamed atlas reads pages ${pages.join(", ")}, expected ${expected.join(", ")}.`);
  }
  return result;
}
