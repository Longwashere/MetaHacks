// Regression test for v3's keyed fit on an atlas whose region boxes overlap (20902 Sumuqishi).
// job_7700b27e's model output was whole, but shrinkPartsToBoxes cut square holes in the visors,
// helmet and shoulder shell (it pasted each shrunk part's whole rectangle over its neighbours) and
// split the chest along the axe's box edge. v2, which copies the square straight back with
// fitToPage, kept every part whole, so its result on the same square is the reference here.
//
// Run with `npm test -w backend`. The fitted page is written to test/output/ to look at.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { layoutParts } from "../src/lib/layout.js";
import { parseAtlas } from "../src/v3/lib/atlas.js";
import { fitKeyedPage } from "../src/v3/lib/remix.js";
import { type PageImage, alignGenerated, decodePage, fitToPage, pickBackground, toModelInput } from "../src/v3/lib/textures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures/20902-sumuqishi");
const OUTPUT = path.join(here, "output");
/** The square side job_7700b27e was painted at (remix.ts IMAGE_MAX_SIDE then). */
const SIDE = 1536;
const PROMPT = "Comic book illustration of [Character Name] converted to a rotting ghoul";

/** Each part must keep at least this share of the reference's paint: the fix keeps 0.91 or more (parts shrink ~4% to FIT_INSET), the bug kept 0.05. */
const MIN_KEPT = 0.85;
/** Bits of paint smaller than this many pixels aren't counted as a separate piece of a part. */
const MIN_PIECE = 50;

/** Shares of a part's own pixels (the original page's alpha in its box) that both pages paint, and that `reference` paints. */
function kept(original: PageImage, reference: PageImage, fitted: PageImage, r: { x: number; y: number; width: number; height: number }): number {
  let painted = 0, both = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const a = (y * original.width + x) * 4 + 3;
      if (original.rgba[a] < 128 || reference.rgba[a] < 128) continue;
      painted++;
      if (fitted.rgba[a] >= 128) both++;
    }
  }
  return painted === 0 ? 1 : both / painted;
}

/** Separate pieces of paint (4-connected, at least MIN_PIECE pixels) inside a part's own pixels. */
function pieces(original: PageImage, page: PageImage, r: { x: number; y: number; width: number; height: number }): number {
  const { width: w, height: h } = r;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((r.y + y) * original.width + r.x + x) * 4 + 3;
      on[y * w + x] = original.rgba[a] >= 128 && page.rgba[a] >= 128 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  let count = 0;
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    const queue = [s];
    seen[s] = 1;
    for (let k = 0; k < queue.length; k++) {
      const p = queue[k], x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= on.length || !on[q] || seen[q]) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
    if (queue.length >= MIN_PIECE) count++;
  }
  return count;
}

test("v3 keyed fit keeps every part whole where atlas boxes overlap (job_7700b27e)", async () => {
  const [page] = parseAtlas(await readFile(path.join(FIXTURES, "20902-sumuqishi.atlas"), "utf8"));
  const original = await decodePage(await readFile(path.join(FIXTURES, page.name)), false, page.size);
  const generated = await readFile(path.join(FIXTURES, "job_7700b27e.generated.png"));
  const modelInput = await toModelInput(original, SIDE, pickBackground([original], PROMPT), layoutParts(page.rects, original));

  const reference = await decodePage(await fitToPage(generated, modelInput, original, false, page.rects), false);
  const aligned = await alignGenerated(generated, modelInput, original, page.rects);
  const { png } = await fitKeyedPage(aligned, modelInput, original, false, page.rects);
  const fitted = await decodePage(png, false);
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, "20902-sumuqishi.fitted.png"), png);

  const cut: string[] = [];
  const split: string[] = [];
  for (const [i, r] of page.rects.entries()) {
    const share = kept(original, reference, fitted, r);
    if (share < MIN_KEPT) cut.push(`${page.regions[i]} kept ${share.toFixed(3)}`);
    const [was, now] = [pieces(original, reference, r), pieces(original, fitted, r)];
    if (now > was) split.push(`${page.regions[i]} ${was} → ${now} pieces`);
  }
  assert.deepEqual(cut, [], "parts lost paint the v2 fit keeps (holes cut by a neighbour)");
  assert.deepEqual(split, [], "parts broke into more pieces than the v2 fit (sliced along a box edge)");
});
