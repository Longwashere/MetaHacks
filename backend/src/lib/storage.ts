import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { ASSET_BASE_URL, PUBLIC_URL, R2, REMIX_OUTPUT_DIR } from "./config.js";

// Files are addressed by storage key: "spine/<rig>/<file>" for base rigs, "remixes/<folder>/<file>"
// for generated ones. The database stores keys; objectUrl() turns one into a public URL.
// With R2 configured every key is served from R2_PUBLIC_URL. Without it, generated files are
// written under REMIX_OUTPUT_DIR and served by this server at /files/remixes/, and base rigs come
// from ASSET_BASE_URL (the frontend's public/spine/ in dev).

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".atlas": "text/plain; charset=utf-8",
  ".skel": "application/octet-stream",
};

const r2 = R2
  ? {
      client: new AwsClient({
        accessKeyId: R2.accessKeyId,
        secretAccessKey: R2.secretAccessKey,
        service: "s3",
        region: "auto",
      }),
      bucketUrl: `https://${R2.accountId}.r2.cloudflarestorage.com/${R2.bucket}`,
    }
  : null;

export const STORAGE_BACKEND = r2 ? "r2" : "local";

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** Public URL of a stored file. */
export function objectUrl(key: string): string {
  if (R2) return `${R2.publicUrl}/${encodeKey(key)}`;
  return `${key.startsWith("spine/") ? ASSET_BASE_URL : `${PUBLIC_URL}/files`}/${encodeKey(key)}`;
}

/** Stores `body` as remixes/<folder>/<name> and returns its key. Names come from our code or are checked by the caller. */
export async function putFile(folder: string, name: string, body: Buffer | string): Promise<string> {
  const key = `remixes/${folder}/${name}`;
  if (!r2) {
    const dir = path.join(REMIX_OUTPUT_DIR, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body);
    return key;
  }

  // prompts.json is rewritten mid-job; everything else is written once.
  await putR2Object(key, body, name === "prompts.json" ? "no-cache" : "public, max-age=31536000, immutable");
  return key;
}

/** Uploads to R2 at `key`. Throws if R2 isn't configured. */
export async function putR2Object(key: string, body: Buffer | string, cacheControl: string): Promise<void> {
  if (!r2) throw new Error("R2 isn't configured; set every R2_* variable in .env.");
  const contentType = CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
  const res = await r2.client.fetch(`${r2.bucketUrl}/${encodeKey(key)}`, {
    method: "PUT",
    body: typeof body === "string" ? body : new Uint8Array(body),
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Couldn't save ${key} to R2 (${res.status}): ${detail}`);
  }
}

/** Lists keys under `prefix` in R2. With `delimiter`, returns the next-level "folders" (common prefixes) instead. */
export async function listR2(prefix: string, delimiter?: string): Promise<string[]> {
  if (!r2) throw new Error("R2 isn't configured; set every R2_* variable in .env.");
  const found: string[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (delimiter) params.set("delimiter", delimiter);
    if (token) params.set("continuation-token", token);
    const res = await r2.client.fetch(`${r2.bucketUrl}?${params}`);
    if (!res.ok) throw new Error(`Couldn't list ${prefix} in R2 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    const tag = delimiter ? /<CommonPrefixes><Prefix>(.*?)<\/Prefix><\/CommonPrefixes>/g : /<Key>(.*?)<\/Key>/g;
    for (const m of xml.matchAll(tag)) found.push(decodeXml(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] : undefined;
    if (token) token = decodeXml(token);
  } while (token);
  return found;
}

/** Downloads one R2 object. */
export async function getR2Object(key: string): Promise<Buffer> {
  if (!r2) throw new Error("R2 isn't configured; set every R2_* variable in .env.");
  const res = await r2.client.fetch(`${r2.bucketUrl}/${encodeKey(key)}`);
  if (!res.ok) throw new Error(`Couldn't read ${key} from R2 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
