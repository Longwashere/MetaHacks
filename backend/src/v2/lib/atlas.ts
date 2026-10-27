export interface AtlasPage {
  /** Page image file name, relative to the .atlas. */
  name: string;
  /** Region (attachment) names packed on this page. */
  regions: string[];
  /** Where each region is packed on the page, in the same order as `regions`. */
  rects: PageRect[];
}

/** A region's area on its page, in page pixels as packed (a rotated region's width and height are swapped). */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Reads page and region names, and where each region is packed, from a Spine .atlas
 * (3.x or 4.x format). Pages start the file or follow a blank line; every other line
 * without a colon is a region, followed by its `key: value` properties.
 */
export function parseAtlas(text: string): AtlasPage[] {
  const pages: AtlasPage[] = [];
  let expectPage = true;
  // The region whose properties are being read; null while reading a page's own properties.
  let region: { rect: PageRect; rotated: boolean } | null = null;
  const finishRegion = () => {
    if (region?.rotated) [region.rect.width, region.rect.height] = [region.rect.height, region.rect.width];
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
      if (!region) continue;
      const key = line.slice(0, colon).trim();
      const values = line.slice(colon + 1).split(",").map((v) => Number(v.trim()));
      const value = line.slice(colon + 1).trim();
      if (key === "bounds" && values.length === 4) {
        [region.rect.x, region.rect.y, region.rect.width, region.rect.height] = values;
      } else if (key === "xy" && values.length === 2) {
        [region.rect.x, region.rect.y] = values;
      } else if (key === "size" && values.length === 2) {
        [region.rect.width, region.rect.height] = values;
      } else if (key === "rotate") {
        // 3.x writes true/false; 4.x writes degrees (or true for 90).
        region.rotated = value === "true" || value === "90" || value === "270";
      }
      continue;
    }
    finishRegion();
    if (expectPage) {
      pages.push({ name: line, regions: [], rects: [] });
      expectPage = false;
    } else {
      const page = pages.at(-1);
      if (!page) continue;
      region = { rect: { x: 0, y: 0, width: 0, height: 0 }, rotated: false };
      page.regions.push(line);
      page.rects.push(region.rect);
    }
  }
  finishRegion();
  return pages;
}

/** Page names are written to disk as-is, so only allow plain image file names. */
export function isSafePageName(name: string): boolean {
  return /^[\w\- .]+\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith(".");
}
