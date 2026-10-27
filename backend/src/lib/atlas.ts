export interface AtlasPage {
  /** Page image file name, relative to the .atlas. */
  name: string;
  /** Region (attachment) names packed on this page. */
  regions: string[];
}

/**
 * Reads page and region names from a Spine .atlas (3.x or 4.x format). Pages start
 * the file or follow a blank line; every other line without a colon is a region.
 */
export function parseAtlas(text: string): AtlasPage[] {
  const pages: AtlasPage[] = [];
  let expectPage = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      expectPage = true;
      continue;
    }
    if (line.includes(":")) continue;
    if (expectPage) {
      pages.push({ name: line, regions: [] });
      expectPage = false;
    } else {
      pages.at(-1)?.regions.push(line);
    }
  }
  return pages;
}

/** Page names are written to disk as-is, so only allow plain image file names. */
export function isSafePageName(name: string): boolean {
  return /^[\w\- .]+\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith(".");
}
