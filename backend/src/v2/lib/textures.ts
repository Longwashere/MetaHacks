import sharp from "sharp";
import type { PageRect } from "./atlas.js";
import { type PartLayout, toPixels } from "../../lib/layout.js";

/** A solid colour the transparent parts of a page are flattened onto before the models see it. */
export interface Background {
  /** Hex colour, e.g. "#FF00FF". */
  hex: string;
  /** How the prompts refer to it. */
  name: string;
}

/**
 * Background candidates, in order of preference. Saturated key colours are easy for
 * the image model to name and keep solid, and rarely appear in character art — a grey
 * background hid grey parts like bones, and the model left them unpainted.
 */
const BACKGROUNDS: Background[] = [
  { hex: "#FF00FF", name: "magenta" },
  { hex: "#00FF00", name: "bright green" },
  { hex: "#0000FF", name: "pure blue" },
  { hex: "#00FFFF", name: "cyan" },
  { hex: "#FFFF00", name: "bright yellow" },
  { hex: "#FF8000", name: "bright orange" },
  { hex: "#FF0000", name: "pure red" },
];

/**
 * Colours the requested look is likely to paint, by word in the user's prompt. The
 * background has to stay clear of the repainted parts too, not just the original ones.
 */
const PROMPT_COLOURS: [RegExp, string][] = [
  [/(red|crimson|scarlet|blood|ruby)/, "#D01020"],
  [/(orange|fire|flames?|lava|ember|copper)/, "#FF7010"],
  [/(yellow|gold|golden|amber|honey)/, "#E8C020"],
  [/(green|lime|emerald|jade|orc|goblin|zombie|slime|toxic|poison|moss)/, "#40B020"],
  [/(teal|turquoise|aqua|cyan)/, "#20C0C0"],
  [/(blue|navy|sapphire|azure|ice|frost|frozen)/, "#2050E0"],
  [/(purple|violet|amethyst|lavender)/, "#8030C0"],
  [/(pink|magenta|fuchsia|rose)/, "#F040C0"],
];
/** Share of the rig's pixels each colour named in the prompt counts as. */
const PROMPT_COLOUR_WEIGHT = 0.25;
/** A candidate is scored by how close the nearest colours get, ignoring this share of outliers. */
const BACKGROUND_OUTLIER_SHARE = 0.005;
/** Colours are binned to 5 bits per channel before scoring. */
const BIN_SHIFT = 3;

/**
 * Picks the background candidate the rig's colours, and the colours `prompt` asks
 * for, stay farthest from.
 */
export function pickBackground(pages: PageImage[], prompt: string): Background {
  const bins = new Float64Array(1 << (3 * (8 - BIN_SHIFT)));
  const binOf = (r: number, g: number, b: number) =>
    ((r >> BIN_SHIFT) << (2 * (8 - BIN_SHIFT))) | ((g >> BIN_SHIFT) << (8 - BIN_SHIFT)) | (b >> BIN_SHIFT);
  let total = 0;
  for (const page of pages) {
    for (let p = 0; p < page.rgba.length; p += 4) {
      if (page.rgba[p + 3] < 128) continue;
      bins[binOf(page.rgba[p], page.rgba[p + 1], page.rgba[p + 2])]++;
      total++;
    }
  }
  const words = prompt.toLowerCase();
  for (const [pattern, hex] of PROMPT_COLOURS) {
    if (pattern.test(words)) bins[binOf(...hexToRgb(hex))] += Math.max(total, 1) * PROMPT_COLOUR_WEIGHT;
  }

  let best = BACKGROUNDS[0];
  let bestRoom = -1;
  for (const candidate of BACKGROUNDS) {
    const room = clearance(bins, hexToRgb(candidate.hex));
    if (room > bestRoom) {
      best = candidate;
      bestRoom = room;
    }
  }
  return best;
}

/**
 * Distance from `key` within which the closest BACKGROUND_OUTLIER_SHARE of the binned
 * colours lie, so a few stray pixels don't rule a candidate out.
 */
function clearance(bins: Float64Array, key: [number, number, number]): number {
  const bits = 8 - BIN_SHIFT;
  const half = 1 << (BIN_SHIFT - 1);
  const byDistance = new Float64Array(443);
  let total = 0;
  for (let i = 0; i < bins.length; i++) {
    if (!bins[i]) continue;
    const r = ((i >> (2 * bits)) << BIN_SHIFT) + half;
    const g = (((i >> bits) & ((1 << bits) - 1)) << BIN_SHIFT) + half;
    const b = ((i & ((1 << bits) - 1)) << BIN_SHIFT) + half;
    byDistance[Math.round(Math.hypot(r - key[0], g - key[1], b - key[2]))] += bins[i];
    total += bins[i];
  }
  const allowed = total * BACKGROUND_OUTLIER_SHARE;
  let seen = 0;
  for (let d = 0; d < byDistance.length; d++) {
    seen += byDistance[d];
    if (seen > allowed) return d;
  }
  return byDistance.length;
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** An atlas page decoded to straight (non-premultiplied) RGBA. */
export interface PageImage {
  width: number;
  height: number;
  rgba: Buffer;
}

export async function decodePage(file: Buffer, premultipliedAlpha: boolean): Promise<PageImage> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (premultipliedAlpha) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0 || a === 255) continue;
      data[i] = Math.min(255, Math.round((data[i] * 255) / a));
      data[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / a));
      data[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / a));
    }
  }
  return { width: info.width, height: info.height, rgba: data };
}

