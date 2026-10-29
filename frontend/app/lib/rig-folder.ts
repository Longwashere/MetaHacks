// Reads Spine rigs from folders the user picks or drops on the upload page. Every folder that
// holds a .atlas is one rig: its skeleton (.json, or a binary .skel converted to JSON here), the
// atlas, and the page images the atlas names. The backend checks everything again.

import { parseAtlas } from "~/lib/atlas";
import { skelToJson } from "~/lib/spine-skel-json";

/** A file with its path inside what the user picked ("monk/Monk.atlas"). */
export interface PickedFile {
  path: string;
  file: File;
}

export interface RigFolder {
  /** The folder's path, unique within a selection. */
  key: string;
  /** Rig name, from the folder name; the user can change it. */
  name: string;
  files: PickedFile[];
}

/** One rig, ready to send to POST /me/uploads. */
export interface UploadRigPayload {
  name: string;
  skeleton: Record<string, unknown>;
  atlas: string;
  pages: { name: string; data: string }[];
}

const isAtlas = (name: string) => /\.atlas(\.txt)?$/i.test(name);
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stem = (name: string) => name.replace(/\.(atlas\.txt|atlas|json|skel(\.bytes)?)$/i, "");

/** Groups picked files into rig folders: one per directory that holds a .atlas. */
export function groupRigFolders(files: PickedFile[]): RigFolder[] {
  const byDir = new Map<string, PickedFile[]>();
  for (const f of files) {
    const dir = dirOf(f.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  return [...byDir.entries()]
    .filter(([, dirFiles]) => dirFiles.some((f) => isAtlas(f.file.name)))
    .map(([dir, dirFiles]) => ({ key: dir, name: titleFromFolder(dir, dirFiles), files: dirFiles }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function titleFromFolder(dir: string, files: PickedFile[]): string {
  const folder = dir.replace(/\/$/, "").split("/").pop() || stem(files.find((f) => isAtlas(f.file.name))!.file.name);
  return folder
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 80);
}

/** Reads a folder into an upload payload. Throws an Error with a message for the user. */
export async function readRigFolder(folder: RigFolder): Promise<UploadRigPayload> {
  const atlases = folder.files.filter((f) => isAtlas(f.file.name));
  if (atlases.length > 1) throw new Error("This folder has more than one .atlas. Put each rig in its own folder.");
  const atlasFile = atlases[0];
  const atlas = await atlasFile.file.text();

  const pageNames = parseAtlas(atlas).map((p) => p.name);
  if (pageNames.length === 0) throw new Error(`${atlasFile.file.name} has no pages.`);
  const byName = new Map(folder.files.map((f) => [baseName(f.path), f.file]));
  const missing = pageNames.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}, which the .atlas uses.`);
  if (pageNames.some((n) => !/\.png$/i.test(n))) throw new Error("Only PNG page images are supported.");

  const skeleton = await readSkeleton(folder.files, stem(atlasFile.file.name));
  const pages = await Promise.all(pageNames.map(async (name) => ({ name, data: await toBase64(byName.get(name)!) })));
  return { name: folder.name.trim(), skeleton, atlas, pages };
}

/** The folder's skeleton as JSON. Prefers the one named like the atlas when there are several. */
async function readSkeleton(files: PickedFile[], atlasStem: string): Promise<Record<string, unknown>> {
  const candidates = files.filter((f) => /\.(json|skel(\.bytes)?)$/i.test(f.file.name));
  candidates.sort((a, b) => Number(stem(b.file.name) === atlasStem) - Number(stem(a.file.name) === atlasStem));
  for (const { file } of candidates) {
    if (/\.json$/i.test(file.name)) {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        continue;
      }
      // Other JSON files (e.g. export settings) don't have a skeleton header.
      if (typeof json === "object" && json !== null && "skeleton" in json && "bones" in json) return json as Record<string, unknown>;
      continue;
    }
    try {
      return skelToJson(await file.arrayBuffer());
    } catch (error) {
      throw new Error(`${file.name} couldn't be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("No skeleton found. Add the rig's .json or .skel export.");
}

/** Base64 without the data URL prefix. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Files from <input webkitdirectory>, keyed by the path inside the picked folder. */
export function filesFromInput(list: FileList): PickedFile[] {
  return [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** Files from dropped folders (and loose files), walking each folder's entries. */
export async function filesFromDrop(items: DataTransferItemList): Promise<PickedFile[]> {
  const entries = [...items].map((item) => item.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  const out: PickedFile[] = [];
  await Promise.all(entries.map((entry) => walk(entry, out)));
  return out;
}

async function walk(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: entry.fullPath.replace(/^\//, ""), file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 entries per call; keep reading until it's empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    await Promise.all(batch.map((e) => walk(e, out)));
  }
}

/** Approximate request size of a payload, for splitting a batch into requests. */
export function payloadBytes(rig: UploadRigPayload): number {
  return JSON.stringify(rig.skeleton).length + rig.atlas.length + rig.pages.reduce((n, p) => n + p.data.length, 0);
}
