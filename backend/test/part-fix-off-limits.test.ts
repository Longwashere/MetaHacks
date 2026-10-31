// Regression test for part fixes on a region whose box holds other parts (20902 Sumuqishi).
// job_37f11e88 turned the axe (fuzi) into a dragon sword. The neighbours packed in the axe's box
// (a kneepad, a chip, a cloth scrap, armour corners) were drawn as flat off-limits shapes, and
// Muse Image drew the whole sword around them. But the axe's outline was too small for the sword,
// and shrinkPartsToBoxes then centred it in its box, moving its grip and pommel onto the kneepad:
// 16.3% of its paint was lost under kept neighbours. Kept where the model drew it, 0.8% is.
//
// Run with `npm test -w backend`. The fixed region is written to test/output/ to look at.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parseAtlas } from "../src/v2/lib/atlas.js";
import { fitRepaint, placeRepaint, preparePartPage } from "../src/v2/lib/part-fix.js";
import { decodePage, hexToRgb, pickBackground, pickOffLimits } from "../src/v2/lib/textures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures/20902-sumuqishi");
const OUTPUT = path.join(here, "output");
/** Most of the sword's paint that may land on kept neighbours: the fix loses 0.008, the bug lost 0.163. */
const MAX_LOST = 0.03;
/** part-fix.ts PAINTED_ALPHA. */
const PAINTED_ALPHA = 16;

interface FixFixture {
  regions: string[];
  source: "original" | "remix";
  prompt: string;
  look: string;
  outlines: Record<string, number[]>;
}

test("part fix keeps a part drawn around off-limits neighbours where the model put it (job_37f11e88)", async () => {
  const [page] = parseAtlas(await readFile(path.join(FIXTURES, "20902-sumuqishi.atlas"), "utf8"));
  const fix = JSON.parse(await readFile(path.join(FIXTURES, "job_37f11e88.json"), "utf8")) as FixFixture;
  const remixFile = await readFile(path.join(FIXTURES, "job_7e215105.png"));
  const remix = await decodePage(remixFile, false, page.size);
  const original = await decodePage(await readFile(path.join(FIXTURES, page.name)), false, page.size);
  assert.equal(fix.source, "original", "the job started from the original rig");

  // As runPartFix sets the page up.
  const prompt = [fix.prompt, fix.look].join(" ");
  const background = pickBackground([remix, original], prompt);
  const offLimits = pickOffLimits([remix, original], prompt, background);
  assert.deepEqual([background.name, offLimits.name], ["magenta", "pure blue"], "the job's colours");
  const chosen = fix.regions.map((name) => page.regions.indexOf(name));
  const part = await preparePartPage(page, chosen, original, remix, background, offLimits, fix.outlines);
  assert.ok(part.keep && part.offLimits, "the axe's box holds neighbours");

  const generated = await readFile(path.join(FIXTURES, "job_37f11e88.generated.png"));
  const { attached, scales, outlineDropped, fitted } = await fitRepaint(generated, part);
  // The job's own layout check: attached 1, scale 0.986, the axe's outline dropped.
  assert.ok(attached >= 0.95, `attached ${attached}`);
  assert.ok(Math.abs(scales[0] - 0.986) < 0.01, `scale ${scales[0]}`);
  assert.deepEqual(outlineDropped, [true], "the sword doesn't fit the axe's outline");

  // The off-limits shapes are gone from the fitted square, so they aren't keyed in as paint.
  const key = hexToRgb(offLimits.hex);
  const square = await sharp(fitted).removeAlpha().raw().toBuffer();
  let blue = 0;
  for (let p = 0; p < square.length; p += 3) if (Math.hypot(square[p] - key[0], square[p + 1] - key[1], square[p + 2] - key[2]) < 80) blue++;
  assert.equal(blue, 0, "off-limits colour left in the fitted square");

  const { fixed, page: saved } = await placeRepaint(fitted, part, remixFile, false);
  const { data } = await sharp(fixed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = part.rects[0];
  let painted = 0, lost = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const p = y * remix.width + x;
      if (data[p * 4 + 3] < PAINTED_ALPHA) continue;
      painted++;
      if (part.keep[p]) lost++;
    }
  }
  await mkdir(OUTPUT, { recursive: true });
  await sharp(saved).extract({ left: r.x, top: r.y, width: r.width, height: r.height }).flatten({ background: "#262626" }).toFile(path.join(OUTPUT, "job_37f11e88.fuzi.png"));
  assert.ok(lost / painted <= MAX_LOST, `${(lost / painted).toFixed(3)} of the sword's paint is under kept neighbours`);
});