/** A page prepared for the models: its parts laid out in a square PNG (see layout.ts). */
export interface ModelInput {
  dataUrl: string;
  /** Square side in pixels. */
  side: number;
  layout: PartLayout;
  background: Background;
}

/**
 * The page's parts drawn into a `side`-pixel square as `layout` places them, on `background`.
 * The image model only honours aspect ratios loosely, and a square comes back square, so
 * the parts stay where they were. `soften` (see softenTexture) smooths the parts' painted
 * texture first, for style changes.
 */
export async function toModelInput(
  page: PageImage,
  side: number,
  background: Background,
  layout: PartLayout,
  soften = 0,
): Promise<ModelInput> {
  const rgba = soften > 0 ? await softenTexture(page, soften) : page.rgba;
  const flat = await sharp(rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
    .flatten({ background: background.hex })
    .raw()
    .toBuffer();
  const parts = await Promise.all(
    layout.placements.map(async (p) => {
      const to = toPixels(p, side);
      const input = await sharp(flat, { raw: { width: page.width, height: page.height, channels: 3 } })
        .extract({ left: p.src.x, top: p.src.y, width: p.src.width, height: p.src.height })
        .resize(to.width, to.height, { fit: "fill" })
        .png()
        .toBuffer();
      return { input, left: to.x, top: to.y };
    }),
  );
  const square = await sharp({ create: { width: side, height: side, channels: 3, background: background.hex } })
    .composite(parts)
    .png()
    .toBuffer();
  return { dataUrl: `data:image/png;base64,${square.toString("base64")}`, side, layout, background };
}

/**
 * The page with its painted texture smoothed away but its shapes, colours and silhouettes kept:
 * a median filter `amount` of the page's longer side wide, on colour only, with the original
 * alpha. Muse Image has no edit-strength setting and copies whatever fine texture it's given,
 * so for a style change it gets less of the old rendering to hold on to (job_72ff8499).
 * Colours are spread past the parts' edges first, so the filter doesn't pull in the
 * transparent background as a dark fringe.
 */
async function softenTexture(page: PageImage, amount: number): Promise<Buffer> {
  const { width, height, rgba } = page;
  const window = Math.max(3, Math.round((amount * Math.max(width, height)) / 2) * 2 + 1);
  // Alpha-weighted blur, divided back out: each transparent pixel takes its painted neighbours' colour.
  const pre = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    pre[i] = Math.round(rgba[i] * a);
    pre[i + 1] = Math.round(rgba[i + 1] * a);
    pre[i + 2] = Math.round(rgba[i + 2] * a);
    pre[i + 3] = rgba[i + 3];
  }
  const spread = await sharp(pre, { raw: { width, height, channels: 4 } }).blur(window).raw().toBuffer();
  const filled = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3];
    const s = spread[i + 3];
    for (let c = 0; c < 3; c++) {
      filled[j + c] = a >= 128 || s === 0 ? rgba[i + c] : Math.min(255, Math.round((spread[i + c] * 255) / s));
    }
  }
  const smooth = await sharp(filled, { raw: { width, height, channels: 3 } }).median(window).raw().toBuffer();
  const out = Buffer.from(rgba);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    out[i] = smooth[j];
    out[i + 1] = smooth[j + 1];
    out[i + 2] = smooth[j + 2];
  }
  return out;
}

