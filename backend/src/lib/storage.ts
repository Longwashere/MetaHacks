import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { PUBLIC_URL, R2, REMIX_OUTPUT_DIR } from "./config.js";

// Generated files (atlases, textures, skeletons, prompts.json). With R2 configured they go to the
// bucket and are served from R2_PUBLIC_URL; otherwise they're written under REMIX_OUTPUT_DIR and
// served by this server at /files/remixes/.

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
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

/** Key of a file under the remixes prefix, e.g. `remixes/<folder>/remix.atlas`, URL-encoded per segment. */
function key(folder: string, name: string): string {
  return ["remixes", folder, name].map(encodeURIComponent).join("/");
}

/** Public URL a stored file is served from. */
export function fileUrl(folder: string, name: string): string {
  return `${R2 ? R2.publicUrl : `${PUBLIC_URL}/files`}/${key(folder, name)}`;
}

/** Stores `body` as `<folder>/<name>`. Overwrites; names come from our code or are checked by the caller. */
export async function putFile(folder: string, name: string, body: Buffer | string): Promise<void> {
  if (!r2) {
    const dir = path.join(REMIX_OUTPUT_DIR, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body);
    return;
  }

  // prompts.json is rewritten mid-job; everything else is written once.
  await putR2Object(key(folder, name), body, name === "prompts.json" ? "no-cache" : "public, max-age=31536000, immutable");
}

/** Uploads to R2 at `objectKey` (already URL-encoded). Throws if R2 isn't configured. */
export async function putR2Object(objectKey: string, body: Buffer | string, cacheControl: string): Promise<void> {
  if (!r2) throw new Error("R2 isn't configured; set every R2_* variable in .env.");
  const contentType = CONTENT_TYPES[path.extname(objectKey).toLowerCase()] ?? "application/octet-stream";
  const res = await r2.client.fetch(`${r2.bucketUrl}/${objectKey}`, {
    method: "PUT",
    body: typeof body === "string" ? body : new Uint8Array(body),
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Couldn't save ${objectKey} to R2 (${res.status}): ${detail}`);
  }
}
