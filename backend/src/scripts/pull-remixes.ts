import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REMIX_OUTPUT_DIR } from "../lib/config.js";
import { getR2Object, listR2 } from "../lib/storage.js";

// Downloads remix runs (prompts.json, .atlas, original and generated pages) from R2 into
// REMIX_OUTPUT_DIR (backend/data/remixes/), so a run can be inspected locally.
//
//   npm run pull:remixes -w backend               # the 5 most recent runs
//   npm run pull:remixes -w backend -- 20         # the 20 most recent
//   npm run pull:remixes -w backend -- job_1234   # runs whose folder contains this text

const arg = process.argv[2] ?? "5";
// Folder names start with an ISO timestamp, so they sort by creation time.
const folders = (await listR2("remixes/", "/")).sort();
const picked = /^\d+$/.test(arg) ? folders.slice(-Number(arg)) : folders.filter((f) => f.includes(arg));
if (picked.length === 0) {
  console.log(`No remix folders match "${arg}" (${folders.length} in R2).`);
  process.exit(1);
}

for (const prefix of picked) {
  const dir = path.join(REMIX_OUTPUT_DIR, prefix.slice("remixes/".length));
  await mkdir(dir, { recursive: true });
  const keys = await listR2(prefix);
  await Promise.all(keys.map(async (key) => writeFile(path.join(dir, path.basename(key)), await getR2Object(key))));
  console.log(`${dir} (${keys.length} files)`);
}