export async function toDataUrl(image: Buffer, maxSide: number): Promise<string> {
  const png = await sharp(image).resize({ width: maxSide, height: maxSide, fit: "inside" }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Fits a repainted page back onto the original at the same pixel size. The image model
 * only returns opaque images at roughly the requested aspect ratio. The model's drift is
 * undone in the square it painted, then each part is copied back to its area on the page.
 *
 * With `keyedRects` null, every region keeps its exact silhouette: the original alpha
 * is reused and the repainted colour is grown to fill it. Otherwise the parts take the
 * model's own silhouettes, keyed out of the background and kept within `keyedRects`
 * (the regions' areas on the page), so new shapes survive.
 */
export async function fitToPage(
  generated: Buffer,
  input: ModelInput,
  page: PageImage,
  premultipliedAlpha: boolean,
  keyedRects: PageRect[] | null,
  /** False when the parts were already placed (part fixes fit each part to its box themselves). */
  align = true,
): Promise<Buffer> {
  const { side, layout } = input;
  const square = await sharp(generated).resize(side, side, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const alignedSquare = align
    ? alignToPage(square, await layoutPage(page, layout, side), input.background, keyedRects && layout.placements.map((p) => toPixels(p, side)))
    : square;
  const aligned = await unpackSquare(alignedSquare, side, layout, page, input.background);
  let alpha: Uint8Array;
  if (keyedRects) {
    alpha = keyOut(aligned, page.width, page.height, input.background, keyedRects);
  } else {
    fillBackgroundBleed(aligned, page, input.background);
    alpha = new Uint8Array(page.width * page.height);
    for (let p = 0; p < alpha.length; p++) alpha[p] = page.rgba[p * 4 + 3];
  }
  const out = Buffer.alloc(page.width * page.height * 4);
  for (let p = 0, i = 0; p < out.length; p += 4, i += 3) {
    const a = alpha[p / 4];
    const scale = premultipliedAlpha ? a / 255 : 1;
    out[p] = a === 0 ? 0 : Math.round(aligned[i] * scale);
    out[p + 1] = a === 0 ? 0 : Math.round(aligned[i + 1] * scale);
    out[p + 2] = a === 0 ? 0 : Math.round(aligned[i + 2] * scale);
    out[p + 3] = a;
  }
  return sharp(out, { raw: { width: page.width, height: page.height, channels: 4 } }).png().toBuffer();
}

/** Paint further than this from a part's box, as a share of the box's longer side, is stray, not part of it. */
const SHRINK_REACH = 0.5;
/** Blobs smaller than this many pixels are specks, not parts, and are left where they are. */
const SHRINK_MIN_BLOB = 64;
/** Rings of background-masked pixels around a part that move with it: the model's outlines blend into the key colour there. */
const SHRINK_EDGE = 3;

/** Where shrinkPartsToBoxes must fit each part. */
export interface FitTargets {
  /** Margin kept clear inside each box (and outline), as a share of the box's shorter side, so soft edges aren't cut. */
  inset: number;
  /**
   * Per placement, an outline the part must also fit inside, as [x0, y0, x1, y1, ...] in fractions
   * of the square, or null for the box alone. Used for meshes the game clips to their outline.
   */
  outlines?: (number[] | null)[];
  /**
   * When fitting a part inside its outline would shrink it below this, the outline is dropped and
   * the part fits its box alone at full size. The game then clips it to the old outline until the
   * outline is grown (the tweak panel's "Grow outline", or auto-tweak).
   */
  minOutlineScale?: number;
}

/** Smallest scale tried when fitting a part inside an outline; the caller rejects anything this small. */
const SHRINK_MIN_SCALE = 0.3;
/**
 * Share of a part's pixels allowed outside its outline (the game hides them), so a leaf tip or
 * stray stroke doesn't shrink the whole part.
 */
const OUTLINE_SPILL = 0.01;

/**
 * Shrinks parts the model painted bigger than their target (an axe in a sword's box) so every
 * pixel fits, rather than being cut off when it's copied back. Each connected blob of paint
 * belongs to the box most of it lies in, so an axe blade reaching into a neighbour's box stays
 * with the axe (see partOwners); paint touching no box is left out. The target is the box less
 * `inset`, and, where `outlines` gives one, also the inside of that outline, of which up to
 * OUTLINE_SPILL may be missed. A part already inside its target is left alone; otherwise it's
 * scaled down evenly, by the largest factor that fits, and centred in the target.
 * Returns the square as a PNG, the scale applied to each placement (1 when it already fit), and
 * which placements dropped their outline (see FitTargets.minOutlineScale).
 */
export async function shrinkPartsToBoxes(
  generated: Buffer,
  input: ModelInput,
  targets: FitTargets = { inset: 0 },
): Promise<{ image: Buffer; scales: number[]; outlineDropped: boolean[] }> {
  const { side, layout, background } = input;
  const rgb = await sharp(generated).resize(side, side, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const source = Buffer.from(rgb);
  const key = hexToRgb(background.hex);
  const isBg = backgroundMask(rgb, side, side, background);
  const boxes = layout.placements.map((p) => toPixels(p, side));

  const owner = partOwners(isBg, side, boxes, false);

  const scales = boxes.map(() => 1);
  const outlineDropped = boxes.map(() => false);
  for (const [i, b] of boxes.entries()) {
    const pixels: number[] = [];
    let x0 = side, x1 = -1, y0 = side, y1 = -1;
    for (let p = 0; p < owner.length; p++) {
      if (owner[p] !== i) continue;
      pixels.push(p);
      const x = p % side, y = (p - x) / side;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (x1 < 0) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const margin = Math.round(targets.inset * Math.min(b.width, b.height));
    const inner = { x: b.x + margin, y: b.y + margin, width: b.width - 2 * margin, height: b.height - 2 * margin };
    if (inner.width < 2 || inner.height < 2) continue;
    const outline = targets.outlines?.[i];
    let mask = outline ? await outlineMask(outline, side, inner, margin) : null;
    const inside = (x: number, y: number) =>
      mask ? x >= 0 && y >= 0 && x < side && y < side && mask[y * side + x] === 1 : x >= inner.x && y >= inner.y && x < inner.x + inner.width && y < inner.y + inner.height;
    const missed = (s: number, at: (p: number) => [number, number]) => {
      let out = 0;
      for (let k = 0; k < pixels.length; k += 2) {
        const [x, y] = at(pixels[k]);
        if (!inside(Math.round(cx + (x - cx) * s), Math.round(cy + (y - cy) * s))) out++;
      }
      return out / Math.ceil(pixels.length / 2);
    };
    // Allowed outside the target as it is: none for the box, OUTLINE_SPILL for an outline.
    const allowed = mask ? OUTLINE_SPILL : 0;
    let cx = 0, cy = 0;
    if (missed(1, (p) => [p % side, Math.floor(p / side)]) <= allowed) continue;

    let scale = Math.min(inner.width / w, inner.height / h, 1);
    // Centred in the box, or on the middle of the outline's area.
    cx = inner.x + inner.width / 2;
    cy = inner.y + inner.height / 2;
    if (mask) {
      let sx = 0, sy = 0, n = 0;
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        sx += p % side;
        sy += Math.floor(p / side);
        n++;
      }
      if (n === 0) continue;
      [cx, cy] = [sx / n, sy / n];
      const px = (x0 + x1) / 2, py = (y0 + y1) / 2;
      // Each pixel moved so the part's middle lands on (cx, cy), then scaled about it.
      const fits = (s: number) => missed(s, (p) => [cx + (p % side) - px, cy + Math.floor(p / side) - py]) <= allowed;
      if (!fits(scale)) {
        let lo = SHRINK_MIN_SCALE, hi = scale;
        for (let step = 0; step < 12; step++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        scale = lo;
      }
      // Too small to be any use: keep the art at full size in its box instead.
      if (scale < (targets.minOutlineScale ?? 0)) {
        mask = null;
        outlineDropped[i] = true;
        if (missed(1, (p) => [p % side, Math.floor(p / side)]) === 0) continue;
        scale = Math.min(inner.width / w, inner.height / h, 1);
        cx = inner.x + inner.width / 2;
        cy = inner.y + inner.height / 2;
      }
    }
    scales[i] = Math.round(scale * 1000) / 1000;

    // The part on its own: its pixels within the extent, everything else background.
    const crop = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y0 + y) * side + x0 + x;
        const o = (y * w + x) * 3;
        if (owner[p] === i) source.copy(crop, o, p * 3, p * 3 + 3);
        else crop.set(key, o);
      }
    }
    const nw = Math.max(1, Math.min(inner.width, Math.floor(w * scale)));
    const nh = Math.max(1, Math.min(inner.height, Math.floor(h * scale)));
    const small = await sharp(crop, { raw: { width: w, height: h, channels: 3 } }).resize(nw, nh, { fit: "fill" }).raw().toBuffer();

    for (const p of pixels) rgb.set(key, p * 3);
    const nx = Math.min(Math.max(Math.round(cx - nw / 2), inner.x), inner.x + inner.width - nw);
    const ny = Math.min(Math.max(Math.round(cy - nh / 2), inner.y), inner.y + inner.height - nh);
    for (let y = 0; y < nh; y++) small.copy(rgb, ((ny + y) * side + nx) * 3, y * nw * 3, (y + 1) * nw * 3);
  }

  const image = await sharp(rgb, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
  return { image, scales, outlineDropped };
}

/**
 * 1 where a pixel of the square lies inside both `outline` (fractions of the square) and the
 * `inner` box, eroded by `margin` pixels so the part keeps clear of the outline's edge.
 */
async function outlineMask(outline: number[], side: number, inner: PageRect, margin: number): Promise<Uint8Array> {
  const points = [];
  for (let k = 0; k + 1 < outline.length; k += 2) points.push(`${outline[k] * side},${outline[k + 1] * side}`);
  const svg = `<svg width="${side}" height="${side}" xmlns="http://www.w3.org/2000/svg"><polygon points="${points.join(" ")}" fill="#fff"/></svg>`;
  const alpha = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer();
  let mask = new Uint8Array(side * side);
  for (let y = inner.y; y < inner.y + inner.height; y++) {
    for (let x = inner.x; x < inner.x + inner.width; x++) mask[y * side + x] = alpha[y * side + x] >= 128 ? 1 : 0;
  }
  // Erode by `margin` along rows, then columns (a square erosion).
  for (const [step, count, stride] of [[1, side, side], [side, side, 1]] as const) {
    const out = new Uint8Array(side * side);
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let run = 0;
      const runs = new Int32Array(side);
      for (let k = 0; k < side; k++) {
        run = mask[base + k * step] ? run + 1 : 0;
        runs[k] = run;
      }
      // A pixel survives when the run through it reaches `margin` pixels past it on both sides.
      for (let k = side - 1, after = 0; k >= 0; k--) {
        after = mask[base + k * step] ? after + 1 : 0;
        if (runs[k] > margin && after > margin) out[base + k * step] = 1;
      }
    }
    mask = out;
  }
  return mask;
}

/**
 * Share (0–1) of the model's painted pixels that belong to a part: blobs of paint touching a
 * part's box, however far they spill out of it. Paint that touches no box is stray, e.g. a
 * part drawn again in empty space. Unlike layoutFit, a part drawn bigger than its box still
 * counts, since shrinkPartsToBoxes fits it back in.
 */
export async function attachedFit(generated: Buffer, input: ModelInput): Promise<number> {
  const side = LAYOUT_CHECK_SIDE;
  const rgb = await sharp(generated).resize(side, side, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const isBg = backgroundMask(rgb, side, side, input.background);
  const owner = partOwners(isBg, side, input.layout.placements.map((p) => toPixels(p, side)), false);
  let painted = 0, attached = 0;
  for (let p = 0; p < isBg.length; p++) {
    if (isBg[p]) continue;
    painted++;
    if (owner[p] >= 0) attached++;
  }
  return painted === 0 ? 1 : attached / painted;
}

/** A blob counts as one part only if no other box holds more than this share of it. */
const SHRINK_SPLIT_SHARE = 0.1;

/**
 * Which box (index) each pixel of the square belongs to, or -1 for background and specks.
 * Connected blobs go whole to the box holding most of their pixels, or, with `nearby`, to the
 * nearest box within SHRINK_REACH when none does (else they stay -1). A blob spread over several boxes (two parts drawn
 * touching) is split pixel by pixel instead, each to its nearest box. Each part then takes
 * SHRINK_EDGE rings of the surrounding background-masked pixels, its blended outline.
 */
function partOwners(isBg: Uint8Array, side: number, boxes: PageRect[], nearby = true): Int32Array {
  const nearest = (x: number, y: number) => {
    let best = -1, bestD = Infinity;
    boxes.forEach((b, i) => {
      const d = Math.max(b.x - x, x - (b.x + b.width - 1), b.y - y, y - (b.y + b.height - 1), 0);
      if (d < bestD && d <= SHRINK_REACH * Math.max(b.width, b.height)) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const owner = new Int32Array(side * side).fill(-1);
  const seen = new Uint8Array(side * side);
  const blob: number[] = [];
  for (let start = 0; start < owner.length; start++) {
    if (isBg[start] || seen[start]) continue;
    blob.length = 0;
    blob.push(start);
    seen[start] = 1;
    for (let k = 0; k < blob.length; k++) {
      const p = blob[k], x = p % side;
      for (const q of [x > 0 ? p - 1 : -1, x < side - 1 ? p + 1 : -1, p - side, p + side]) {
        if (q < 0 || q >= owner.length || isBg[q] || seen[q]) continue;
        seen[q] = 1;
        blob.push(q);
      }
    }
    if (blob.length < SHRINK_MIN_BLOB) continue;
    const inside = boxes.map(() => 0);
    let sx = 0, sy = 0;
    for (const p of blob) {
      const x = p % side, y = (p - x) / side;
      sx += x;
      sy += y;
      boxes.forEach((b, i) => {
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) inside[i]++;
      });
    }
    const shared = inside.filter((n) => n > blob.length * SHRINK_SPLIT_SHARE).length > 1;
    if (shared) {
      for (const p of blob) owner[p] = nearest(p % side, Math.floor(p / side));
      continue;
    }
    const most = inside.indexOf(Math.max(...inside));
    const box = inside[most] > 0 ? most : nearby ? nearest(Math.round(sx / blob.length), Math.round(sy / blob.length)) : -1;
    for (const p of blob) owner[p] = box;
  }

  let frontier: number[] = [];
  for (let p = 0; p < owner.length; p++) if (owner[p] >= 0) frontier.push(p);
  for (let ring = 0; ring < SHRINK_EDGE; ring++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % side;
      for (const q of [x > 0 ? p - 1 : -1, x < side - 1 ? p + 1 : -1, p - side, p + side]) {
        if (q < 0 || q >= owner.length || owner[q] >= 0 || !isBg[q]) continue;
        owner[q] = owner[p];
        next.push(q);
      }
    }
    frontier = next;
  }
  return owner;
}

/** Painted pixels this close to a part's box (a fraction of the square) still count as inside, to allow for drift. */
const LAYOUT_MARGIN = 0.015;
/** Side of the downscaled copy the layout check measures. */
const LAYOUT_CHECK_SIDE = 512;

/**
 * Share (0–1) of the model's painted pixels that land inside a part's box. Muse Image
 * sometimes ignores the layout and draws a new one, moving and duplicating parts; good
 * pages score 0.9 or more, rearranged ones well under (0.64 and 0.10 on two real runs).
 */
export async function layoutFit(generated: Buffer, input: ModelInput): Promise<number> {
  const side = LAYOUT_CHECK_SIDE;
  const rgb = await sharp(generated).resize(side, side, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const isBg = backgroundMask(rgb, side, side, input.background);
  const margin = Math.round(LAYOUT_MARGIN * side);
  const inBox = new Uint8Array(side * side);
  for (const p of input.layout.placements) {
    const r = toPixels(p, side);
    const x0 = Math.max(0, r.x - margin), x1 = Math.min(side, r.x + r.width + margin);
    for (let y = Math.max(0, r.y - margin); y < Math.min(side, r.y + r.height + margin); y++) inBox.fill(1, y * side + x0, y * side + x1);
  }
  let painted = 0, inside = 0;
  for (let p = 0; p < isBg.length; p++) {
    if (isBg[p]) continue;
    painted++;
    inside += inBox[p];
  }
  return painted === 0 ? 1 : inside / painted;
}

/** The original page's parts drawn into the model's square as `layout` places them, for alignment. */
async function layoutPage(page: PageImage, layout: PartLayout, side: number): Promise<PageImage> {
  const parts = await Promise.all(
    layout.placements.map(async (p) => {
      const to = toPixels(p, side);
      const input = await sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
        .extract({ left: p.src.x, top: p.src.y, width: p.src.width, height: p.src.height })
        .resize(to.width, to.height, { fit: "fill" })
        .png()
        .toBuffer();
      return { input, left: to.x, top: to.y };
    }),
  );
  const rgba = await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts)
    .raw()
    .toBuffer();
  return { width: side, height: side, rgba };
}

/** Copies each part from the painted square back to its area on a page-sized image; the rest is background. */
async function unpackSquare(square: Buffer, side: number, layout: PartLayout, page: PageImage, background: Background): Promise<Buffer> {
  const out = Buffer.alloc(page.width * page.height * 3);
  const key = hexToRgb(background.hex);
  for (let i = 0; i < out.length; i += 3) out.set(key, i);
  for (const p of layout.placements) {
    const from = toPixels(p, side);
    const part = await sharp(square, { raw: { width: side, height: side, channels: 3 } })
      .extract({ left: from.x, top: from.y, width: from.width, height: from.height })
      .resize(p.src.width, p.src.height, { fit: "fill" })
      .raw()
      .toBuffer();
    for (let row = 0; row < p.src.height; row++) {
      const start = ((p.src.y + row) * page.width + p.src.x) * 3;
      part.copy(out, start, row * p.src.width * 3, (row + 1) * p.src.width * 3);
    }
  }
  return out;
}

/** Largest stretch (as a fraction) and shift (as a fraction of the page) the alignment tries. */
const ALIGN_MAX_SCALE = 0.08;
const ALIGN_MAX_SHIFT = 0.05;
const ALIGN_SCALE_STEP = 0.002;
/** In reshape mode, a part locates the drift only if its painted area is within this factor of the original… */
const ALIGN_SHAPE_TOLERANCE = 1.25;
/** …and both the original and the repainted part have at least this many pixels. */
const ALIGN_MIN_PART_PIXELS = 30;
/** Part centres must spread at least this share of the page along an axis to measure a stretch on it. */
const ALIGN_MIN_SPREAD = 0.1;

interface AxisFit {
  scale: number;
  offset: number;
}

/**
 * The model tends to stretch or shift its output a little (about 2% vertically on most
 * runs), so repainted parts land beside the original outlines. Finds the per-axis scale
 * and offset that undo it and resamples the repainted image.
 *
 * With `rects` null (outline kept), the parts keep their shapes, so the fit matches the
 * model's row and column coverage to the page's opaque pixels. With `rects` (reshape mode)
 * the model is meant to change shapes, and a grown part (ears, a hat) would drag a coverage
 * fit into stretching the whole page and pushing other parts out of their regions. There the
 * fit uses the centres of the parts that kept roughly their size, one vote each, and leaves
 * the image alone when too few qualify.
 */
function alignToPage(rgb: Buffer, page: PageImage, background: Background, rects: PageRect[] | null): Buffer {
  const isBg = backgroundMask(rgb, page.width, page.height, background);
  const fit = rects ? fitFromPartCentres(isBg, page, rects) : fitFromCoverage(isBg, page);
  if (!fit) return rgb;
  const { xs, ys } = fit;
  if (ys.scale === 1 && ys.offset === 0 && xs.scale === 1 && xs.offset === 0) return rgb;
  return resample(rgb, page.width, page.height, xs, ys);
}

function fitFromCoverage(isBg: Uint8Array, page: PageImage): { xs: AxisFit; ys: AxisFit } {
  const { width, height } = page;
  const genRows = new Float64Array(height), genCols = new Float64Array(width);
  const pageRows = new Float64Array(height), pageCols = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!isBg[p]) {
        genRows[y]++;
        genCols[x]++;
      }
      if (page.rgba[p * 4 + 3] >= 128) {
        pageRows[y]++;
        pageCols[x]++;
      }
    }
  }
  return { xs: fitAxis(pageCols, genCols), ys: fitAxis(pageRows, genRows) };
}

function fitFromPartCentres(isBg: Uint8Array, page: PageImage, rects: PageRect[]): { xs: AxisFit; ys: AxisFit } | null {
  const { width, height } = page;
  const parts: { px: number; py: number; gx: number; gy: number }[] = [];
  for (const r of rects) {
    let ax = 0, ay = 0, an = 0, gx = 0, gy = 0, gn = 0;
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.height, height); y++) {
      for (let x = Math.max(r.x, 0); x < Math.min(r.x + r.width, width); x++) {
        const p = y * width + x;
        if (page.rgba[p * 4 + 3] >= 128) {
          ax += x;
          ay += y;
          an++;
        }
        if (!isBg[p]) {
          gx += x;
          gy += y;
          gn++;
        }
      }
    }
    if (an < ALIGN_MIN_PART_PIXELS || gn < ALIGN_MIN_PART_PIXELS) continue;
    // A reshaped part's centre moves with its new shape, not with the drift.
    const ratio = gn / an;
    if (ratio > ALIGN_SHAPE_TOLERANCE || ratio < 1 / ALIGN_SHAPE_TOLERANCE) continue;
    parts.push({ px: ax / an, py: ay / an, gx: gx / gn, gy: gy / gn });
  }
  if (parts.length < 2) return null;
  return {
    xs: fitLine(parts.map((p) => p.px), parts.map((p) => p.gx), width),
    ys: fitLine(parts.map((p) => p.py), parts.map((p) => p.gy), height),
  };
}

