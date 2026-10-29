import { check, db, type AssetFileKeys } from "../lib/db.js";
import { fingerprintFiles } from "../lib/fingerprint.js";

// Fills in art_hash and rig_hash for assets with files that don't have them yet (official rigs,
// uploads, remixes and copies), so new uploads are checked against them (lib/uploads.ts). Reads
// each rig's files from their public URLs, so in local dev the frontend has to be serving
// public/spine/. Safe to re-run.
//
//   npm run backfill:fingerprints -w backend

const rows = check(
  await db()
    .from("assets")
    .select("id, name, files")
    .is("art_hash", null)
    .not("files", "is", null)
    .order("created_at", { ascending: true })
    .overrideTypes<{ id: string; name: string; files: AssetFileKeys }[], { merge: false }>(),
);
console.log(`${rows.length} assets without fingerprints.`);

let done = 0;
for (const row of rows) {
  const hashes = await fingerprintFiles(row.files);
  if (!hashes.art_hash) {
    console.warn(`Skipped ${row.id} (${row.name}): its files couldn't be read.`);
    continue;
  }
  const { error } = await db().from("assets").update(hashes).eq("id", row.id);
  // 23505: the same owner already has this exact rig as another original; leave this one out.
  if (error) console.warn(`Skipped ${row.id} (${row.name}): ${error.code === "23505" ? "the same owner has another copy of this rig" : error.message}`);
  else done++;
}
console.log(`Fingerprinted ${done} of ${rows.length}.`);
