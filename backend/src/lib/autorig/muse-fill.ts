import sharp from "sharp";
import { imageEdit } from "./pose.js";
import type { PackedRegion } from "./slice.js";
import type { RigTrace } from "./trace.js";
import type { Cutout } from "./types.js";

// Muse Image paints the hidden areas of a sliced rig (AUTO_RIG_PLAN.md, "Slicing"). The code fill
// smears colour there, which Muse can't tell from art, so the sheet it gets has every hidden area
// painted one flat marker colour the character doesn't use, on a magenta background. Muse redraws
// the whole sheet (`/images/edits` has no mask), so only its pixels inside the hidden areas are
// kept: each piece is lined up with Muse's redraw on its own pixels, and a hidden pixel takes
// Muse's colour only if that colour already occurs in the piece's own art. That rejects what Muse
// left marker- or background-coloured, and the marker tint it bleeds into what it paints (dark
// green cloth on a black knight). The rest of the art is never replaced, and anything Muse doesn't
// paint keeps the smear.

type Rgb = [number, number, number];

const BACKGROUND: Rgb = [255, 0, 255];
/** Marker candidates, most distinct from the magenta background first. */
const MARKERS: { name: string; rgb: Rgb }[] = [
  { name: "green (#00FF00)", rgb: [0, 255, 0] },
  { name: "cyan (#00FFFF)", rgb: [0, 255, 255] },
  { name: "yellow (#FFFF00)", rgb: [255, 255, 0] },
  { name: "blue (#0000FF)", rgb: [0, 0, 255] },
];
/** A colour this close to the marker or background (RGB distance) counts as left unpainted. */
const UNPAINTED = 110;
/** How far a piece may have moved in Muse's redraw, in page pixels. */
const MAX_SHIFT = 16;
/** A piece whose own pixels differ from Muse's by more than this on average (0–441) is skipped. */
const MAX_MISMATCH = 90;

export interface MuseFillResult {
  page: Cutout;
  marker: string;
  pieces: { name: string; dx: number; dy: number; mismatch: number; hidden: number; painted: number }[];
  /** The sheet sent to Muse and its reply, for logs. */
  sheet: Buffer;
  reply: Buffer;
}

export async function museFillHidden(page: Cutout, regions: PackedRegion[], hidden: Uint8Array, signal: AbortSignal, trace?: RigTrace): Promise<MuseFillResult> {
  const { width: w, height: h, rgba } = page;
  const marker = pickMarker(page, hidden);

  // The sheet: art over magenta, hidden areas in flat marker colour, padded to a square.
  const side = Math.max(w, h);
  const sheet = Buffer.alloc(side * side * 3);
  for (let i = 0; i < side * side; i++) sheet.set(BACKGROUND, i * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = (y * side + x) * 3;
      const a = rgba[p * 4 + 3] / 255;
      if (hidden[p]) sheet.set(marker.rgb, o);
      else if (a > 0) for (let c = 0; c < 3; c++) sheet[o + c] = Math.round(rgba[p * 4 + c] * a + BACKGROUND[c] * (1 - a));
    }
  }
  const sheetPng = await sharp(sheet, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
  const reply = await imageEdit(sheetPng, fillPrompt(marker.name, regions, side), "fill", signal, trace, "fill");
  const out = await sharp(reply).removeAlpha().resize(side, side).raw().toBuffer();

  const result = Buffer.from(rgba);
  const pieces: MuseFillResult["pieces"] = [];
  for (const r of regions) {
    // Line the piece up on its own (not hidden, solid) pixels.
    const samples: number[] = [];
    let hiddenCount = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const p = y * w + x;
        if (hidden[p]) hiddenCount++;
        else if (rgba[p * 4 + 3] >= 250 && (x + y) % 3 === 0) samples.push(p);
      }
    }
    if (!hiddenCount) continue;
    let best = { dx: 0, dy: 0, mismatch: Infinity };
    for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
      for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
        let sum = 0;
        let n = 0;
        for (const p of samples) {
          const x = (p % w) + dx;
          const y = Math.floor(p / w) + dy;
          if (x < 0 || y < 0 || x >= side || y >= side) continue;
          const o = (y * side + x) * 3;
          sum += Math.hypot(out[o] - rgba[p * 4], out[o + 1] - rgba[p * 4 + 1], out[o + 2] - rgba[p * 4 + 2]);
          n++;
        }
        const mismatch = n ? sum / n : Infinity;
        if (mismatch < best.mismatch) best = { dx, dy, mismatch };
      }
    }
    let painted = 0;
    if (best.mismatch <= MAX_MISMATCH) {
      const palette = piecePalette(page, hidden, r);
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          const p = y * w + x;
          if (!hidden[p]) continue;
          const sx = x + best.dx;
          const sy = y + best.dy;
          if (sx < 0 || sy < 0 || sx >= side || sy >= side) continue;
          const o = (sy * side + sx) * 3;
          const c: Rgb = [out[o], out[o + 1], out[o + 2]];
          if (distance(c, marker.rgb) < UNPAINTED || distance(c, BACKGROUND) < UNPAINTED || !palette(c)) continue;
          result.set(c, p * 4);
          painted++;
        }
      }
    }
    pieces.push({ name: r.name, dx: best.dx, dy: best.dy, mismatch: Math.round(best.mismatch), hidden: hiddenCount, painted });
  }
  return { page: { width: w, height: h, rgba: result }, marker: marker.name, pieces, sheet: sheetPng, reply };
}