/**
 * Least-squares `generated ≈ page * scale + offset` over part centres. Measures only a shift
 * when the parts sit too close together along this axis to tell a stretch apart, and makes no
 * change when the result moves anything further than the model plausibly drifts.
 */
function fitLine(page: number[], generated: number[], size: number): AxisFit {
  const n = page.length;
  const meanPage = page.reduce((a, b) => a + b, 0) / n;
  const meanGen = generated.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (page[i] - meanPage) ** 2;
    sxy += (page[i] - meanPage) * (generated[i] - meanGen);
  }
  const scale = Math.sqrt(sxx / n) >= size * ALIGN_MIN_SPREAD ? sxy / sxx : 1;
  const offset = meanGen - scale * meanPage;
  const largestMove = Math.max(Math.abs(offset), Math.abs((scale - 1) * (size - 1) + offset));
  if (Math.abs(scale - 1) > ALIGN_MAX_SCALE || largestMove > size * ALIGN_MAX_SHIFT) return { scale: 1, offset: 0 };
  return { scale, offset };
}

/** Bilinear resample: page pixel (x, y) comes from repainted pixel (x * xs.scale + xs.offset, y * ys.scale + ys.offset). */
function resample(rgb: Buffer, width: number, height: number, xs: AxisFit, ys: AxisFit): Buffer {
  const out = Buffer.alloc(rgb.length);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max(y * ys.scale + ys.offset, 0), height - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, height - 1), wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max(x * xs.scale + xs.offset, 0), width - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, width - 1), wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * width + x0) * 3 + c] * (1 - wx) + rgb[(y0 * width + x1) * 3 + c] * wx;
        const bottom = rgb[(y1 * width + x0) * 3 + c] * (1 - wx) + rgb[(y1 * width + x1) * 3 + c] * wx;
        out[(y * width + x) * 3 + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return out;
}

