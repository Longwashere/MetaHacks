import { CheckCircle2, FolderOpen, Loader2, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/upload";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import type { UploadRigsResult } from "~/lib/api.server";
import { requireSession } from "~/lib/auth.server";
import {
  filesFromDrop,
  filesFromInput,
  groupRigFolders,
  payloadBytes,
  readRigFolder,
  type PickedFile,
  type RigFolder,
  type UploadRigPayload,
} from "~/lib/rig-folder";
import { assetPath, categoryLabel, SITE_NAME } from "~/lib/seo";
import { ART_STYLES, ASSET_CATEGORIES, type ArtStyle, type AssetCategory } from "~/lib/types";
import { cn } from "~/lib/utils";

/** Rigs per upload for everyone but admins; the backend enforces the same limit. */
const USER_MAX_RIGS = 3;
/** Rigs and bytes per request, so big admin batches go in several requests under the Worker's body limit. */
const RIGS_PER_REQUEST = 3;
const BYTES_PER_REQUEST = 40 * 1024 * 1024;

export function meta({}: Route.MetaArgs) {
  return [{ title: `Upload rigs · ${SITE_NAME}` }, { name: "robots", content: "noindex, nofollow" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const session = requireSession(context, request);
  return { maxRigs: session.user.isAdmin ? null : USER_MAX_RIGS };
}

type RigStatus =
  | { state: "ready" }
  | { state: "uploading" }
  | { state: "done"; assetId: string }
  | { state: "error"; error: string };

export default function UploadPage({ loaderData }: Route.ComponentProps) {
  const { maxRigs } = loaderData;
  const [folders, setFolders] = useState<RigFolder[]>([]);
  const [status, setStatus] = useState<Record<string, RigStatus>>({});
  const [category, setCategory] = useState<AssetCategory>("character");
  const [style, setStyle] = useState<ArtStyle>("cartoon");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Finished rigs drop out of the next upload; their links stay in the list.
  const pending = folders.filter((f) => status[f.key]?.state !== "done");
  const done = folders.filter((f) => status[f.key]?.state === "done");
  const full = maxRigs !== null && pending.length >= maxRigs;

  const addFiles = (files: PickedFile[]) => {
    const found = groupRigFolders(files).filter((f) => !folders.some((existing) => existing.key === f.key));
    if (found.length === 0) {
      setNotice("No rigs found. Each rig needs its own folder with a .atlas, its page images and a .json or .skel skeleton.");
      return;
    }
    const room = maxRigs === null ? found.length : Math.max(maxRigs - pending.length, 0);
    const added = found.slice(0, room);
    setNotice(
      added.length < found.length
        ? `You can upload ${maxRigs} rigs at a time, so ${found.length - added.length} of the folders you picked weren't added. Upload these first, then add the rest.`
        : null,
    );
    setFolders((prev) => [...prev, ...added]);
    setStatus((prev) => ({ ...prev, ...Object.fromEntries(added.map((f) => [f.key, { state: "ready" } as const])) }));
  };

  const remove = (key: string) => {
    setFolders((prev) => prev.filter((f) => f.key !== key));
    setNotice(null);
  };

  const rename = (key: string, name: string) => setFolders((prev) => prev.map((f) => (f.key === key ? { ...f, name } : f)));

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    addFiles(await filesFromDrop(event.dataTransfer.items));
  };

  // Sent with fetch rather than a fetcher: a batch goes in several requests, one after another,
  // and each rig's row shows how it went.
  const upload = async () => {
    setUploading(true);
    setNotice(null);
    const set = (key: string, s: RigStatus) => setStatus((prev) => ({ ...prev, [key]: s }));
    const readable: { folder: RigFolder; rig: UploadRigPayload }[] = [];
    for (const folder of pending) {
      set(folder.key, { state: "uploading" });
      try {
        readable.push({ folder, rig: await readRigFolder(folder) });
      } catch (error) {
        set(folder.key, { state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }

    const batches: (typeof readable)[] = [];
    for (const item of readable) {
      const last = batches.at(-1);
      const lastBytes = last?.reduce((n, i) => n + payloadBytes(i.rig), 0) ?? 0;
      if (last && last.length < RIGS_PER_REQUEST && lastBytes + payloadBytes(item.rig) <= BYTES_PER_REQUEST) last.push(item);
      else batches.push([item]);
    }

    for (const batch of batches) {
      let result: UploadRigsResult;
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, style, visibility, rigs: batch.map((i) => i.rig) }),
        });
        result = res.headers.get("content-type")?.includes("json")
          ? ((await res.json()) as UploadRigsResult)
          : { ok: false, error: res.status === 413 ? "That rig is too big to upload." : `Upload failed (${res.status}).`, rigErrors: {} };
      } catch {
        result = { ok: false, error: "The upload didn't reach the server. Check your connection and try again.", rigErrors: {} };
      }
      batch.forEach((item, i) => {
        if (result.ok) set(item.folder.key, { state: "done", assetId: result.assets[i].id });
        else set(item.folder.key, { state: "error", error: result.rigErrors[i] ?? result.error });
      });
    }
    setUploading(false);
  };

  const canUpload = pending.length > 0 && !uploading && pending.every((f) => f.name.trim().length > 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Upload rigs</h1>
        <p className="text-muted-foreground">
          Add your own Spine 4.2 rigs, one folder per rig: the skeleton (.json or .skel), its .atlas and the atlas's PNG pages.
          {maxRigs === null ? " As an admin you can upload any number at once." : ` You can upload ${maxRigs} rigs at a time.`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Folders</CardTitle>
          <CardDescription>Pick a folder that holds your rig folders, or drop several folders here. Pick again to add more.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center text-sm text-muted-foreground transition-colors",
              dragging && "border-primary bg-accent",
            )}
          >
            <FolderOpen className="size-8" aria-hidden />
            <p>Drop rig folders here</p>
            <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading || full}>
              <FolderOpen /> Choose folder
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(e) => {
                if (e.target.files) addFiles(filesFromInput(e.target.files));
                e.target.value = "";
              }}
            />
          </div>

          {notice && (
            <Alert>
              <TriangleAlert />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          {folders.length > 0 && (
            <ul className="flex flex-col divide-y rounded-md border">
              {folders.map((folder) => {
                const s = status[folder.key] ?? { state: "ready" };
                return (
                  <li key={folder.key} className="flex flex-col gap-2 p-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`name-${folder.key}`} className="sr-only">
                        Rig name for {folder.key}
                      </Label>
                      <Input
                        id={`name-${folder.key}`}
                        value={folder.name}
                        maxLength={80}
                        onChange={(e) => rename(folder.key, e.target.value)}
                        disabled={uploading || s.state === "done"}
                        className="h-8"
                      />
                      {s.state === "uploading" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Uploading" />}
                      {s.state === "done" ? (
                        <Button asChild size="sm" variant="outline">
                          <Link to={`${assetPath({ id: s.assetId })}?public=1`}>
                            <CheckCircle2 /> View
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => remove(folder.key)}
                          disabled={uploading}
                          aria-label={`Remove ${folder.name || folder.key}`}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {folder.key} · {folder.files.length} files
                    </p>
                    {s.state === "error" && <p className="text-sm text-destructive">{s.error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {maxRigs !== null && (
            <p className="text-xs text-muted-foreground">
              {pending.length} of {maxRigs} rigs selected for this upload.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription>Applied to every rig in this upload. You can change visibility later on each rig's page.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="category">Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as AssetCategory)} disabled={uploading}>
              <SelectTrigger id="category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {categoryLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="style">Art style</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as ArtStyle)} disabled={uploading}>
              <SelectTrigger id="style" className="w-full capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ART_STYLES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label id="visibility-label">Visibility</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={visibility}
              onValueChange={(v) => v && setVisibility(v as "public" | "private")}
              aria-labelledby="visibility-label"
              disabled={uploading}
              className="w-full"
            >
              <ToggleGroupItem value="private" className="flex-1">
                Private
              </ToggleGroupItem>
              <ToggleGroupItem value="public" className="flex-1">
                Public
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={upload} disabled={!canUpload}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? "Uploading…" : `Upload ${pending.length || ""} ${pending.length === 1 ? "rig" : "rigs"}`}
          </Button>
          {done.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <Badge variant="secondary">{done.length} uploaded</Badge> They're in{" "}
              <Link to="/library?tab=remixes" className="underline underline-offset-4">
                your library
              </Link>
              .
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
