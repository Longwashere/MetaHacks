import sharp from "sharp";
import type { PageRect } from "./atlas.js";
import { type PartLayout, toPixels } from "./layout.js";

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
 * the parts stay where they were.
 */
export async function toModelInput(page: PageImage, side: number, background: Background, layout: PartLayout): Promise<ModelInput> {
  const flat = await sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
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
): Promise<Buffer> {
  const { side, layout } = input;
  const square = await sharp(generated).resize(side, side, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const original = await layoutPage(page, layout, side);
  const alignedSquare = alignToPage(square, original, input.background);
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

/**
 * The model tends to stretch or shift its output a little, so repainted parts land
 * beside the original outlines and the background shows through along one edge.
 * Finds the per-axis scale and offset that best line up the model's parts with the
 * page's opaque pixels (matching row and column coverage profiles) and resamples
 * the repainted image to undo it.
 */
function alignToPage(rgb: Buffer, page: PageImage, background: Background): Buffer {
  const { width, height } = page;
  const isBg = backgroundMask(rgb, width, height, background);
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
  const ys = fitAxis(pageRows, genRows);
  const xs = fitAxis(pageCols, genCols);
  if (ys.scale === 1 && ys.offset === 0 && xs.scale === 1 && xs.offset === 0) return rgb;

  // Bilinear resample: page pixel (x, y) comes from repainted pixel (x * sx + tx, y * sy + ty).
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
function fitAxis(target: Float64Array, generated: Float64Array): { scale: number; offset: number } {
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
