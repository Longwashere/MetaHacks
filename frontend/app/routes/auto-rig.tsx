import { Bone, ImageUp, Loader2, RotateCcw, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/auto-rig";
import { JointEditor } from "~/components/JointEditor";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { createAutoRig, getAccount, prepareAutoRig, previewAutoRigCuts } from "~/lib/api.server";
import { requireSession } from "~/lib/auth.server";
import { assetPath, SITE_NAME } from "~/lib/seo";
import { AUTO_RIG_JOINTS, type AutoRigGear, type AutoRigJoints, type AutoRigView, type PreparedAutoRig } from "~/lib/types";

// Auto-rig: one image of a humanoid → Muse Image redraws it in a rig pose → the user drags the
// joints into place → the backend builds a Spine rig and saves it (AUTO_RIG_PLAN.md).

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function meta({}: Route.MetaArgs) {
  return [{ title: `Auto-rig a character · ${SITE_NAME}` }, { name: "robots", content: "noindex, nofollow" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const session = requireSession(context, request);
  if (session.user.isAdmin) return { proOnly: false };
  // Pro and admin only until auto-rigging has a price; the backend enforces it too.
  const account = await getAccount(session);
  return { proOnly: account.plan === "free" };
}

type ActionResult =
  | { intent: "prepare"; ok: true; rig: PreparedAutoRig }
  | { intent: "preview"; ok: true; traceId: string; cuts: string }
  | { intent: "prepare" | "preview" | "create"; ok: false; error: string };

export async function action({ request, context }: Route.ActionArgs) {
  const session = requireSession(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  const view: AutoRigView = form.get("view") === "right" ? "right" : "front";

  if (intent === "prepare") {
    const image = form.get("image");
    if (typeof image !== "string" || !image.startsWith("data:image/")) return data<ActionResult>({ intent, ok: false, error: "Choose an image first." }, { status: 400 });
    const result = await prepareAutoRig(session, { image, view, skipPose: form.get("skipPose") === "on" });
    return result.ok ? data<ActionResult>({ intent, ok: true, rig: result.rig }) : data<ActionResult>({ intent, ok: false, error: result.error }, { status: 400 });
  }

  if (intent === "preview") {
    const traceId = form.get("traceId");
    let joints: unknown = null;
    try {
      joints = JSON.parse(String(form.get("joints")));
    } catch {
      // Reported below.
    }
    if (typeof traceId !== "string" || typeof joints !== "object" || joints === null) return data<ActionResult>({ intent, ok: false, error: "Pose the character first." }, { status: 400 });
    const result = await previewAutoRigCuts(session, { traceId, view, joints: joints as AutoRigJoints });
    return result.ok ? data<ActionResult>({ intent, ok: true, traceId, cuts: result.cuts }) : data<ActionResult>({ intent, ok: false, error: result.error }, { status: 400 });
  }

  if (intent === "create") {
    const cutout = form.get("cutout");
    let joints: unknown = null;
    let gear: unknown = [];
    try {
      joints = JSON.parse(String(form.get("joints")));
      gear = JSON.parse(String(form.get("gear") ?? "[]"));
    } catch {
      // Reported below.
    }
    if (typeof cutout !== "string" || typeof joints !== "object" || joints === null) return data<ActionResult>({ intent, ok: false, error: "Pose the character first." }, { status: 400 });
    const result = await createAutoRig(session, {
      name: String(form.get("name") ?? ""),
      view,
      visibility: form.get("visibility") === "public" ? "public" : "private",
      slice: form.get("slice") === "on",
      cutout,
      joints: joints as AutoRigJoints,
      // The backend checks every item.
      gear: Array.isArray(gear) ? (gear as AutoRigGear[]) : [],
      traceId: typeof form.get("traceId") === "string" ? String(form.get("traceId")) : null,
    });
    if (!result.ok) return data<ActionResult>({ intent, ok: false, error: result.error }, { status: 400 });
    throw redirect(assetPath(result.asset));
  }

  return data<ActionResult>({ intent: "prepare", ok: false, error: "Unknown action." }, { status: 400 });
}

export default function AutoRigPage({ loaderData }: Route.ComponentProps) {
  const pose = useFetcher<typeof action>();
  const build = useFetcher<typeof action>();
  const preview = useFetcher<typeof action>();
  const inputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<{ dataUrl: string; name: string; png: boolean } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [view, setView] = useState<AutoRigView>("front");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [showCuts, setShowCuts] = useState(true);
  // "smooth": the art stays one image, bent by the bones. "parts": it's cut into separate pieces.
  const [rigStyle, setRigStyle] = useState<"smooth" | "parts">("smooth");
  const sliced = rigStyle === "parts";
  // The user's joint edits, tied to the cutout they were made on, so a new pose starts fresh.
  const [edited, setEdited] = useState<{ cutout: string; joints: AutoRigJoints } | null>(null);

  const posing = pose.state !== "idle";
  const building = build.state !== "idle";
  const prepared = pose.data?.ok && pose.data.intent === "prepare" ? pose.data.rig : null;
  const isEdited = !!prepared && edited?.cutout === prepared.cutout;
  const joints = prepared ? (isEdited ? edited.joints : prepared.joints) : null;
  // The cuts for the joints as prepared, or the latest preview for this pose once joints are moved.
  const previewed = preview.data?.ok && preview.data.intent === "preview" && preview.data.traceId === prepared?.traceId ? preview.data.cuts : null;
  const cuts = prepared ? (isEdited ? (previewed ?? prepared.cuts) : prepared.cuts) : null;
  const previewError = preview.data && !preview.data.ok ? preview.data.error : null;
  const poseError = pose.data && !pose.data.ok ? pose.data.error : null;
  const buildError = build.data && !build.data.ok ? build.data.error : null;

  if (loaderData.proOnly) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <h1 className="text-3xl font-bold tracking-tight">Auto-rig a character</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Auto-rigging is a Pro feature</CardTitle>
            <CardDescription>Turning an image into a Spine rig needs a Pro plan. You can still remix any rig in the library on the free plan.</CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/account">Upgrade to Pro</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/">Browse rigs</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFileError("Use a PNG, JPG or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError("That image is over 8 MB. Use a smaller one.");
      return;
    }
    setFileError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setImage({ dataUrl: String(reader.result), name: file.name, png: file.type === "image/png" });
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 80));
    };
    reader.readAsDataURL(file);
  };

  const runPose = (skipPose: boolean) => {
    if (!image) return;
    const body = new FormData();
    body.set("intent", "prepare");
    body.set("image", image.dataUrl);
    body.set("view", view);
    if (skipPose) body.set("skipPose", "on");
    pose.submit(body, { method: "post" });
  };

  /** Asks the backend where the rig would cut with these joints; runs when a joint is dropped. */
  const runPreview = (next: AutoRigJoints) => {
    if (!prepared?.traceId) return;
    const body = new FormData();
    body.set("intent", "preview");
    body.set("traceId", prepared.traceId);
    body.set("view", view);
    body.set("joints", JSON.stringify(next));
    preview.submit(body, { method: "post" });
  };

  const runBuild = () => {
    if (!prepared || !joints) return;
    const body = new FormData();
    body.set("intent", "create");
    body.set("name", name);
    body.set("view", view);
    body.set("visibility", visibility);
    if (sliced) body.set("slice", "on");
    body.set("cutout", prepared.cutout);
    body.set("joints", JSON.stringify(joints));
    body.set("gear", JSON.stringify(prepared.gear ?? []));
    if (prepared.traceId) body.set("traceId", prepared.traceId);
    build.submit(body, { method: "post" });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Wand2 className="size-7" aria-hidden /> Auto-rig a character
        </h1>
        <p className="text-muted-foreground">
          Upload one image of a humanoid character. Muse redraws it in a rig-ready pose, you check the joints, and you get a Spine 4.2 rig you can play, animate with Muse and download.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Your character</CardTitle>
            <CardDescription>Works best with one full-body character. Props are removed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={posing}
              className="flex aspect-square w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border-2 border-dashed text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-accent disabled:opacity-60"
            >
              {image ? (
                <img src={image.dataUrl} alt="Your upload" className="size-full object-contain" />
              ) : (
                <>
                  <ImageUp className="size-8" aria-hidden />
                  <span>Choose an image (PNG, JPG or WebP, up to 8 MB)</span>
                </>
              )}
            </button>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={pickFile} />
            {fileError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{fileError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label>View</Label>
              <ToggleGroup type="single" variant="outline" value={view} onValueChange={(v) => v && setView(v as AutoRigView)} disabled={posing} className="w-full">
                <ToggleGroupItem value="front" className="flex-1">
                  Front
                </ToggleGroupItem>
                <ToggleGroupItem value="right" className="flex-1">
                  Facing right
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="flex flex-col gap-2">
              <Button onClick={() => runPose(false)} disabled={!image || posing}>
                {posing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {posing ? "Muse is posing your character…" : prepared ? "Pose again with Muse" : "Pose with Muse"}
              </Button>
              {image?.png && (
                <Button variant="outline" onClick={() => runPose(true)} disabled={posing}>
                  Rig my image as-is
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {posing ? "Muse redraws the character, then places its joints. This takes about 30–60 seconds." : image?.png ? "“As-is” skips Muse. It needs a transparent background and works best when the arms and legs are already spread." : "Muse redraws the character standing with its arms and legs spread."}
              </p>
            </div>
            {poseError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{poseError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Check the joints</CardTitle>
            <CardDescription>
              {!prepared
                ? "The posed character and its joints show here."
                : prepared.jointsBy === "spark"
                  ? `Muse Spark placed the joints.${prepared.flagged.length ? " Check the outlined ones." : ""} Drag any that are off: the rig bends at the joints, so shoulders, elbows, hips and knees matter most.`
                  : "Muse Spark couldn't place the joints, so they're guessed from the outline. Check the outlined ones and drag any that are off."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {prepared && joints ? (
              <>
                <JointEditor
                  image={prepared.cutout}
                  width={prepared.width}
                  height={prepared.height}
                  joints={joints}
                  // A flagged joint stops being flagged once the user has moved it.
                  flagged={prepared.flagged.filter((j) => joints[j].x === prepared.joints[j].x && joints[j].y === prepared.joints[j].y)}
                  onChange={(j) => setEdited({ cutout: prepared.cutout, joints: j })}
                  onCommit={sliced ? runPreview : undefined}
                  overlay={sliced && showCuts ? (cuts ?? undefined) : undefined}
                  overlayStale={preview.state !== "idle"}
                />
                {sliced && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Checkbox id="show-cuts" checked={showCuts} onCheckedChange={(c) => setShowCuts(c === true)} />
                      <Label htmlFor="show-cuts" className="font-normal">
                        Show where the rig is cut
                      </Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Each colour is one piece, and each piece turns at its joint, so a thigh should start at the hip, not at the knee. Pads and hands stay whole on their limb, and a cape (brown) is its own piece behind the body.
                    </p>
                    {previewError && <p className="text-xs text-destructive">{previewError}</p>}
                  </div>
                )}
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setEdited(null)} disabled={!edited || edited.cutout !== prepared.cutout}>
                  <RotateCcw /> Reset joints
                </Button>
              </>
            ) : (
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-lg border bg-muted/40 text-sm text-muted-foreground">
                {posing ? <Loader2 className="size-8 animate-spin" aria-hidden /> : <Bone className="size-8" aria-hidden />}
                <span>{posing ? "Posing and placing joints…" : "Nothing posed yet"}</span>
              </div>
            )}
          </CardContent>
          {prepared && (
            <CardFooter className="flex flex-col items-stretch gap-4 border-t pt-6">
              <CardTitle className="text-base">3. Build the rig</CardTitle>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rig-name">Name</Label>
                <Input id="rig-name" name="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Swamp Orc" />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Rig style</Label>
                <ToggleGroup type="single" variant="outline" value={rigStyle} onValueChange={(v) => v && setRigStyle(v as "smooth" | "parts")} disabled={building} className="w-full">
                  <ToggleGroupItem value="smooth" className="flex-1">
                    Smooth
                  </ToggleGroupItem>
                  <ToggleGroupItem value="parts" className="flex-1">
                    Separate parts
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  {sliced
                    ? "Cut into separate pieces, so limbs can swing far: walks, attacks, big arm moves. Seams can show where Muse has to invent what was hidden."
                    : "The picture stays whole and bends with the bones: no seams or tears. Best for idles, breathing and gentle moves."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="rig-public" checked={visibility === "public"} onCheckedChange={(c) => setVisibility(c === true ? "public" : "private")} />
                <Label htmlFor="rig-public" className="font-normal">
                  Make it public in Explore
                </Label>
              </div>
              {buildError && (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <AlertDescription>{buildError}</AlertDescription>
                </Alert>
              )}
              <Button onClick={runBuild} disabled={building || !name.trim() || AUTO_RIG_JOINTS.some((j) => !joints?.[j])}>
                {building ? <Loader2 className="animate-spin" /> : <Bone />}
                {building ? "Building the rig…" : "Build rig"}
              </Button>
              <p className="text-xs text-muted-foreground">
                {!sliced
                  ? building
                    ? "Building the rig. This takes a few seconds."
                    : "The bones are fitted to your joints and the picture is weighted to them. No Muse calls."
                  : building
                    ? "Cutting the character into parts, then Muse paints what's hidden behind each joint. This takes about 20–40 seconds."
                    : `The character is cut into parts at the joints${prepared.gear.length ? `, keeping its ${listGear(prepared.gear)} whole` : " and hands"}, and Muse paints in what's hidden behind them so limbs can move freely.`}
              </p>
            </CardFooter>
          )}
        </Card>
      </div>
    </div>
  );
}

/** "red cape, shoulder pad and knee pad", with the hands always kept whole too. */
function listGear(gear: AutoRigGear[]): string {
  const names = [...gear.map((g) => g.phrase), "hands"];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