/**
 * Finds `scale` and `offset` so that `generated[i * scale + offset]` best matches
 * `target[i]`, by brute force over small stretches and shifts.
 */
function fitAxis(target: Float64Array, generated: Float64Array): AxisFit {
  const n = target.length;
  const maxShift = Math.round(n * ALIGN_MAX_SHIFT);
  const maxStep = Math.round(ALIGN_MAX_SCALE / ALIGN_SCALE_STEP);
  const errorOf = (scale: number, offset: number, limit: number) => {
    let error = 0;
    for (let i = 0; i < n && error < limit; i++) {
      const j = Math.round(i * scale + offset);
      error += Math.abs(target[i] - (j >= 0 && j < n ? generated[j] : 0));
    }
    return error;
  };
  // Start from no change, so a well-placed image is left alone unless something fits better.
  let best = { scale: 1, offset: 0 };
  let bestError = errorOf(1, 0, Infinity);
  for (let step = -maxStep; step <= maxStep; step++) {
    const scale = 1 + step * ALIGN_SCALE_STEP;
    for (let offset = -maxShift; offset <= maxShift; offset++) {
      const error = errorOf(scale, offset, bestError);
      if (error < bestError) {
        bestError = error;
        best = { scale, offset };
      }
    }
  }
  return best;
}

