import type { PageRect } from "./atlas.js";

// Atlas pages come in any shape (the Goblin's is a 1024×128 strip), but Muse Image only keeps
// a square's geometry. Rather than pad a page to a square, which leaves most of the image
// empty for the model to fill with new parts, its regions are laid out in a square of their
// own, all scaled by the same factor and as large as fits, then copied back after painting.

/** Where one atlas area is drawn in the square image the models see, in fractions of its side. */
export interface Placement {
  /** The area on the page, in page pixels. */
  src: PageRect;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PartLayout {
  placements: Placement[];
  /** For each region on the page, its index in `placements`, or -1 for an empty region. */
  regionPlacement: number[];
}

/** Space between packed parts, as a fraction of the square, so neighbours don't bleed together. */
const PACK_GAP = 0.01;
/** Largest enlargement over the plain padded square; more only blurs the input. */
const PACK_MAX_UPSCALE = 4;
/** Repack only when it makes the parts at least this much bigger than the padded square does. */
const PACK_MIN_GAIN = 1.1;

/**
 * Lays out a page's regions for the models. Uses the page itself, padded to a square on the
 * right or bottom, unless repacking the regions makes them at least PACK_MIN_GAIN bigger.
 */
export function layoutParts(rects: PageRect[], page: { width: number; height: number }): PartLayout {
  const unique: PageRect[] = [];
  const indexOf = new Map<string, number>();
  const regionPlacement = rects.map((r) => {
    const src = clampRect(r, page);
    if (!src) return -1;
    const key = `${src.x},${src.y},${src.width},${src.height}`;
    let index = indexOf.get(key);
    if (index === undefined) {
      index = unique.push(src) - 1;
      indexOf.set(key, index);
    }
    return index;
  });

  const side = Math.max(page.width, page.height);
  const padded = unique.map((src) => ({ src, x: src.x / side, y: src.y / side, width: src.width / side, height: src.height / side }));
  const packed = packParts(unique, 1 / side);
  return { placements: packed ?? padded, regionPlacement };
}

/** The placement's area in an image `side` pixels square. Rounded the same way both ways. */
export function toPixels(p: Placement, side: number): PageRect {
  const x = Math.round(p.x * side);
  const y = Math.round(p.y * side);
  return {
    x,
    y,
    width: Math.max(1, Math.min(side, Math.round((p.x + p.width) * side)) - x),
    height: Math.max(1, Math.min(side, Math.round((p.y + p.height) * side)) - y),
  };
}

function clampRect(r: PageRect, page: { width: number; height: number }): PageRect | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(r.x + r.width, page.width) - x;
  const height = Math.min(r.y + r.height, page.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * Shelf-packs the areas into a unit square at the largest common scale that fits, found by
 * binary search. Returns null when that scale isn't PACK_MIN_GAIN above `paddedScale`.
 */
function packParts(rects: PageRect[], paddedScale: number): Placement[] | null {
  if (rects.length === 0) return null;
  // Tallest first, so each shelf wastes little height.
  const order = rects.map((_, i) => i).sort((a, b) => rects[b].height - rects[a].height || rects[b].width - rects[a].width);
  const shelve = (scale: number): Placement[] | null => {
    const placed: Placement[] = new Array(rects.length);
    let x = PACK_GAP, y = PACK_GAP, shelf = 0;
    for (const i of order) {
      const width = rects[i].width * scale;
      const height = rects[i].height * scale;
      if (x + width + PACK_GAP > 1 && x > PACK_GAP) {
        y += shelf + PACK_GAP;
        x = PACK_GAP;
        shelf = 0;
      }
      if (x + width + PACK_GAP > 1) return null;
      placed[i] = { src: rects[i], x, y, width, height };
      x += width + PACK_GAP;
      shelf = Math.max(shelf, height);
    }
    return y + shelf + PACK_GAP <= 1 ? placed : null;
  };

  let low = 0;
  let high = paddedScale * PACK_MAX_UPSCALE;
  let best: Placement[] | null = null;
  for (let step = 0; step < 30; step++) {
    const scale = (low + high) / 2;
    const placed = shelve(scale);
    if (placed) {
      low = scale;
      best = placed;
    } else {
      high = scale;
    }
  }
  return best && low >= paddedScale * PACK_MIN_GAIN ? best : null;
}
