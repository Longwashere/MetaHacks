import * as spine from "@esotericsoftware/spine-core";
import type { PageImage } from "./textures.js";

// The crop check: the game only draws a mesh's texture inside the mesh's triangles, so paint that
// a repaint put outside them is cut off in the game, even when it's inside the atlas box. This
// measures, per region, how much of the painted part falls outside every mesh that draws it,
// in texture space, so the pose doesn't matter and tweaks (which move whole meshes) can't change it.
// Only paint joined to the part's paint inside the mesh counts: a separate stray blob in the box (a
// neighbour's ear tip) is rightly hidden by the mesh, and boxing the mesh would show it.

/** Alpha above which a texture pixel counts as painted. */
const PAINTED_ALPHA = 128;
/** A region is flagged when its repaint loses more than this share of its paint to the mesh than the original did… */
export const CROP_SHARE = 0.01;
/** …and at least this many pixels, so specks at a mesh's edge don't count. */
const CROP_MIN_PIXELS = 30;

export interface CropResult {
  region: string;
  /** Slots whose mesh attachments draw the region. */
  slots: string[];
  /** Painted pixels in the region on the repainted page, and how many of the part's own fall outside its meshes. */
  painted: number;
  cut: number;
  /** cut / painted, and the same share on the original page, which artists' meshes rarely cover exactly. */
  share: number;
  baseline: number;
  /** True when share exceeds the baseline by CROP_SHARE and CROP_MIN_PIXELS: the repaint is visibly cut. */
  cropped: boolean;
}

/**
 * Measures every region drawn only by meshes (region attachments show their whole box). `rig` is
 * the loaded skeleton (see render.ts loadRig), whose attachments carry the atlas regions and UVs.
 * `remix` and `original` are the pages by name, straight alpha.
 */
export function measureCrops(rig: spine.Skeleton, remix: Map<string, PageImage>, original: Map<string, PageImage>): CropResult[] {
  // Each region's meshes, from every skin: a region drawn by any region attachment is never cut.
  const byRegion = new Map<spine.TextureAtlasRegion, { meshes: spine.MeshAttachment[]; slots: Set<string>; quad: boolean }>();
  for (const skin of rig.data.skins) {
    for (const entry of skin.getAttachments()) {
      const att = entry.attachment;
      if (!(att instanceof spine.MeshAttachment) && !(att instanceof spine.RegionAttachment)) continue;
      const region = att.region instanceof spine.TextureAtlasRegion ? att.region : null;
      if (!region) continue;
      let info = byRegion.get(region);
      if (!info) {
        info = { meshes: [], slots: new Set(), quad: false };
        byRegion.set(region, info);
      }
      info.slots.add(rig.data.slots[entry.slotIndex]?.name ?? "");
      if (att instanceof spine.RegionAttachment) info.quad = true;
      else info.meshes.push(att);
    }
  }

  const out: CropResult[] = [];
  for (const [region, info] of byRegion) {
    if (info.quad || info.meshes.length === 0) continue;
    const remixPage = remix.get(region.page.name);
    const originalPage = original.get(region.page.name);
    if (!remixPage) continue;
    const { width: pw, height: ph } = remixPage;
    const x0 = Math.max(0, Math.floor(Math.min(region.u, region.u2) * pw));
    const x1 = Math.min(pw, Math.ceil(Math.max(region.u, region.u2) * pw));
    const y0 = Math.max(0, Math.floor(Math.min(region.v, region.v2) * ph));
    const y1 = Math.min(ph, Math.ceil(Math.max(region.v, region.v2) * ph));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
    // Pixels inside any of the region's meshes, in the region's box.
    const inside = new Uint8Array(w * h);
    for (const mesh of info.meshes) fillMesh(inside, mesh, x0, y0, w, h, pw, ph);
    const count = (page: PageImage | undefined) => {
      if (!page || page.width !== pw || page.height !== ph) return null;
      const isPainted = (x: number, y: number) => page.rgba[((y0 + y) * pw + x0 + x) * 4 + 3] >= PAINTED_ALPHA;
      // Flood from the painted pixels inside the mesh through painted pixels (8-connected).
      const reached = new Uint8Array(w * h);
      const queue: number[] = [];
      let painted = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!isPainted(x, y)) continue;
          painted++;
          if (inside[y * w + x]) {
            reached[y * w + x] = 1;
            queue.push(y * w + x);
          }
        }
      }
      let cut = 0;
      for (let q = 0; q < queue.length; q++) {
        const x = queue[q] % w, y = (queue[q] - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (reached[n] || !isPainted(nx, ny)) continue;
            reached[n] = 1;
            queue.push(n);
            if (!inside[n]) cut++;
          }
        }
      }
      return { painted, cut };
    };
    const now = count(remixPage);
    if (!now || now.painted === 0) continue;
    const was = count(originalPage);
    const share = now.cut / now.painted;
    const baseline = was && was.painted > 0 ? was.cut / was.painted : 0;
    out.push({
      region: region.name,
      slots: [...info.slots],
      painted: now.painted,
      cut: now.cut,
      share: Math.round(share * 1000) / 1000,
      baseline: Math.round(baseline * 1000) / 1000,
      cropped: share - baseline > CROP_SHARE && now.cut - baseline * now.painted >= CROP_MIN_PIXELS,
    });
  }
  return out;
}

/** Marks the pixels of the box (x0, y0, w, h) that the mesh's triangles cover, from its page UVs. */
function fillMesh(inside: Uint8Array, mesh: spine.MeshAttachment, x0: number, y0: number, w: number, h: number, pw: number, ph: number) {
  const { uvs, triangles } = mesh;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]].map((i) => [uvs[i * 2] * pw - x0, uvs[i * 2 + 1] * ph - y0]);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    const bx0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const bx1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const by0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const by1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wb = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
        const wc = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
        // A half-pixel of slack, so a pixel the mesh's edge runs through counts as drawn.
        const slack = 0.5 / Math.max(1, Math.min(w, h));
        if (wb >= -slack && wc >= -slack && wb + wc <= 1 + slack) inside[y * w + x] = 1;
      }
    }
  }
}