/** Per-channel tolerance; the model doesn't reproduce the key colour exactly. */
const BACKGROUND_TOLERANCE = 40;
/** How far (px) from the plain background a background-tinted pixel still counts as background. */
const TINT_REACH = 6;
/** A pixel is background-tinted when its hue lines up with the background's this closely (cosine)… */
const TINT_MIN_ALIGNMENT = 0.9;
/** …and it has at least this much colour (distance from its own grey level). */
const TINT_MIN_CHROMA = 10;

/**
 * Marks the model's background pixels: the plain background colour, plus the pixels
 * along part edges where the model blended the background with the part (e.g. dark
 * teal where a dark outline meets cyan). Those keep the background's hue but not its
 * brightness, so they're matched by hue, and only near plain background so parts
 * that happen to share the hue aren't touched.
 */
function backgroundMask(rgb: Buffer, width: number, height: number, background: Background): Uint8Array {
  const key = hexToRgb(background.hex);
  const keyMean = (key[0] + key[1] + key[2]) / 3;
  const keyChroma = key.map((c) => c - keyMean);
  const keyNorm = Math.hypot(...keyChroma);

  const isBg = new Uint8Array(width * height);
  const tinted = new Uint8Array(width * height);
  for (let p = 0; p < isBg.length; p++) {
    const i = p * 3;
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (Math.abs(r - key[0]) <= BACKGROUND_TOLERANCE && Math.abs(g - key[1]) <= BACKGROUND_TOLERANCE && Math.abs(b - key[2]) <= BACKGROUND_TOLERANCE) {
      isBg[p] = 1;
      continue;
    }
    const mean = (r + g + b) / 3;
    const cr = r - mean, cg = g - mean, cb = b - mean;
    const norm = Math.hypot(cr, cg, cb);
    if (norm >= TINT_MIN_CHROMA && (cr * keyChroma[0] + cg * keyChroma[1] + cb * keyChroma[2]) / (norm * keyNorm) >= TINT_MIN_ALIGNMENT) {
      tinted[p] = 1;
    }
  }

  // Grow from the plain background into neighbouring tinted pixels, one ring per pass.
  let frontier: number[] = [];
  for (let p = 0; p < isBg.length; p++) if (isBg[p]) frontier.push(p);
  for (let pass = 0; pass < TINT_REACH && frontier.length > 0; pass++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % width, y = (p - x) / width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q < 0 || isBg[q] || !tinted[q]) continue;
        isBg[q] = 1;
        next.push(q);
      }
    }
    frontier = next;
  }
  return isBg;
}

