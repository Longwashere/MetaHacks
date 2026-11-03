import type { Cutout } from "./types.js";

// Cutting the character into parts (AUTO_RIG_PLAN.md, "Slicing"). Each part keeps its own pixels;
// where it lies under another part at a joint, the hidden area is filled by smearing in colour
// from the part's own pixels, ring by ring, so a moving limb reveals plausible art rather than a
// hole. The parts are then packed onto one atlas page.

export interface PartCut {
  name: string;
  /** Pixel bounds in the cutout (inclusive x0/y0, exclusive x1/y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Per pixel of the bounds: 0 = not this part, 1 = its own pixel, 2 = hidden, to be filled. */
  kind: Uint8Array;
}

export interface PackedRegion {
  name: string;
  /** Where the region sits on the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where its top-left came from in the cutout. */
  srcX: number;
  srcY: number;
}

/** Space between packed regions, so linear filtering doesn't bleed one into the next. */
const GUTTER = 2;

export interface PackedPage {
  page: Cutout;
  regions: PackedRegion[];
  /** Per page pixel: 1 where the art is hidden fill (smeared, for a later paint pass to replace). */
  hidden: Uint8Array;
}

export function fillAndPack(cut: Cutout, parts: PartCut[]): PackedPage {
  const images = parts.map((p) => ({ part: p, rgba: fillPart(cut, p) }));

  // Shelf packing, tallest first, on a page about as wide as it is tall.
  const sizes = images.map(({ part }) => ({ w: part.x1 - part.x0, h: part.y1 - part.y0 }));
  const area = sizes.reduce((s, z) => s + (z.w + GUTTER) * (z.h + GUTTER), 0);
  const pageWidth = Math.max(Math.ceil(Math.sqrt(area) * 1.15), ...sizes.map((z) => z.w + GUTTER * 2));
  const order = images.map((_, i) => i).sort((a, b) => sizes[b].h - sizes[a].h);
  const placed: { x: number; y: number }[] = [];
  let x = GUTTER;
  let y = GUTTER;
  let rowHeight = 0;
  for (const i of order) {
    if (x + sizes[i].w + GUTTER > pageWidth) {
      x = GUTTER;
      y += rowHeight + GUTTER;
      rowHeight = 0;
    }
    placed[i] = { x, y };
    x += sizes[i].w + GUTTER;
    rowHeight = Math.max(rowHeight, sizes[i].h);
  }
  const pageHeight = y + rowHeight + GUTTER;

  const page = Buffer.alloc(pageWidth * pageHeight * 4);
  const hidden = new Uint8Array(pageWidth * pageHeight);
  const regions = images.map(({ part, rgba }, i) => {
    const { w, h } = sizes[i];
    for (let row = 0; row < h; row++) {
      rgba.copy(page, ((placed[i].y + row) * pageWidth + placed[i].x) * 4, row * w * 4, (row + 1) * w * 4);
      for (let x = 0; x < w; x++) {
        if (part.kind[row * w + x] === 2 && rgba[(row * w + x) * 4 + 3] > 0) hidden[(placed[i].y + row) * pageWidth + placed[i].x + x] = 1;
      }
    }
    return { name: part.name, x: placed[i].x, y: placed[i].y, width: w, height: h, srcX: part.x0, srcY: part.y0 };
  });
  return { page: { width: pageWidth, height: pageHeight, rgba: page }, regions, hidden };
}

/** The part's pixels, with its hidden area filled by smearing colour in from its own pixels. */
function fillPart(cut: Cutout, part: PartCut): Buffer {
  const w = part.x1 - part.x0;
  const h = part.y1 - part.y0;
  const out = Buffer.alloc(w * h * 4);
  const known = new Uint8Array(w * h);
  const hidden: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const src = ((y + part.y0) * cut.width + x + part.x0) * 4;
      if (part.kind[i] === 1) {
        cut.rgba.copy(out, i * 4, src, src + 4);
        // Only solid pixels away from the outline seed the fill: edge pixels can keep a trace of
        // the key colour, which the smear would spread across the whole hidden area.
        if (cut.rgba[src + 3] >= 250 && solidAround(cut, x + part.x0, y + part.y0)) known[i] = 1;
      } else if (part.kind[i] === 2) {
        out[i * 4 + 3] = cut.rgba[src + 3];
        hidden.push(i);
      }
    }
  }
  // Onion-peel: each ring of hidden pixels takes the average of its already-known neighbours.
  let left = hidden;
  while (left.length) {
    const ring: [number, number, number, number][] = [];
    const next: number[] = [];
    for (const i of left) {
      const x = i % w;
      const y = (i - x) / w;
      let [r, g, b, n] = [0, 0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && known[ny * w + nx]) {
            const j = (ny * w + nx) * 4;
            r += out[j];
            g += out[j + 1];
            b += out[j + 2];
            n++;
          }
        }
      }
      if (n) ring.push([i, r / n, g / n, b / n]);
      else next.push(i);
    }
    if (!ring.length) {
      // Cut off from the part's own pixels: leave them clear.
      for (const i of next) out[i * 4 + 3] = 0;
      break;
    }
    for (const [i, r, g, b] of ring) {
      out[i * 4] = Math.round(r);
      out[i * 4 + 1] = Math.round(g);
      out[i * 4 + 2] = Math.round(b);
      known[i] = 1;
    }
    left = next;
  }
  // Soften the streaks the rings leave: a few box-blur passes over the filled pixels only.
  const filled = hidden.filter((i) => out[i * 4 + 3] > 0);
  for (let pass = 0; pass < 3; pass++) {
    const next = filled.map((i) => {
      const x = i % w;
      const y = (i - x) / w;
      let [r, g, b, n] = [0, 0, 0, 0];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !known[ny * w + nx]) continue;
          const j = (ny * w + nx) * 4;
          r += out[j];
          g += out[j + 1];
          b += out[j + 2];
          n++;
        }
      }
      return [r / n, g / n, b / n];
    });
    filled.forEach((i, k) => {
      out[i * 4] = Math.round(next[k][0]);
      out[i * 4 + 1] = Math.round(next[k][1]);
      out[i * 4 + 2] = Math.round(next[k][2]);
    });
  }
  return out;
}

function solidAround(cut: Cutout, x: number, y: number): boolean {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cut.width || ny >= cut.height || cut.rgba[(ny * cut.width + nx) * 4 + 3] < 128) return false;
    }
  }
  return true;
}