function fillPrompt(marker: string, regions: PackedRegion[], side: number): string {
  const where = (r: PackedRegion) => `${Math.round(((r.x + r.width / 2) / side) * 100)}% from the left, ${Math.round(((r.y + r.height / 2) / side) * 100)}% from the top`;
  const pieces = regions.map((r) => `- ${describe(r.name)} (around ${where(r)})`).join("\n");
  return (
    "This is a sprite sheet of the separate body pieces of one 2D game character, cut apart for skeletal animation, on a flat magenta (#FF00FF) background. " +
    `Where one piece was covered by another at a joint, that hidden area is painted flat ${marker}. ` +
    `Paint over every flat ${marker} area with what that same piece would look like there: continue its own armour, cloth, skin or fur, ` +
    "matching its outline, art style, line work and lighting, so the piece looks whole. " +
    "Each area belongs to the piece it touches; never paint a face, head, hand or another body part into it. " +
    "Do not move, resize or redraw any piece, keep everything that isn't the marker colour exactly as it is, and keep the background flat magenta.\n" +
    `The pieces:\n${pieces}`
  );
}

function describe(name: string): string {
  const side = name.endsWith("_l") ? "left " : name.endsWith("_r") ? "right " : "";
  const part = name.replace(/_[lr]$/, "").replace("_", " ");
  const under: Record<string, string> = {
    torso: "the torso; its marked areas are the neck, shoulders and hips under the head, arms and legs, so continue the torso's clothing or armour there",
    head: "the head",
    "upper arm": "the upper arm; its marked area is the elbow end",
    forearm: "the forearm; its marked area is the wrist end",
    hand: "the hand",
    thigh: "the thigh; its marked area is the top of the leg under the hips",
    shin: "the shin; its marked area is the knee end",
    foot: "the foot; its marked area is the ankle",
  };
  return `${side}${under[part] ?? part}`.replace(/^(left |right )the /, "the $1");
}

/** Bins per channel when matching a colour against a piece's own art. */
const PALETTE_BINS = 16;

/** Whether a colour (within a bin) occurs in the piece's own solid pixels. */
function piecePalette(page: Cutout, hidden: Uint8Array, r: PackedRegion): (c: Rgb) => boolean {
  const bin = (v: number) => Math.min(PALETTE_BINS - 1, Math.floor((v * PALETTE_BINS) / 256));
  const seen = new Uint8Array(PALETTE_BINS ** 3);
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const p = y * page.width + x;
      if (hidden[p] || page.rgba[p * 4 + 3] < 250) continue;
      const [br, bg, bb] = [bin(page.rgba[p * 4]), bin(page.rgba[p * 4 + 1]), bin(page.rgba[p * 4 + 2])];
      // Mark the neighbouring bins too, so shading between the art's own colours passes.
      for (let dr = -1; dr <= 1; dr++)
        for (let dg = -1; dg <= 1; dg++)
          for (let db = -1; db <= 1; db++) {
            const [nr, ng, nb] = [br + dr, bg + dg, bb + db];
            if (nr >= 0 && ng >= 0 && nb >= 0 && nr < PALETTE_BINS && ng < PALETTE_BINS && nb < PALETTE_BINS) seen[(nr * PALETTE_BINS + ng) * PALETTE_BINS + nb] = 1;
          }
    }
  }
  return (c) => seen[(bin(c[0]) * PALETTE_BINS + bin(c[1])) * PALETTE_BINS + bin(c[2])] === 1;
}

/** The marker colour the character's art uses least. */
function pickMarker(page: Cutout, hidden: Uint8Array): { name: string; rgb: Rgb } {
  const near = MARKERS.map(() => 0);
  for (let p = 0; p < hidden.length; p += 2) {
    if (hidden[p] || page.rgba[p * 4 + 3] < 128) continue;
    const c: Rgb = [page.rgba[p * 4], page.rgba[p * 4 + 1], page.rgba[p * 4 + 2]];
    MARKERS.forEach((m, i) => {
      if (distance(c, m.rgb) < 160) near[i]++;
    });
  }
  return MARKERS[near.indexOf(Math.min(...near))];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