/** Share of the background colour (0–1) up to which a pixel is solid part… */
const KEY_SOLID = 0.25;
/** …and from which it's fully background; in between, the part's edge blended with it. */
const KEY_CLEAR = 0.85;

/**
 * Keys the background out of a repainted page: returns per-pixel alpha from how much
 * of the background colour each pixel holds, and removes that share of the colour
 * from the blended edge pixels in `rgb` so they don't keep a background-coloured rim.
 * The matte is shrunk by a pixel to drop the outermost blended ring, and anything
 * outside `rects` is cleared so a part can't spill into a neighbouring region.
 */
function keyOut(rgb: Buffer, width: number, height: number, background: Background, rects: PageRect[]): Uint8Array {
  const key = hexToRgb(background.hex);
  // The key's share is how far its full channels rise above its empty ones (pure cyan:
  // min(g, b) - r). Neutral and warm colours score near zero, so the parts stay solid.
  const full = [0, 1, 2].filter((c) => key[c] >= 192);
  const empty = [0, 1, 2].filter((c) => key[c] <= 64);
  const matte = new Float32Array(width * height);
  for (let p = 0; p < matte.length; p++) {
    const i = p * 3;
    let high = 255, low = 0;
    for (const c of full) high = Math.min(high, rgb[i + c]);
    for (const c of empty) low = Math.max(low, rgb[i + c]);
    const share = (high - low) / 255;
    const a = Math.min(Math.max(1 - (share - KEY_SOLID) / (KEY_CLEAR - KEY_SOLID), 0), 1);
    matte[p] = a;
    if (a > 0 && a < 1) {
      for (let c = 0; c < 3; c++) rgb[i + c] = Math.min(Math.max(Math.round((rgb[i + c] - (1 - a) * key[c]) / a), 0), 255);
    }
  }

  despillEdges(rgb, width, height, key, matte);

  const inRegion = new Uint8Array(width * height);
  for (const r of rects) {
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.height, height); y++) {
      inRegion.fill(1, y * width + Math.max(r.x, 0), y * width + Math.min(r.x + r.width, width));
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!inRegion[p]) continue;
      const a = Math.min(
        matte[p],
        x > 0 ? matte[p - 1] : 0,
        x < width - 1 ? matte[p + 1] : 0,
        y > 0 ? matte[p - width] : 0,
        y < height - 1 ? matte[p + width] : 0,
      );
      alpha[p] = Math.round(a * 255);
    }
  }
  return alpha;
}

