import * as spine from "@esotericsoftware/spine-core";
import sharp from "sharp";
import type { PageImage } from "./textures.js";

// Draws a rig at rest from its skeleton JSON, atlas and page images, so Muse Spark can
// look at the assembled character (the checks and the tweak step in remix.ts). Spine-core places
// every attachment; the triangles are textured here in software, since sharp can't draw them.

/** Longest side of the rendered image. */
const RENDER_SIDE = 768;
/** Empty border around the character, as a share of RENDER_SIDE. */
const MARGIN = 0.04;
const QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0];

/** Slot colour times attachment colour, 0–1 per channel. */
interface Tint {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * The rig loaded and posed at rest: its "normal" (else first) named skin over the default one, at
 * frame 0 of its idle animation (else its first one), as a game would first show it. Null when the
 * skeleton can't be read with this atlas (e.g. an older Spine version). `skeletonFile` is a .json
 * or binary .skel file.
 */
export function loadRig(skeletonFile: Buffer | string, binary: boolean, atlasText: string): spine.Skeleton | null {
  try {
    const atlas = new spine.TextureAtlas(atlasText);
    const loader = new spine.AtlasAttachmentLoader(atlas);
    const data = binary
      ? new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(Buffer.from(skeletonFile)))
      : new spine.SkeletonJson(loader).readSkeletonData(skeletonFile.toString("utf8"));
    const skeleton = new spine.Skeleton(data);
    // Rigs like the goblins keep the body in named skins; the default skin still fills in the rest.
    const named = data.skins.filter((s) => s !== data.defaultSkin && s.getAttachments().length > 0);
    const skin = named.find((s) => /normal|base|default/i.test(s.name)) ?? named[0];
    if (skin) skeleton.setSkin(skin);
    skeleton.setToSetupPose();
    // Many setup poses are a heap of parts the animations sort out.
    const pose = data.animations.find((a) => /idle/i.test(a.name)) ?? data.animations[0];
    pose?.apply(skeleton, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    skeleton.updateWorldTransform(spine.Physics.update);
    return skeleton;
  } catch (error) {
    console.warn("Couldn't load the skeleton to render it", error);
    return null;
  }
}

/** A drawn part: its slot, the atlas region it shows, and its middle in the image, in pixels. */
export interface DrawnPart {
  slot: string;
  region: string;
  x: number;
  y: number;
}

/**
 * Where a slot's pixels landed, whether or not later parts cover them: their count, middle and
 * bounds in image pixels, and a mask at MASK_STEP resolution (1 where the part is mostly opaque).
 */
export interface PartCoverage {
  count: number;
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  mask: Uint8Array;
}

export interface Drawing {
  png: Buffer;
  width: number;
  height: number;
  /** Longest side of the drawn character in skeleton units; tweak moves are a share of it. */
  rigSize: number;
  /** Image pixels per skeleton unit. */
  pxPerUnit: number;
  parts: DrawnPart[];
  /** Per slot, with `measure` (see drawRig). */
  coverage: Map<string, PartCoverage>;
}

/** Pixels per mask cell side, so coverage masks stay small. */
export const MASK_STEP = 2;
/** Alpha above which a pixel counts as covered by its part. */
const COVER_ALPHA = 0.5;

export interface DrawOptions {
  /** Numbers drawn on each listed slot's middle. */
  tags?: Map<string, number>;
  /** Slots whose tags are drawn orange (e.g. parts with a measured fix). */
  highlight?: Set<string>;
  /** Record each slot's coverage (Drawing.coverage). */
  measure?: boolean;
}

/**
 * Draws a posed rig (see loadRig) as a PNG on a solid `background` (hex). `pages` are straight
 * alpha (see decodePage). Null when nothing is drawn.
 *
 * The image's scale and offset come from the attachments' vertices, so two rigs with the same
 * skeleton and pose (an original and its untweaked remix) are drawn in the same place, pixel for
 * pixel, and their coverage can be compared.
 */
export async function drawRig(
  skeleton: spine.Skeleton,
  pages: { name: string; image: PageImage }[],
  background: string,
  { tags, highlight, measure = false }: DrawOptions = {},
): Promise<Drawing | null> {
  const byName = new Map(pages.map((p) => [p.name, p.image]));
  const meshes: { slot: string; region: string; image: PageImage; vertices: number[]; uvs: ArrayLike<number>; triangles: number[]; color: Tint }[] = [];
  for (const slot of skeleton.drawOrder) {
    if (!slot.bone.active) continue;
    const att = slot.getAttachment();
    let vertices: number[];
    let triangles: number[];
    if (att instanceof spine.RegionAttachment) {
      vertices = new Array<number>(8);
      att.computeWorldVertices(slot, vertices, 0, 2);
      triangles = QUAD_TRIANGLES;
    } else if (att instanceof spine.MeshAttachment) {
      vertices = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(slot, 0, att.worldVerticesLength, vertices, 0, 2);
      triangles = att.triangles;
    } else continue;
    const region = att.region instanceof spine.TextureAtlasRegion ? att.region : null;
    const page = region ? byName.get(region.page.name) : undefined;
    if (!region || !page) continue;
    const color = { r: slot.color.r * att.color.r, g: slot.color.g * att.color.g, b: slot.color.b * att.color.b, a: slot.color.a * att.color.a };
    if (color.a <= 0) continue;
    meshes.push({ slot: slot.data.name, region: region.name, image: page, vertices, uvs: att.uvs, triangles, color });
  }
  if (meshes.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { vertices } of meshes) {
    for (let i = 0; i < vertices.length; i += 2) {
      minX = Math.min(minX, vertices[i]);
      maxX = Math.max(maxX, vertices[i]);
      minY = Math.min(minY, vertices[i + 1]);
      maxY = Math.max(maxY, vertices[i + 1]);
    }
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  if (!(spanX > 0 && spanY > 0)) return null;
  const scale = (RENDER_SIDE * (1 - 2 * MARGIN)) / Math.max(spanX, spanY);
  const width = Math.max(1, Math.round(spanX * scale + 2 * MARGIN * RENDER_SIDE));
  const height = Math.max(1, Math.round(spanY * scale + 2 * MARGIN * RENDER_SIDE));
  const pad = MARGIN * RENDER_SIDE;
  // Spine's y axis points up; the image's points down.
  const toScreen = (x: number, y: number): [number, number] => [pad + (x - minX) * scale, pad + (maxY - y) * scale];

  const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = br;
    out[i + 1] = bg;
    out[i + 2] = bb;
    out[i + 3] = 255;
  }
  const parts: DrawnPart[] = [];
  const coverage = new Map<string, PartCoverage>();
  const maskW = Math.ceil(width / MASK_STEP), maskH = Math.ceil(height / MASK_STEP);
  for (const m of meshes) {
    let cover: PartCoverage | undefined;
    if (measure) {
      cover = coverage.get(m.slot);
      if (!cover) {
        cover = { count: 0, cx: 0, cy: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, mask: new Uint8Array(maskW * maskH) };
        coverage.set(m.slot, cover);
      }
    }
    for (let t = 0; t < m.triangles.length; t += 3) {
      const corners = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]].map((v) => ({
        p: toScreen(m.vertices[v * 2], m.vertices[v * 2 + 1]),
        u: m.uvs[v * 2],
        v: m.uvs[v * 2 + 1],
      }));
      drawTriangle(out, width, height, m.image, corners, m.color, cover && { cover, maskW });
    }
    let sx = 0, sy = 0;
    for (let i = 0; i < m.vertices.length; i += 2) {
      sx += m.vertices[i];
      sy += m.vertices[i + 1];
    }
    const n = m.vertices.length / 2;
    const [x, y] = toScreen(sx / n, sy / n);
    parts.push({ slot: m.slot, region: m.region, x: Math.round(x), y: Math.round(y) });
  }

  for (const c of coverage.values()) {
    if (c.count === 0) continue;
    c.cx /= c.count;
    c.cy /= c.count;
  }

  let image = sharp(out, { raw: { width, height, channels: 4 } });
  if (tags && tags.size > 0) {
    const labels = parts.flatMap((p) => {
      const n = tags.get(p.slot);
      if (n === undefined) return [];
      const w = 10 + 8 * String(n).length;
      return [
        `<rect x="${p.x - w / 2}" y="${p.y - 9}" width="${w}" height="18" rx="4" fill="${highlight?.has(p.slot) ? "#d9480f" : "#000"}" fill-opacity="0.8"/>`,
        `<text x="${p.x}" y="${p.y + 5}" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text>`,
      ];
    });
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels.join("")}</svg>`;
    image = sharp(await image.png().toBuffer()).composite([{ input: Buffer.from(svg) }]);
  }
  return { png: await image.png().toBuffer(), width, height, rigSize: Math.max(spanX, spanY), pxPerUnit: scale, parts, coverage };
}

/**
 * The rig at rest (see loadRig) as a PNG on a solid `background` (hex), or null when the skeleton
 * can't be read with this atlas or draws nothing.
 */
export async function renderRestPose(
  skeletonFile: Buffer | string,
  binary: boolean,
  atlasText: string,
  pages: { name: string; image: PageImage }[],
  background: string,
): Promise<Buffer | null> {
  const skeleton = loadRig(skeletonFile, binary, atlasText);
  return skeleton && ((await drawRig(skeleton, pages, background))?.png ?? null);
}

/** Draws one textured triangle onto `out` (opaque RGBA), blending by the texture's alpha. */
function drawTriangle(
  out: Buffer,
  width: number,
  height: number,
  image: PageImage,
  [a, b, c]: { p: [number, number]; u: number; v: number }[],
  color: Tint,
  /** When given, the pixels this triangle covers are added to the part's coverage. */
  measure?: { cover: PartCoverage; maskW: number },
) {
  const area = (b.p[0] - a.p[0]) * (c.p[1] - a.p[1]) - (c.p[0] - a.p[0]) * (b.p[1] - a.p[1]);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(a.p[0], b.p[0], c.p[0])));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(a.p[0], b.p[0], c.p[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a.p[1], b.p[1], c.p[1])));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(a.p[1], b.p[1], c.p[1])));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      // Barycentric weights of b and c; a gets the rest.
      const wb = ((px - a.p[0]) * (c.p[1] - a.p[1]) - (c.p[0] - a.p[0]) * (py - a.p[1])) / area;
      const wc = ((b.p[0] - a.p[0]) * (py - a.p[1]) - (px - a.p[0]) * (b.p[1] - a.p[1])) / area;
      const wa = 1 - wb - wc;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      const tx = Math.min(image.width - 1, Math.max(0, Math.floor((wa * a.u + wb * b.u + wc * c.u) * image.width)));
      const ty = Math.min(image.height - 1, Math.max(0, Math.floor((wa * a.v + wb * b.v + wc * c.v) * image.height)));
      const s = (ty * image.width + tx) * 4;
      const alpha = (image.rgba[s + 3] / 255) * color.a;
      if (alpha <= 0) continue;
      if (measure && alpha > COVER_ALPHA) {
        const c = measure.cover;
        c.count++;
        c.cx += x;
        c.cy += y;
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;
        c.mask[Math.floor(y / MASK_STEP) * measure.maskW + Math.floor(x / MASK_STEP)] = 1;
      }
      const d = (y * width + x) * 4;
      out[d] = Math.round(out[d] * (1 - alpha) + image.rgba[s] * color.r * alpha);
      out[d + 1] = Math.round(out[d + 1] * (1 - alpha) + image.rgba[s + 1] * color.g * alpha);
      out[d + 2] = Math.round(out[d + 2] * (1 - alpha) + image.rgba[s + 2] * color.b * alpha);
    }
  }
}
