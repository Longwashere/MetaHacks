// Admin uploads are renamed after Muse names them (lib/upload-rename.ts): the .atlas's page lines are
// rewritten to the new page file names. ChibiStickers has 10 pages in Spine 4.2's atlas format, so
// this checks every page is renamed, each keeps its regions, and the skeleton still loads against it.
//
// Run with `npm test -w backend`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as spine from "@esotericsoftware/spine-core";
import { skelToJson } from "../src/lib/spine-skel-json.js";
import { nameSlug, renameAtlasPages } from "../src/lib/upload-rename.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures/chibi-stickers");

test("renaming a 10-page atlas keeps every page's regions and still loads the skeleton", async () => {
  const atlas = await readFile(path.join(FIXTURES, "ChibiStickers.atlas"), "utf8");
  const before = new spine.TextureAtlas(atlas);
  assert.equal(before.pages.length, 10);

  const slug = nameSlug("Sticker Swarm");
  const pageNames = new Map(before.pages.map((p, i) => [p.name, `${slug}${i === 0 ? "" : i + 1}.png`]));
  const renamed = renameAtlasPages(atlas, pageNames);
  const after = new spine.TextureAtlas(renamed);

  assert.deepEqual(after.pages.map((p) => p.name), [...pageNames.values()]);
  const regionsByPage = (a: spine.TextureAtlas) => a.pages.map((page) => a.regions.filter((r) => r.page === page).map((r) => r.name));
  assert.deepEqual(regionsByPage(after), regionsByPage(before));
  // Only page lines changed.
  assert.equal(renamed.split("\n").length, atlas.split("\n").length);

  const skeleton = skelToJson(await readFile(path.join(FIXTURES, "ChibiStickers.skel")));
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(after)).readSkeletonData(JSON.stringify(skeleton));
  assert.ok(data.bones.length > 0);
});

test("an atlas page that wasn't uploaded is an error", async () => {
  const atlas = await readFile(path.join(FIXTURES, "ChibiStickers.atlas"), "utf8");
  assert.throws(() => renameAtlasPages(atlas, new Map([["ChibiStickers.png", "a.png"]])), /wasn't uploaded/);
});