/** How far (px) into a part from the background its edge colours are despilled. */
const DESPILL_REACH = 4;

/**
 * The model paints dark outlines that fade into the background (black into cyan comes
 * out dark teal), which keying leaves solid. Within DESPILL_REACH of the background,
 * removes the key's tint: the amount by which the key's full channels rise above its
 * empty ones is taken off along the key's own colour, so dark teal goes back to dark
 * grey. Parts' insides are left alone, so a teal or blue part keeps its colour.
 */
function despillEdges(rgb: Buffer, width: number, height: number, key: [number, number, number], matte: Float32Array) {
  const keyMin = Math.min(...key), keyMax = Math.max(...key);
  const weight = key.map((c) => (c - keyMin) / (keyMax - keyMin));
  const full = [0, 1, 2].filter((c) => weight[c] >= 0.75);
  const empty = [0, 1, 2].filter((c) => weight[c] <= 0.25);

  const reached = new Uint8Array(width * height);
  let frontier: number[] = [];
  for (let p = 0; p < matte.length; p++) {
    if (matte[p] < 1) {
      reached[p] = 1;
      frontier.push(p);
    }
  }
  for (let pass = 0; pass < DESPILL_REACH && frontier.length > 0; pass++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % width, y = (p - x) / width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q < 0 || reached[q]) continue;
        reached[q] = 1;
        next.push(q);
      }
    }
    frontier = next;
  }

  for (let p = 0; p < reached.length; p++) {
    if (!reached[p] || matte[p] === 0) continue;
    const i = p * 3;
    let high = 255, low = 0;
    for (const c of full) high = Math.min(high, rgb[i + c]);
    for (const c of empty) low = Math.max(low, rgb[i + c]);
    const spill = high - low;
    if (spill <= 0) continue;
    for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, Math.round(rgb[i + c] - spill * weight[c]));
  }
}

/**
 * The model's parts can land a few pixels inside the original outlines, which would
 * leave a background-coloured halo once the original alpha is applied. Grows the surrounding
 * repainted colour over every background pixel the page shows (alpha > 0), one pixel ring
 * per pass, until none are left. Pixels the page hides are skipped; their colour is dropped.
 */
function fillBackgroundBleed(rgb: Buffer, page: PageImage, background: Background) {
  const { width, height } = page;
  const isBg = backgroundMask(rgb, width, height, background);
  // Soft edges were blended with the background before the model saw them, so they
  // come back tinted with it; replace them too.
  for (let p = 0; p < isBg.length; p++) if (page.rgba[p * 4 + 3] < 255) isBg[p] = 1;
  const needsFill = (p: number) => isBg[p] === 1 && page.rgba[p * 4 + 3] > 0;

  let frontier: number[] = [];
  for (let p = 0; p < isBg.length; p++) if (needsFill(p)) frontier.push(p);
  while (frontier.length > 0) {
    const filled: number[] = [];
    const waiting: number[] = [];
    for (const p of frontier) {
      const x = p % width, y = (p - x) / width;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (isBg[q]) continue;
          r += rgb[q * 3];
          g += rgb[q * 3 + 1];
          b += rgb[q * 3 + 2];
          n++;
        }
      }
      if (n === 0) {
        waiting.push(p);
        continue;
      }
      rgb[p * 3] = Math.round(r / n);
      rgb[p * 3 + 1] = Math.round(g / n);
      rgb[p * 3 + 2] = Math.round(b / n);
      filled.push(p);
    }
    // Nothing repainted can reach what's left (the model dropped the whole part): fall
    // back to the original page's colours rather than leave the background showing.
    if (filled.length === 0) {
      for (const p of waiting) rgb.set(page.rgba.subarray(p * 4, p * 4 + 3), p * 3);
      break;
    }
    for (const p of filled) isBg[p] = 0;
    frontier = waiting;
  }
}
