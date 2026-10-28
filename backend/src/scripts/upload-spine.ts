import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { putR2Object } from "../lib/storage.js";

// Uploads the base Spine rigs to R2 under spine/, keeping their folder layout, so they're
// served from R2_PUBLIC_URL/spine/<rig>/<file>. Re-run after adding or changing a rig.
//
//   npm run upload:spine -w backend               # uploads ../frontend/public/spine
//   npm run upload:spine -w backend -- <dir>      # or another folder

const UPLOADED = new Set([".atlas", ".json", ".png", ".skel"]);
/** Base rigs can be replaced in place, so they're cached for an hour rather than forever. */
const CACHE_CONTROL = "public, max-age=3600";
const CONCURRENCY = 8;

const root = path.resolve(process.argv[2] ?? "../frontend/public/spine");
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && UPLOADED.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));

console.log(`Uploading ${files.length} files from ${root}`);
let done = 0;
const queue = [...files];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const objectKey = ["spine", ...file.split(path.sep)].map(encodeURIComponent).join("/");
      await putR2Object(objectKey, await readFile(path.join(root, file)), CACHE_CONTROL);
      done++;
      if (done % 20 === 0 || done === files.length) console.log(`  ${done}/${files.length}`);
    }
  }),
);
console.log("Done.");
