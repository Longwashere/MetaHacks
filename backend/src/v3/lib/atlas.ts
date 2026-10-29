export interface AtlasPage {
  /** Page image file name, relative to the .atlas. */
  name: string;
  /** Region (attachment) names packed on this page. */
  regions: string[];
  /** Where each region is packed on the page, in the same order as `regions`. */
  rects: PageRect[];
  /** How each region maps back to its attachment's image, in the same order as `regions`. */
  frames: RegionFrame[];
  /**
   * The page size from its `size:` line, which region bounds are measured in. The image file can
   * differ (Zedrex's is 512×128 for a 1010×253 atlas); the Spine runtime scales to fit.
   */
  size: { width: number; height: number } | null;
}

/**
 * A region's unrotated size, rotation and stripped whitespace, as the Spine runtime reads them.
 * Needed to place a mesh's UVs (fractions of the original image) on the page.
 */
export interface RegionFrame {
  /** Degrees the region is turned on the page: 0, 90, 180 or 270. */
  degrees: number;
  /** Packed size before rotation. */
  width: number;
  height: number;
  /** Whitespace stripped from the left and bottom, and the image's size before stripping. */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
}

/** A region's area on its page, in page pixels as packed (a rotated region's width and height are swapped). */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Larger declared page sizes are ignored, so an atlas can't make us decode a huge image. */
const MAX_PAGE_SIDE = 8192;

/**
 * Reads page and region names, and where each region is packed, from a Spine .atlas
 * (3.x or 4.x format). Pages start the file or follow a blank line; every other line
 * without a colon is a region, followed by its `key: value` properties.
 */
export function parseAtlas(text: string): AtlasPage[] {
  const pages: AtlasPage[] = [];
  let expectPage = true;
  // The region whose properties are being read; null while reading a page's own properties.
  let region: { rect: PageRect; frame: RegionFrame; hasOriginal: boolean } | null = null;
  const finishRegion = () => {
    if (!region) return;
    const { rect, frame } = region;
    frame.width = rect.width;
    frame.height = rect.height;
    if (!region.hasOriginal) [frame.originalWidth, frame.originalHeight] = [rect.width, rect.height];
    if (frame.degrees === 90 || frame.degrees === 270) [rect.width, rect.height] = [rect.height, rect.width];
    region = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      finishRegion();
      expectPage = true;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon >= 0) {
      const key = line.slice(0, colon).trim();
      const values = line.slice(colon + 1).split(",").map((v) => Number(v.trim()));
      if (!region) {
        const page = pages.at(-1);
        if (page && key === "size" && values.length === 2 && values.every((v) => Number.isInteger(v) && v > 0 && v <= MAX_PAGE_SIDE)) {
          page.size = { width: values[0], height: values[1] };
        }
        continue;
      }
      const value = line.slice(colon + 1).trim();
      if (key === "bounds" && values.length === 4) {
        [region.rect.x, region.rect.y, region.rect.width, region.rect.height] = values;
      } else if (key === "xy" && values.length === 2) {
        [region.rect.x, region.rect.y] = values;
      } else if (key === "size" && values.length === 2) {
        [region.rect.width, region.rect.height] = values;
      } else if (key === "rotate") {
        // 3.x writes true/false; 4.x writes degrees (or true for 90).
        region.frame.degrees = value === "true" ? 90 : [90, 180, 270].includes(Number(value)) ? Number(value) : 0;
      } else if (key === "offsets" && values.length === 4) {
        [region.frame.offsetX, region.frame.offsetY, region.frame.originalWidth, region.frame.originalHeight] = values;
        region.hasOriginal = true;
      } else if (key === "offset" && values.length === 2) {
        [region.frame.offsetX, region.frame.offsetY] = values;
      } else if (key === "orig" && values.length === 2) {
        [region.frame.originalWidth, region.frame.originalHeight] = values;
        region.hasOriginal = true;
      }
      continue;
    }
    finishRegion();
    if (expectPage) {
      pages.push({ name: line, regions: [], rects: [], frames: [], size: null });
      expectPage = false;
    } else {
      const page = pages.at(-1);
      if (!page) continue;
      region = {
        rect: { x: 0, y: 0, width: 0, height: 0 },
        frame: { degrees: 0, width: 0, height: 0, offsetX: 0, offsetY: 0, originalWidth: 0, originalHeight: 0 },
        hasOriginal: false,
      };
      page.regions.push(line);
      page.rects.push(region.rect);
      page.frames.push(region.frame);
    }
  }
  finishRegion();
  return pages;
}

/**
 * A point given as a fraction of the region's original image (a mesh UV, 0–1 from the top-left),
 * in page pixels. Mirrors MeshAttachment.updateRegion in spine-core. `rect` is where the region
 * is packed.
 */
export function uvToPage(rect: PageRect, f: RegionFrame, u: number, v: number): [number, number] {
  const { width: w, height: h, offsetX: ox, offsetY: oy, originalWidth: ow, originalHeight: oh } = f;
  switch (f.degrees) {
    case 90:
      return [rect.x - (oh - oy - h) + v * oh, rect.y - (ow - ox - w) + (1 - u) * ow];
    case 180:
      return [rect.x - (ow - ox - w) + (1 - u) * ow, rect.y - oy + (1 - v) * oh];
    case 270:
      return [rect.x - oy + (1 - v) * oh, rect.y - ox + u * ow];
    default:
      return [rect.x - ox + u * ow, rect.y - (oh - oy - h) + v * oh];
  }
}

/** Page names are written to disk as-is, so only allow plain image file names. */
export function isSafePageName(name: string): boolean {
  return /^[\w\- .]+\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith(".");
}
