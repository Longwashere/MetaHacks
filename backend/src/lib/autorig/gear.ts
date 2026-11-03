import { decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import sharp from "sharp";
import { aiFetch } from "../ai-fetch.js";
import { META_API_BASE_URL } from "../config.js";
import { apiKey, getPath, logPrompt } from "../meta.js";
import type { CallRecord, RigTrace } from "./trace.js";
import type { Cutout } from "./types.js";

// Gear masks for slicing (AUTO_RIG_PLAN.md, "Gear masks with SAM 3.1"). Slicing gives each pixel to
// its nearest bone, which cuts capes, pauldrons and kneepads wherever the distances fall. Muse Spark
// names the character's gear when it places the joints, SAM 3.1 finds each piece (one call per
// phrase, all at once), and the slicer keeps every piece whole on the part it goes with. A cape
// (goesWith "cape") becomes its own piece with its own bones. The masks are found while preparing
// and saved with the pose (saveGearMasks), so the joint editor's cut preview and the build use them.

export const SAM_MODEL = "sam-3.1";
/** Body parts a piece of gear can go with; sided ones are matched to a side by position. */
export const GEAR_PARTS = ["head", "torso", "upper_arm", "forearm", "hand", "thigh", "shin", "foot", "cape"] as const;
export type GearPart = (typeof GEAR_PARTS)[number];

export interface GearItem {
  /** A short noun phrase for SAM, such as "red cape" or "knee pad". */
  phrase: string;
  goesWith: GearPart;
}

export interface GearMask {
  phrase: string;
  goesWith: GearPart;
  confidence: number | undefined;
  /** Per cutout pixel: 1 inside the match. */
  mask: Uint8Array;
}

export const MAX_GEAR = 6;
const MAX_PHRASE_LENGTH = 40;
/**
 * Plain names SAM knows, tried when a pad's own phrase finds nothing ("knee armor" missed both
 * kneepads that "knee pad" found).
 */
const FALLBACK: Partial<Record<GearPart, string>> = { upper_arm: "shoulder pad", forearm: "elbow pad", shin: "knee pad" };
/** Always looked for, so the wrist cut follows the cuff. */
const ALWAYS: GearItem = { phrase: "hand", goesWith: "hand" };
const SAM_TIMEOUT_MS = 60_000;
/** Matches below this confidence are dropped (a partial pauldron came back at 0.63, a clean plume at 0.54). */
const MIN_CONFIDENCE = 0.5;
/** Matches smaller or larger than these shares of the character's pixels are dropped. */
const MIN_SHARE = 0.003;
const MAX_SHARE = 0.4;

/** Gear items from untrusted input (Spark's reply or the page): valid, deduplicated, at most MAX_GEAR. */
export function cleanGear(value: unknown): GearItem[] {
  if (!Array.isArray(value)) return [];
  const out: GearItem[] = [];
  for (const v of value) {
    const phrase = typeof v?.phrase === "string" ? v.phrase.trim().toLowerCase().replace(/\s+/g, " ") : "";
    const goesWith = v?.goesWith;
    if (!phrase || phrase.length > MAX_PHRASE_LENGTH || !/^[a-z0-9 '-]+$/.test(phrase)) continue;
    if (!GEAR_PARTS.includes(goesWith)) continue;
    if (phrase === ALWAYS.phrase || out.some((g) => g.phrase === phrase)) continue;
    out.push({ phrase, goesWith });
    if (out.length === MAX_GEAR) break;
  }
  return out;
}

/** SAM 3.1's masks for the gear (plus hands), checked for confidence and size. A failed phrase is skipped. */
export async function gearMasks(cut: Cutout, gear: GearItem[], signal: AbortSignal, trace?: RigTrace): Promise<GearMask[]> {
  // SAM sees the character on white, at the cutout's size, so its masks line up pixel for pixel.
  const png = await sharp(cut.rgba, { raw: { width: cut.width, height: cut.height, channels: 4 } }).flatten({ background: "#ffffff" }).png().toBuffer();
  let solid = 0;
  for (let p = 0; p < cut.width * cut.height; p++) if (cut.rgba[p * 4 + 3] >= 128) solid++;

  const items = [ALWAYS, ...gear];
  const find = (phrase: string) => segment(png, cut.width, cut.height, phrase, signal, trace);
  const calls = await Promise.allSettled(items.map((g) => find(g.phrase)));
  // A pad whose phrase found nothing gets one more try under its plain name.
  const retries = items.filter((g, i) => {
    const fallback = FALLBACK[g.goesWith];
    const call = calls[i];
    return call.status === "fulfilled" && !call.value.length && fallback && !items.some((other) => other.phrase === fallback);
  });
  const retried = retries.map((g) => ({ phrase: FALLBACK[g.goesWith]!, goesWith: g.goesWith }));
  const uniqueRetries = retried.filter((g, i) => retried.findIndex((o) => o.phrase === g.phrase) === i);
  items.push(...uniqueRetries);
  calls.push(...(await Promise.allSettled(uniqueRetries.map((g) => find(g.phrase)))));

  const masks: GearMask[] = [];
  const checked: { phrase: string; confidence?: number; share: number; kept: boolean }[] = [];
  calls.forEach((call, i) => {
    if (call.status === "rejected") {
      if (signal.aborted) throw call.reason;
      console.error(`[autorig] SAM "${items[i].phrase}" failed`, call.reason);
      return;
    }
    for (const m of call.value) {
      const share = m.pixels / Math.max(1, solid);
      const kept = (m.confidence === undefined || m.confidence >= MIN_CONFIDENCE) && share >= MIN_SHARE && share <= MAX_SHARE;
      console.log(`[autorig] SAM "${items[i].phrase}": conf ${m.confidence?.toFixed(2) ?? "-"}, ${(share * 100).toFixed(1)}% of the character${kept ? "" : " (dropped)"}`);
      checked.push({ phrase: items[i].phrase, confidence: m.confidence, share: Math.round(share * 1000) / 1000, kept });
      if (kept) masks.push({ phrase: items[i].phrase, goesWith: items[i].goesWith, confidence: m.confidence, mask: m.mask });
    }
  });
  trace?.set("gearMasks", checked);
  return masks;
}

export interface SamMatch {
  /** Half-open pixel box: left, top, right, bottom. */
  box: [number, number, number, number];
  confidence: number | undefined;
  pixels: number;
  /** Per image pixel: 1 inside the match. */
  mask: Uint8Array;
}

/** One SAM 3.1 call: every match of `phrase` in a PNG of `width` × `height`. */
export async function segment(png: Buffer, width: number, height: number, phrase: string, signal: AbortSignal, trace?: RigTrace): Promise<SamMatch[]> {
  if (trace) return trace.call("gear", SAM_MODEL, phrase, (record) => segmentOnce(png, width, height, phrase, signal, record));
  return segmentOnce(png, width, height, phrase, signal, {});
}

async function segmentOnce(png: Buffer, width: number, height: number, phrase: string, signal: AbortSignal, record: CallRecord): Promise<SamMatch[]> {
  logPrompt(`responses (${SAM_MODEL}) auto-rig gear`, phrase);
  const res = await aiFetch(`${META_API_BASE_URL}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: SAM_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: phrase },
            { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
          ],
        },
      ],
      metadata: { include_confidence: "true" },
    }),
    timeoutMs: SAM_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) throw new Error(`SAM failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json: unknown = await res.json();
  record.usage = getPath(json, ["usage"]);
  console.log(`[meta] auto-rig gear "${phrase}" (${SAM_MODEL}) usage: ${JSON.stringify(getPath(json, ["usage"]))}`);
  const output = getPath(json, ["output"]);
  const text = (Array.isArray(output) ? output : [])
    .flatMap((item: unknown) => {
      const content = getPath(item, ["content"]);
      return Array.isArray(content) ? content : [];
    })
    .map((c: unknown) => getPath(c, ["text"]))
    .filter((s): s is string => typeof s === "string")
    .join("");

  // The reply isn't streamed; hand the parser its text as one finished lane.
  async function* events(): AsyncIterable<ResponsesEvent> {
    yield { type: "response.output_text.done", item_id: "sam", output_index: 0, content_index: 0, text };
    yield { type: "response.completed" };
  }
  const result = await parseImageStream(events()).finalResult;
  const boxes = new Map(recordsOfKind(result.records, "box").map((b) => [b.objectId, b]));
  const matches = recordsOfKind(result.records, "mask").map((m): SamMatch => {
    const raster = decodeMaskToRaster(m.mask);
    const { left, top, right, bottom } = m.bounds;
    const mask = new Uint8Array(width * height);
    let pixels = 0;
    // The raster covers the record's box; scale it there in case it's stored smaller.
    for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
        const ry = Math.min(m.mask.height - 1, Math.floor(((y - top) * m.mask.height) / (bottom - top)));
        const rx = Math.min(m.mask.width - 1, Math.floor(((x - left) * m.mask.width) / (right - left)));
        if (raster[ry * m.mask.width + rx]) {
          mask[y * width + x] = 1;
          pixels++;
        }
      }
    }
    return { box: [left, top, right, bottom], confidence: m.confidence ?? boxes.get(m.objectId)?.confidence, pixels, mask };
  });
  record.detail = {
    matches: matches.map((m) => ({ box: m.box, confidence: m.confidence, pixels: m.pixels })),
    ...(result.diagnostics.length ? { diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`) } : {}),
  };
  return matches;
}

/** Masks saved with a pose: their details as JSON, and the masks as bits of one RGBA PNG (up to 32). */
const MAX_SAVED_MASKS = 32;

export async function saveGearMasks(save: (name: string, body: Buffer | string) => Promise<unknown>, masks: GearMask[], width: number, height: number): Promise<void> {
  const kept = masks.slice(0, MAX_SAVED_MASKS);
  const bits = Buffer.alloc(width * height * 4);
  kept.forEach((m, i) => {
    const [channel, bit] = [Math.floor(i / 8), 1 << i % 8];
    for (let p = 0; p < m.mask.length; p++) if (m.mask[p]) bits[p * 4 + channel] |= bit;
  });
  const png = await sharp(bits, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await Promise.all([save("gear.json", JSON.stringify(kept.map(({ phrase, goesWith, confidence }) => ({ phrase, goesWith, confidence })))), save("gear.png", png)]);
}

export async function loadGearMasks(load: (name: string) => Promise<Buffer>): Promise<GearMask[]> {
  const [details, png] = await Promise.all([load("gear.json"), load("gear.png")]);
  const items = JSON.parse(details.toString("utf8")) as { phrase: string; goesWith: GearPart; confidence?: number }[];
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return items.map((item, i) => {
    const [channel, bit] = [Math.floor(i / 8), 1 << i % 8];
    const mask = new Uint8Array(info.width * info.height);
    for (let p = 0; p < mask.length; p++) if (data[p * 4 + channel] & bit) mask[p] = 1;
    return { ...item, confidence: item.confidence, mask };
  });
}
