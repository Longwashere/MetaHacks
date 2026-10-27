import sharp from "sharp";

/** Background the transparent parts of a page are flattened onto before the models see it. */
const BACKGROUND = "#808080";

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

/** A page prepared for the models: a square PNG with the page in its top-left corner. */
export interface ModelInput {
  dataUrl: string;
  /** Square side in pixels. */
  side: number;
  /** Size of the page inside the square. */
  content: { width: number; height: number };
}

/**
 * The page flattened onto grey, scaled to fit `maxSide` and padded to a square. The
 * image model only honours aspect ratios loosely, and a square comes back square, so
 * the parts stay where they were.
 */
export async function toModelInput(page: PageImage, maxSide: number): Promise<ModelInput> {
  const { data, info } = await sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
    .flatten({ background: BACKGROUND })
    .resize({ width: maxSide, height: maxSide, fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const side = Math.max(info.width, info.height);
  const square = await sharp(data)
    .extend({ right: side - info.width, bottom: side - info.height, background: BACKGROUND })
    .png()
    .toBuffer();
  return {
    dataUrl: `data:image/png;base64,${square.toString("base64")}`,
    side,
    content: { width: info.width, height: info.height },
  };
}

export async function toDataUrl(image: Buffer, maxSide: number): Promise<string> {
  const png = await sharp(image).resize({ width: maxSide, height: maxSide, fit: "inside" }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Fits a repainted page back onto the original: same pixel size, and the original
 * alpha, so every region keeps its exact silhouette in the atlas. The image model
 * only returns opaque images at roughly the requested aspect ratio.
 */
export async function fitToPage(
  generated: Buffer,
  input: ModelInput,
  page: PageImage,
  premultipliedAlpha: boolean,
): Promise<Buffer> {
  const square = await sharp(generated).resize(input.side, input.side, { fit: "fill" }).toBuffer();
  const rgb = await sharp(square)
    .extract({ left: 0, top: 0, ...input.content })
    .resize(page.width, page.height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const out = Buffer.alloc(page.width * page.height * 4);
  for (let p = 0, i = 0; p < out.length; p += 4, i += 3) {
    const a = page.rgba[p + 3];
    const scale = premultipliedAlpha ? a / 255 : 1;
    out[p] = a === 0 ? 0 : Math.round(rgb[i] * scale);
    out[p + 1] = a === 0 ? 0 : Math.round(rgb[i + 1] * scale);
    out[p + 2] = a === 0 ? 0 : Math.round(rgb[i + 2] * scale);
    out[p + 3] = a;
  }
  return sharp(out, { raw: { width: page.width, height: page.height, channels: 4 } }).png().toBuffer();
}
