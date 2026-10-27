export interface AtlasRegion {
  name: string;
  /** Where the region is packed on its page, in page pixels from the top-left (a rotated region's width and height are swapped). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees the region is rotated on the page: 0, 90, 180 or 270. */
  rotate: number;
}

export interface AtlasPage {
  /** Page image file name, relative to the .atlas. */
  name: string;
  /** Page size from the atlas header, if it has one. */
  width: number | null;
  height: number | null;
  regions: AtlasRegion[];
}

/**
 * Reads pages and region rects from a Spine .atlas (3.x or 4.x format). Pages start the
 * file or follow a blank line; every other line without a colon is a region, followed by
 * its `key: value` properties.
 */
export function parseAtlas(text: string): AtlasPage[] {
  const pages: AtlasPage[] = [];
  let expectPage = true;
  // The region whose properties are being read; null while reading a page's own properties.
  let region: AtlasRegion | null = null;
  const finishRegion = () => {
    if (region && (region.rotate === 90 || region.rotate === 270)) {
      [region.width, region.height] = [region.height, region.width];
    }
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
      const value = line.slice(colon + 1).trim();
      const values = value.split(",").map((v) => Number(v.trim()));
      const page = pages.at(-1);
      if (!region) {
        if (page && key === "size" && values.length === 2) [page.width, page.height] = values;
        continue;
      }
      if (key === "bounds" && values.length === 4) {
        [region.x, region.y, region.width, region.height] = values;
      } else if (key === "xy" && values.length === 2) {
        [region.x, region.y] = values;
      } else if (key === "size" && values.length === 2) {
        [region.width, region.height] = values;
      } else if (key === "rotate") {
        // 3.x writes true/false; 4.x writes degrees (or true for 90).
        region.rotate = value === "true" ? 90 : Number(value) || 0;
      }
      continue;
    }
    finishRegion();
    if (expectPage) {
      pages.push({ name: line, width: null, height: null, regions: [] });
      expectPage = false;
    } else {
      const page = pages.at(-1);
      if (!page) continue;
      region = { name: line, x: 0, y: 0, width: 0, height: 0, rotate: 0 };
      page.regions.push(region);
    }
  }
  finishRegion();
  return pages;
}
