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
import { createAutoRig, getAccount, prepareAutoRig } from "~/lib/api.server";
import { requireSession } from "~/lib/auth.server";
import { assetPath, SITE_NAME } from "~/lib/seo";
import { AUTO_RIG_JOINTS, type AutoRigJoints, type AutoRigView, type PreparedAutoRig } from "~/lib/types";

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

type ActionResult = { intent: "prepare"; ok: true; rig: PreparedAutoRig } | { intent: "prepare" | "create"; ok: false; error: string };

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

  if (intent === "create") {
    const cutout = form.get("cutout");
    let joints: unknown = null;
    try {
      joints = JSON.parse(String(form.get("joints")));
    } catch {
      // Reported below.
    }
    if (typeof cutout !== "string" || typeof joints !== "object" || joints === null) return data<ActionResult>({ intent, ok: false, error: "Pose the character first." }, { status: 400 });
    const result = await createAutoRig(session, {
      name: String(form.get("name") ?? ""),
      view,
      visibility: form.get("visibility") === "public" ? "public" : "private",
      cutout,
      joints: joints as AutoRigJoints,
    });
    if (!result.ok) return data<ActionResult>({ intent, ok: false, error: result.error }, { status: 400 });
    throw redirect(assetPath(result.asset));
  }

  return data<ActionResult>({ intent: "prepare", ok: false, error: "Unknown action." }, { status: 400 });
}

export default function AutoRigPage({ loaderData }: Route.ComponentProps) {
  const pose = useFetcher<typeof action>();
  const build = useFetcher<typeof action>();
  const inputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<{ dataUrl: string; name: string; png: boolean } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [view, setView] = useState<AutoRigView>("front");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  // The user's joint edits, tied to the cutout they were made on, so a new pose starts fresh.
  const [edited, setEdited] = useState<{ cutout: string; joints: AutoRigJoints } | null>(null);

  const posing = pose.state !== "idle";
  const building = build.state !== "idle";
  const prepared = pose.data?.ok && pose.data.intent === "prepare" ? pose.data.rig : null;
  const joints = prepared ? (edited?.cutout === prepared.cutout ? edited.joints : prepared.joints) : null;
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

  const runBuild = () => {
    if (!prepared || !joints) return;
    const body = new FormData();
    body.set("intent", "create");
    body.set("name", name);
    body.set("view", view);
    body.set("visibility", visibility);
    body.set("cutout", prepared.cutout);
    body.set("joints", JSON.stringify(joints));
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
                {posing ? "This takes about 15–35 seconds." : image?.png ? "“As-is” skips Muse. It needs a transparent background and works best when the arms and legs are already spread." : "Muse redraws the character standing with its arms and legs spread."}
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
              {prepared ? "Drag any joint that's off. Shoulders, elbows, hips and knees matter most." : "The posed character and its joints show here."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {prepared && joints ? (
              <>
                <JointEditor image={prepared.cutout} width={prepared.width} height={prepared.height} joints={joints} onChange={(j) => setEdited({ cutout: prepared.cutout, joints: j })} />
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setEdited(null)} disabled={!edited || edited.cutout !== prepared.cutout}>
                  <RotateCcw /> Reset joints
                </Button>
              </>
            ) : (
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-lg border bg-muted/40 text-sm text-muted-foreground">
                {posing ? <Loader2 className="size-8 animate-spin" aria-hidden /> : <Bone className="size-8" aria-hidden />}
                <span>{posing ? "Posing…" : "Nothing posed yet"}</span>
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
            </CardFooter>
          )}
        </Card>
      </div>
    </div>
  );
}
