import sharp from "sharp";
import type { Cutout } from "./types.js";

// Turns Muse Image's redraw (the character on flat magenta) into a cutout: the key colour is
// keyed out with soft edges, its tint is taken off the edges, specks are dropped and the image is
// trimmed to the character with a margin.

const MAGENTA: [number, number, number] = [255, 0, 255];
/** Colour distance from the key below which a pixel is background, and above which it's solid. */
const KEY_NEAR = 60;
const KEY_FAR = 140;
/** Pieces smaller than this share of the largest are specks the model left on the background. */
const SPECK_SHARE = 0.002;
/** Clear space kept around the character, as a share of its larger side. */
const MARGIN_SHARE = 0.03;

/** Keys the key colour (magenta by default) out of an image of the character. */
export async function keyCutout(image: Buffer, key = MAGENTA): Promise<Cutout> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0, q = 0; p < data.length; p += 3, q += 4) {
    const [r, g, b] = [data[p], data[p + 1], data[p + 2]];
    const d = Math.hypot(r - key[0], g - key[1], b - key[2]);
    const a = Math.min(Math.max((d - KEY_NEAR) / (KEY_FAR - KEY_NEAR), 0), 1);
    if (a === 0) continue;
    // Take the key's share back out of edge pixels, then any magenta cast left on them.
    let [rr, gg, bb] = [r, g, b].map((c, i) => (a < 1 ? (c - (1 - a) * key[i]) / a : c));
    if (a < 1) {
      const spill = Math.min(rr, bb) - gg;
      if (spill > 0) {
        rr -= spill;
        bb -= spill;
      }
    }
    rgba[q] = clamp255(rr);
    rgba[q + 1] = clamp255(gg);
    rgba[q + 2] = clamp255(bb);
    rgba[q + 3] = Math.round(a * 255);
  }
  return trimCutout(dropSpecks({ width, height, rgba }));
}

/** A cutout from an image that already has a transparent background (skips Muse). */
export async function alphaCutout(image: Buffer): Promise<Cutout> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return trimCutout(dropSpecks({ width: info.width, height: info.height, rgba: Buffer.from(data) }));
}

/** Whether an image has enough transparent background to be rigged without Muse. */
export async function hasTransparentBackground(image: Buffer): Promise<boolean> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) return false;
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) clear++;
  return clear / (info.width * info.height) > 0.15;
}

/** Clears connected pieces much smaller than the character. */
function dropSpecks(cut: Cutout): Cutout {
  const { width, height, rgba } = cut;
  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < 128) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of NEIGHBOURS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (label[n] === -1 && rgba[n * 4 + 3] >= 128) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    sizes.push(size);
  }
  const keep = Math.max(0, ...sizes) * SPECK_SHARE;
  const out = Buffer.from(rgba);
  for (let i = 0; i < width * height; i++) {
    // Faint pixels (unlabelled) stay only beside a kept piece, as its soft edge.
    if (label[i] >= 0 ? sizes[label[i]] < keep : !nearKept(i)) out[i * 4 + 3] = 0;
  }
  return { width, height, rgba: out };

  function nearKept(i: number): boolean {
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const l = label[ny * width + nx];
        if (l >= 0 && sizes[l] >= keep) return true;
      }
    }
    return false;
  }
}

/** Crops to the visible pixels plus a margin. */
function trimCutout(cut: Cutout): Cutout {
  const { width, height, rgba } = cut;
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < 8) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) throw new Error("No character was found in the image.");
  const margin = Math.ceil(Math.max(x1 - x0, y1 - y0) * MARGIN_SHARE);
  const w = x1 - x0 + 1 + margin * 2;
  const h = y1 - y0 + 1 + margin * 2;
  const out = Buffer.alloc(w * h * 4);
  for (let y = y0; y <= y1; y++) {
    rgba.copy(out, ((y - y0 + margin) * w + margin) * 4, (y * width + x0) * 4, (y * width + x1 + 1) * 4);
  }
  return { width: w, height: h, rgba: out };
}

const NEIGHBOURS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function clamp255(v: number): number {
  return Math.min(Math.max(Math.round(v), 0), 255);
}
