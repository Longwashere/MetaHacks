import { AlertCircle, ArrowLeftRight, ShieldAlert, Bone, Circle, CircleCheck, ExternalLink, Film, Globe, Loader2, Lock, Paintbrush, Palette, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useLocation,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/remix";
import type { action as autoTweakAction } from "./api.auto-tweak";
import type { action as saveSkeletonAction } from "./api.remix-skeleton";
import { AssetGrid } from "~/components/AssetGrid";
import { AssetPlayer } from "~/components/AssetPlayer";
import { RigPicker } from "~/components/RigPicker";
import { SaveButton } from "~/components/SaveButton";
import { VisibilityToggle } from "~/components/VisibilityToggle";
import { SpinePreview } from "~/components/SpinePreview";
import { SpriteSheet } from "~/components/SpriteSheet";
import { type AutoTweakPartChange, type AutoTweakResult, TweakPanel } from "~/components/TweakPanel";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import {
  createPartFix,
  createRemixJob,
  getAccount,
  getAsset,
  getLibrary,
  getMyRemixes,
  getPartFix,
  getRemixJob,
  getSavedAssetIds,
  listAssets,
} from "~/lib/api.server";
import { type Session, getSession, requireSession } from "~/lib/auth.server";
import { SITE_NAME, assetPath, seoMeta } from "~/lib/seo";
import type { AutoTweakCapture } from "~/lib/spine-auto-tweak";
import { hasSavableTweaks } from "~/lib/spine-tweak-bake";
import { DEFAULT_PART, DEFAULT_TWEAKS, isDefaultPart, type RigInfo, type SpineTweakBinding, type SpineTweaks, type TweakExporter } from "~/lib/spine-tweaks";
import { getSiteUrl } from "~/lib/site.server";
import {
  PART_FIX_SOURCES,
  REMIX_API_VERSIONS,
  REMIX_STYLES,
  type PartFixJob,
  type RemixApiVersion,
  type RemixJob,
  type RemixStyle,
  type SpineAsset,
} from "~/lib/types";
import { cn } from "~/lib/utils";

export function meta({ loaderData }: Route.MetaArgs) {
  return seoMeta({
    title: `Remix Spine2D Rigs – AI Texture Generator for Spine Animations | ${SITE_NAME}`,
    description:
      "Pick a rigged, animated Spine2D character or prop and re-texture it from a prompt. Bones, slots and every animation are kept — only the look changes.",
    canonical: `${loaderData.siteUrl}/remix`,
    // Only the bare tool page is indexable; selected rigs and jobs are per-user state.
    index: !loaderData.base && !loaderData.job && !loaderData.remix && !loaderData.rq,
  });
}

type PickerSource = "library" | "all";

export async function loader({ request, context }: Route.LoaderArgs) {
  // Guests can pick and preview rigs; starting a remix needs an account.
  const session = getSession(context);
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  const fixId = params.get("fix");
  const rq = params.get("rq")?.slice(0, 200) ?? "";
  const source: PickerSource = params.get("src") === "library" ? "library" : "all";

  const job = jobId && session ? await getRemixJob(session, jobId) : null;
  // A finished remix is opened by asset from here on, like any remix the user owns.
  if (job?.status === "succeeded" && job.asset) throw redirect(`/remix?${remixParams(job.asset.id, params.get("anim"))}`);

  // ?asset=<remixId>: the workspace for one of the user's remixes (or copies), without its job.
  const remix = await loadOwnRemix(params.get("asset"), session);
  const baseId = remix?.remixOf?.id ?? params.get("base") ?? job?.base.id ?? null;

  const [loadedBase, savedIds, myRemixes, pickerRigs, account, fix] = await Promise.all([
    baseId ? getAsset(baseId, session) : null,
    getSavedAssetIds(session),
    session ? getMyRemixes(session) : [],
    // Only load the picker when no rig is selected yet.
    baseId
      ? []
      : source === "library"
        ? session ? getLibrary(session) : []
        : listAssets({ q: rq, sort: "popular" }),
    session ? getAccount(session) : null,
    fixId && session ? getPartFix(session, fixId) : null,
  ]);
  // The rig a remix was made from can be gone or private (a copy of someone's remix of their own
  // private remix). The remix then stands in for it, so the workspace still opens.
  const base = loadedBase ?? remix;

  return {
    base,
    remix,
    job,
    fix,
    anim: params.get("anim"),
    rq,
    source,
    pickerRigs: source === "library" && rq ? filterRigs(pickerRigs, rq) : pickerRigs,
    recent: myRemixes.filter((a) => a.id !== remix?.id).slice(0, 4),
    savedIds,
    signedIn: session !== null,
    usage: account && { ...account.usage, plan: account.plan },
    siteUrl: getSiteUrl(request),
  };
}

const remixParams = (assetId: string, anim: string | null) => new URLSearchParams({ asset: assetId, ...(anim ? { anim } : {}) });

/** The remix named by ?asset=, if the viewer owns it; anyone else is sent to its public page. */
async function loadOwnRemix(assetId: string | null, session: Session | null): Promise<SpineAsset | null> {
  if (!assetId) return null;
  if (!session) throw redirect(`/assets/${encodeURIComponent(assetId)}`);
  const asset = await getAsset(assetId, session);
  if (!asset) throw redirect("/remix");
  if (asset.author.id !== session.user.id || !asset.remixOf || !asset.files) throw redirect(`${assetPath(asset)}?public=1`);
  return asset;
}

function filterRigs(rigs: SpineAsset[], q: string) {
  const needle = q.toLowerCase();
  return rigs.filter((r) => [r.name, r.description, ...r.tags].join(" ").toLowerCase().includes(needle));
}

/** `limit`: the monthly remix allowance is used up. */
type FieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength" | "apiVersion" | "limit", string>>;

const isStyle = (v: unknown): v is RemixStyle => typeof v === "string" && REMIX_STYLES.some((s) => s === v);
const isApiVersion = (v: unknown): v is RemixApiVersion =>
  typeof v === "string" && REMIX_API_VERSIONS.some((s) => s === v);

export async function action({ request, context }: Route.ActionArgs) {
  const session = requireSession(context, request);
  const form = await request.formData();
  if (form.get("intent") === "fix-parts") return fixParts(session, form);
  const errors: FieldErrors = {};

  const baseAssetId = String(form.get("baseAssetId") ?? "");
  const prompt = String(form.get("prompt") ?? "").trim();
  const style = form.get("style");
  const strength = Number(form.get("strength"));
  const keepPalette = form.get("keepPalette") === "on";
  const keepPosition = form.get("keepPosition") === "on";
  const keepSize = form.get("keepSize") === "on";
  const keepOutline = form.get("keepOutline") === "on";
  const apiVersion = form.get("apiVersion");
  // Private unless the user chose public.
  const visibility = form.get("visibility") === "public" ? "public" : "private";

  if (!baseAssetId) errors.base = "Choose a rig to remix.";
  if (prompt.length < 5) errors.prompt = "Describe the new look in at least 5 characters.";
  else if (prompt.length > 500) errors.prompt = "Keep it under 500 characters.";
  if (!isStyle(style)) errors.style = "Choose a style.";
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) errors.strength = "Strength must be 0–100.";
  if (!isApiVersion(apiVersion)) errors.apiVersion = "Choose a remix API version.";

  if (Object.keys(errors).length > 0 || !isStyle(style) || !isApiVersion(apiVersion)) {
    return data({ errors }, { status: 400 });
  }

  const base = await getAsset(baseAssetId, session);
  if (!base?.files) {
    const message = base ? "This rig has no textures to repaint yet. Choose another one." : "That rig no longer exists.";
    return data({ errors: { base: message } satisfies FieldErrors }, { status: 400 });
  }

  const result = await createRemixJob(session, {
    baseAssetId,
    prompt,
    style,
    strength: strength / 100,
    keepPalette,
    keepPosition,
    keepSize,
    keepOutline,
    visibility,
  }, apiVersion);
  if (!result.ok) {
    const key = result.limitReached ? "limit" : result.field === "base" ? "base" : "prompt";
    return data({ errors: { [key]: result.error } satisfies FieldErrors }, { status: result.limitReached ? 402 : 400 });
  }

  throw redirect(`/remix?${new URLSearchParams({ base: baseAssetId, job: result.job.id })}`);
}

/** Same rules as parsePartFixInput in backend/src/lib/validate.ts. */
const MAX_FIX_PARTS = 20;

/** Starts repainting the chosen parts of a finished remix, then reloads the page with `?fix=`. */
async function fixParts(session: Session, form: FormData) {
  const assetId = String(form.get("assetId") ?? "");
  const regions = [...new Set(form.getAll("region").map(String).filter(Boolean))];
  const prompt = String(form.get("fixPrompt") ?? "").trim();
  const source = PART_FIX_SOURCES.find((s) => s === form.get("fixSource")) ?? "original";

  const fixError = !assetId
    ? "Run a remix first."
    : regions.length === 0
      ? "Pick at least one part on the sprite sheet."
      : regions.length > MAX_FIX_PARTS
        ? `Pick at most ${MAX_FIX_PARTS} parts at a time.`
        : prompt.length < 5
          ? "Describe the fix in at least 5 characters."
          : prompt.length > 500
            ? "Keep it under 500 characters."
            : null;
  if (fixError) return data({ fixError }, { status: 400 });

  const result = await createPartFix(session, assetId, { regions, prompt, source });
  if (!result.ok) return data({ fixError: result.error }, { status: 400 });

  throw redirect(`/remix?${new URLSearchParams({ asset: assetId, fix: result.job.id })}`);
}

/** Optional prompt constraints; all off by default so the model can reshape parts. */
const KEEP_PART_OPTIONS = [
  { name: "keepPosition", label: "Position" },
  { name: "keepSize", label: "Size" },
  { name: "keepOutline", label: "Outline" },
] as const;

const EXAMPLE_PROMPTS = [
  "Black and crimson ninja outfit, moonlit palette",
  "Golden ceremonial armor with jade inlays",
  "Zombie version — torn clothes, pale green skin",
  "Cyberpunk neon trims and chrome plating",
];

export default function Remix({ loaderData, actionData }: Route.ComponentProps) {
  const { base, remix, job, fix, anim, rq, source, pickerRigs, recent, savedIds, signedIn, usage } = loaderData;
  const [searchParams] = useSearchParams();
  const errors: FieldErrors = actionData && "errors" in actionData ? actionData.errors : {};
  const fixError = actionData && "fixError" in actionData ? actionData.fixError : null;
  const { revalidate } = useRevalidator();
  const tweak = useTweakSession(base?.id ?? null);
  // A finished part fix carries the remix as it saved it. The loader reads the remix first, so on
  // the poll where the fix finishes, the remix can still have the files from before the fix.
  const fixedRemix = fix?.status === "succeeded" && fix.asset?.id === remix?.id ? fix.asset : null;
  const savedRemix = remix && (fixedRemix ?? remix);
  const previewAnimation = anim ?? (savedRemix ?? base)?.animations[0]?.name ?? "idle";
  const tweakPanel = {
    ...tweak.panel,
    save: useSaveTweaks(savedRemix?.id ?? null, tweak),
    autoTweak: useAutoTweak(base, savedRemix, previewAnimation, tweak),
  };
  // Tweaks need a rig on screen: the original before a remix, or the finished remix. Binary .skel
  // rigs can't take them: the bake that saves them only edits skeleton JSON.
  const binaryRig = (savedRemix ?? base)?.files?.skeletonUrl.toLowerCase().endsWith(".skel") ?? false;
  const canTweak = (!job || savedRemix !== null) && !binaryRig;
  const [panelTab, setPanelTab] = useState<"generate" | "tweak">("generate");
  const tweaking = canTweak && panelTab === "tweak";
  // Picking and the part outline only make sense while the Tweak tab is open.
  const playerTweaks: SpineTweakBinding = {
    ...tweak.binding,
    picking: tweaking && tweak.binding.picking,
    selectedPart: tweaking ? tweak.binding.selectedPart : null,
  };

  // Poll the job while it's in progress. BACKEND: could be replaced by SSE/WebSocket push.
  const active = job?.status === "queued" || job?.status === "running" || fix?.status === "queued" || fix?.status === "running";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(revalidate, 1000);
    return () => clearInterval(t);
  }, [active, revalidate]);

  const withParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    return `?${next}`;
  };

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Remix a rig</h1>
        <p className="text-muted-foreground">
          Pick an existing Spine rig and describe a new look. The skeleton and every animation stay the same — only the textures change.
        </p>
      </div>

      {!base ? (
        <section aria-labelledby="pick-heading" className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 id="pick-heading" className="text-xl font-semibold tracking-tight">
              <span className="text-muted-foreground">Step 1 ·</span> Choose a rig
            </h2>
            <Tabs value={source}>
              <TabsList>
                <TabsTrigger value="all" asChild>
                  <Link to={withParams({ src: null })} replace preventScrollReset>
                    All rigs
                  </Link>
                </TabsTrigger>
                <TabsTrigger value="library" asChild>
                  <Link to={withParams({ src: "library" })} replace preventScrollReset>
                    My library
                  </Link>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Form method="get" role="search" className="flex gap-2" key={rq}>
            {source === "library" && <input type="hidden" name="src" value="library" />}
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <label htmlFor="rig-q" className="sr-only">
                Search rigs
              </label>
              <Input id="rig-q" name="rq" defaultValue={rq} placeholder="Search rigs: monk, knight, slime…" className="pl-9" />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </Form>
          {errors.base && <p className="text-sm text-destructive">{errors.base}</p>}
          {pickerRigs.length > 0 ? (
            <RigPicker rigs={pickerRigs} selectHref={(rig) => `?${new URLSearchParams({ base: rig.id })}`} />
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bone />
                </EmptyMedia>
                <EmptyTitle>{source === "library" && !rq ? "Your library is empty" : "No rigs found"}</EmptyTitle>
                <EmptyDescription>
                  {source === "library" && !rq
                    ? "Save rigs from Explore and they'll show up here, ready to remix."
                    : "Try a different search."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="outline">
                  <Link to="/explore">Browse Explore</Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </section>
      ) : (
        <div className="flex flex-col gap-8">
          {/* The two columns get their own grid so the sticky preview stops above the sprite sheet. */}
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="flex flex-col gap-6 lg:self-start">
              <BaseRigSummary base={base} />
              <Card>
                <Tabs
                  value={tweaking ? "tweak" : "generate"}
                  onValueChange={(v) => setPanelTab(v === "tweak" ? "tweak" : "generate")}
                  className="gap-6"
                >
                  <div className="px-6">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="generate">
                        <Sparkles /> Generate
                      </TabsTrigger>
                      <TabsTrigger
                        value="tweak"
                        disabled={!canTweak}
                        title={canTweak ? undefined : binaryRig ? "Not available for binary .skel rigs" : "Available once the remix finishes"}
                      >
                        <SlidersHorizontal /> Tweak
                      </TabsTrigger>
                    </TabsList>
                    {binaryRig && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Tweaks aren't available for this rig: its skeleton is a binary .skel file, and edits can only be saved into JSON.
                        Re-export it from Spine as JSON to tweak it.
                      </p>
                    )}
                  </div>
                  {/* Both tabs stay mounted so the prompt and the tweak panel keep their state. */}
                  <TabsContent value="generate" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
                    <CardHeader>
                      <CardTitle>
                        <span className="text-muted-foreground">Step 2 ·</span> Describe the new look
                      </CardTitle>
                      <CardDescription>Textures are repainted to fit the existing atlas regions, so every animation keeps working.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <RemixForm key={base.id} base={base} errors={errors} signedIn={signedIn} usage={usage} />
                    </CardContent>
                  </TabsContent>
                  <TabsContent value="tweak" forceMount className="data-[state=inactive]:hidden">
                    <CardContent>
                      <TweakPanel {...tweakPanel} />
                    </CardContent>
                  </TabsContent>
                </Tabs>
              </Card>
            </div>

            {/* Sticks while the tweak panel scrolls, so the rig stays beside the controls. */}
            <section aria-label="Result" aria-live="polite" className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
              {savedRemix ? (
                <>
                  <AssetPlayer
                    asset={savedRemix}
                    animation={anim ?? savedRemix.animations[0]?.name ?? "idle"}
                    animationHref={(name) => withParams({ anim: name })}
                    tweaks={playerTweaks}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="mr-auto">
                      <h2 className="text-lg font-semibold">{savedRemix.name}</h2>
                      <p className="text-xs text-muted-foreground">
                        {savedRemix.copyOf ? `Copy of ${savedRemix.copyOf.name}` : `Remix of ${savedRemix.remixOf?.name ?? base.name}`}
                      </p>
                    </div>
                    <SaveButton assetId={savedRemix.id} assetName={savedRemix.name} saved={savedIds.includes(savedRemix.id)} />
                    <VisibilityToggle assetId={savedRemix.id} assetName={savedRemix.name} visibility={savedRemix.visibility} />
                    <Button asChild variant="outline">
                      <Link to={`${assetPath(savedRemix)}?public=1`}>
                        <ExternalLink /> View public page
                      </Link>
                    </Button>
                  </div>
                </>
              ) : !job ? (
                <>
                  <AssetPlayer
                    asset={base}
                    animation={anim ?? base.animations[0]?.name ?? "idle"}
                    animationHref={(name) => withParams({ anim: name })}
                    tweaks={playerTweaks}
                  />
                  <p className="text-center text-sm text-muted-foreground">Previewing the original rig. Your remix will appear here.</p>
                </>
              ) : job.status === "failed" ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Remix failed</AlertTitle>
                  <AlertDescription>
                    {job.error ?? "Something went wrong. Try again with a different prompt."}
                    <ExpandedPrompt job={job} />
                  </AlertDescription>
                </Alert>
              ) : (
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />{" "}
                      {job.promptStatus === "rewording" ? "Re-wording the prompt" : job.stage}
                    </CardTitle>
                    <CardDescription className="line-clamp-2">“{job.input.prompt}”</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <RemixProgress job={job} />
                    {job.promptStatus === "rewording" && (
                      <Alert>
                        <ShieldAlert />
                        <AlertTitle>The image model declined the prompt</AlertTitle>
                        <AlertDescription>
                          Its content policy rejected the prompt below, so Muse is re-wording it to keep the same look. The
                          page is then painted again.
                        </AlertDescription>
                      </Alert>
                    )}
                    <ExpandedPrompt job={job} />
                    <SpinePreview
                      asset={job.base}
                      className="animate-pulse rounded-lg opacity-50"
                      showBones
                    />
                  </CardContent>
                </Card>
              )}
            </section>
          </div>

          <PartFixSection
            // Remount per rig/result so page, source and part selection start fresh.
            key={`${base.id}:${savedRemix?.id ?? ""}`}
            base={base}
            remix={savedRemix}
            fix={fix?.assetId === savedRemix?.id ? fix : null}
            error={fixError}
            usage={usage}
          />
        </div>
      )}

      {recent.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex items-end justify-between">
            <h2 className="text-xl font-semibold tracking-tight">Your recent remixes</h2>
            <Button asChild variant="ghost" size="sm">
              <Link to="/library?tab=remixes">View all</Link>
            </Button>
          </div>
          <AssetGrid assets={recent} savedIds={savedIds} />
        </section>
      )}
    </div>
  );
}

/**
 * The sprite sheet with a "Fix parts" panel beside it. Once a remix has finished, clicking regions
 * on the sheet picks them, and the panel repaints just those parts from a prompt.
 */
function PartFixSection({
  base,
  remix,
  fix,
  error,
  usage,
}: {
  base: SpineAsset;
  remix: SpineAsset | null;
  fix: PartFixJob | null;
  error: string | null;
  usage: RemixUsage | null;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting" && navigation.formData?.get("intent") === "fix-parts";
  const fixing = fix?.status === "queued" || fix?.status === "running";
  const revalidator = useRevalidator();

  const onToggle = (region: string) => {
    if (selected.includes(region)) {
      setSelected(selected.filter((r) => r !== region));
    } else if (selected.length >= MAX_FIX_PARTS) {
      toast(`Pick at most ${MAX_FIX_PARTS} parts at a time.`);
    } else {
      setSelected([...selected, region]);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <Card className="lg:self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Paintbrush className="size-4" /> Fix parts
          </CardTitle>
          <CardDescription>
            {remix
              ? "Click the parts that came out wrong on the sprite sheet, then describe how they should look. Only those parts are repainted; the rest of the remix stays as it is."
              : "Once your remix finishes, you can pick parts that came out wrong on the sprite sheet and repaint just those."}
          </CardDescription>
        </CardHeader>
        {remix && (
          <CardContent>
            <Form method="post" preventScrollReset className="flex flex-col gap-5">
              <input type="hidden" name="intent" value="fix-parts" />
              <input type="hidden" name="assetId" value={remix.id} />
              {selected.map((r) => (
                <input key={r} type="hidden" name="region" value={r} />
              ))}

              <div className="flex flex-col gap-2">
                <div className="flex min-h-8 items-center justify-between">
                  <span className="text-sm font-medium">Selected parts</span>
                  {selected.length > 0 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  )}
                </div>
                {selected.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None yet. Click a box on the sprite sheet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {selected.map((r) => (
                      <li key={r}>
                        <Badge variant="secondary" className="gap-1 pr-1">
                          {r}
                          <button
                            type="button"
                            onClick={() => onToggle(r)}
                            aria-label={`Remove ${r}`}
                            className="cursor-pointer rounded-sm p-0.5 hover:bg-background/60"
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="fixPrompt">What should they look like?</Label>
                <Textarea
                  id="fixPrompt"
                  name="fixPrompt"
                  rows={3}
                  maxLength={500}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. a green lower jaw with two ivory tusks, same style as the head"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "fix-error" : undefined}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="fixSource">Start from</Label>
                <Select name="fixSource" defaultValue="original">
                  <SelectTrigger id="fixSource" className="w-full" aria-describedby="fixSource-hint">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="original">The original part</SelectItem>
                    <SelectItem value="remix">The remix's current part</SelectItem>
                  </SelectContent>
                </Select>
                <p id="fixSource-hint" className="text-xs text-muted-foreground">
                  Start from the original when the part came out as the wrong thing; from the remix for small changes.
                </p>
              </div>

              <FieldError id="fix-error" message={error ?? undefined} />
              {fix && <PartFixStatus fix={fix} />}

              <div className="flex flex-col gap-2">
                <Button type="submit" disabled={selected.length === 0 || fixing || submitting} className="w-full">
                  {submitting || fixing ? <Loader2 className="animate-spin" /> : <Paintbrush />}
                  {submitting
                    ? "Starting…"
                    : fixing
                      ? "Repainting…"
                      : selected.length === 0
                        ? "Repaint parts"
                        : `Repaint ${selected.length} part${selected.length === 1 ? "" : "s"}`}
                </Button>
                <p className="text-center text-xs text-muted-foreground">Uses one remix from your monthly allowance.</p>
                {usage && <RemixAllowance usage={usage} />}
              </div>
            </Form>
          </CardContent>
        )}
      </Card>

      <SpriteSheet
        className="lg:col-span-2"
        // When the original rig is gone, the remix stands in as the base: show it once.
        sources={[...(remix ? [{ label: "Remix", asset: remix }] : []), ...(base.id === remix?.id ? [] : [{ label: "Original", asset: base }])]}
        selection={remix ? { selected, onToggle, disabled: fixing } : undefined}
        // After a part fix, reloads the remix's files in case the sheet still shows the old pages.
        refresh={
          fix?.status === "succeeded"
            ? { onRefresh: () => void revalidator.revalidate(), pending: revalidator.state === "loading" }
            : undefined
        }
      />
    </div>
  );
}

function PartFixStatus({ fix }: { fix: PartFixJob }) {
  const parts = fix.input.regions.join(", ");
  const percent = Math.round(fix.progress * 100);
  return (
    <div className="flex flex-col gap-3">
      {fix.status === "failed" ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Fix failed</AlertTitle>
          <AlertDescription>{fix.error ?? "Something went wrong. Try again with a different prompt."}</AlertDescription>
        </Alert>
      ) : fix.status === "succeeded" ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>Repainted {parts}</AlertTitle>
          <AlertDescription>The remix and its download now use the new parts. Not right? Pick them again and try another prompt.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {fix.stage}: {parts}
            </span>
            <span className="tabular-nums">{percent}%</span>
          </div>
          <Progress value={percent} aria-label="Fix progress" />
        </div>
      )}
      {fix.editPrompt && (
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="font-medium text-foreground">Expanded prompt</span>
          <p className="max-h-32 overflow-y-auto whitespace-pre-line text-muted-foreground">{fix.editPrompt}</p>
        </div>
      )}
    </div>
  );
}

interface TweakSession {
  key: string | null;
  tweaks: SpineTweaks;
  rig: RigInfo | null;
  part: string | null;
  bone: string | null;
  picking: boolean;
  exporter: TweakExporter | null;
}

/**
 * Tweak state for the previewed rig. It carries over from the original to the finished remix
 * (same skeleton) and starts fresh when another rig is chosen.
 */
function useTweakSession(key: string | null) {
  const fresh: TweakSession = { key, tweaks: DEFAULT_TWEAKS, rig: null, part: null, bone: null, picking: false, exporter: null };
  const [session, setSession] = useState(fresh);
  let current = session;
  if (session.key !== key) {
    current = fresh;
    setSession(fresh);
  }
  const update = (patch: Partial<TweakSession>) => setSession((s) => ({ ...s, ...patch }));

  const binding: SpineTweakBinding = {
    tweaks: current.tweaks,
    selectedPart: current.part,
    picking: current.picking,
    onPickPart: (part) => update({ part }),
    onRigInfo: (rig) => update({ rig }),
    onExporter: (exporter) => update({ exporter }),
  };
  const panel = {
    tweaks: current.tweaks,
    onChange: (tweaks: SpineTweaks) => update({ tweaks }),
    rig: current.rig,
    selectedPart: current.part,
    onSelectPart: (part: string | null) => update({ part }),
    picking: current.picking,
    onPickingChange: (picking: boolean) => update({ picking }),
    selectedBone: current.bone,
    onSelectBone: (bone: string | null) => update({ bone }),
  };
  return {
    binding,
    panel,
    tweaks: current.tweaks,
    exporter: current.exporter,
    /** Clears the edits after they've been saved into the rig. Selection and Pick mode stay, so editing can go on. */
    clear: () => update({ tweaks: DEFAULT_TWEAKS }),
  };
}

/**
 * Save for the tweak panel: bakes the tweaks into the skeleton JSON in the browser (the live rig
 * knows the setup pose the bake needs), then stores it as the remix's skeleton. Only a finished
 * remix can be saved; the original rig belongs to someone else.
 */
function useSaveTweaks(remixId: string | null, tweak: ReturnType<typeof useTweakSession>) {
  const fetcher = useFetcher<typeof saveSkeletonAction>();
  const [exporting, setExporting] = useState(false);
  const { clear } = tweak;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      // The saved skeleton now carries the edits, so drop them from the live preview.
      clear();
      toast.success("Saved. The remix's download now includes your edits.");
    } else {
      toast.error(fetcher.data.error);
    }
    // Runs once per finished save; `clear` changes identity every render, so it's left out.
  }, [fetcher.state, fetcher.data]);

  const disabledReason = !remixId
    ? "Live in your browser, no model calls. Run a remix to save edits into its skeleton file."
    : !tweak.exporter
      ? "Loading the rig…"
      : null;

  const onSave = async () => {
    if (!remixId || !tweak.exporter) return;
    if (!hasSavableTweaks(tweak.tweaks)) {
      toast("Nothing to save: only Look, Rig and Parts edits are written to the file.");
      return;
    }
    setExporting(true);
    try {
      const { skeleton, skin } = await tweak.exporter.exportSkeleton(tweak.tweaks);
      fetcher.submit(JSON.stringify({ assetId: remixId, skeleton, skin }), {
        method: "post",
        action: "/api/remix-skeleton",
        encType: "text/plain",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the edits.");
    } finally {
      setExporting(false);
    }
  };

  return { onSave, pending: exporting || fetcher.state !== "idle", disabledReason };
}

/**
 * Auto-tweak for the tweak panel: renders and measures the original and the remix in the
 * browser (lib/spine-auto-tweak), has Muse review the measured fixes, and applies its answer as
 * live part tweaks. If the review fails, the measured fixes are applied on their own. The result
 * lists every part it changed, before and after, so the user can check it or undo it.
 */
function useAutoTweak(
  base: SpineAsset | null,
  remix: SpineAsset | null,
  animation: string,
  tweak: ReturnType<typeof useTweakSession>,
) {
  const fetcher = useFetcher<typeof autoTweakAction>();
  const [capture, setCapture] = useState<AutoTweakCapture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [result, setResult] = useState<AutoTweakResult | null>(null);
  const { tweaks } = tweak;
  const { onChange } = tweak.panel;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !capture) return;
    const reviewed = fetcher.data.ok;
    if (!reviewed && capture.measuredCount === 0) {
      toast.error(fetcher.data.error);
    } else {
      const review = fetcher.data.ok ? fetcher.data.review : null;
      const next = review ? capture.apply(tweaks, review) : capture.measured(tweaks);
      const reasons = new Map(review?.changes.map((c) => [c.part, c.reason]));
      const measured = new Map(capture.parts.flatMap((p) => (p.measured ? [[p.name, p.measured] as const] : [])));
      const changes = partChanges(tweaks.parts, next.parts).map((c): AutoTweakPartChange => {
        const fix = measured.get(c.part);
        const change = review?.changes.find((r) => r.part === c.part);
        // Muse kept the measurement when it sent back the same numbers.
        const kept = !change || (fix !== undefined && (["x", "y", "scale", "rotate"] as const).every((k) => Math.abs(change[k] - fix[k]) < 0.01));
        const grow = capture.grows.get(c.part);
        const grew = grow !== undefined ? `Its art was cut off by the mesh outline, so the outline grew ${Math.round(grow * 100)}%.` : null;
        const reason = reasons.get(c.part) ?? (review || !measured.has(c.part) ? "" : "Measured drift from the original.");
        return { ...c, source: kept ? "measured" : "muse", reason: [reason, grew].filter(Boolean).join(" ") };
      });
      onChange(next);
      setResult({ changes, notes: review?.notes || null, measuredOnly: !review });
      if (fetcher.data.ok) {
        const count = changes.length;
        toast.success(count === 0 ? "Muse found nothing to fix." : `Changed ${count} part${count === 1 ? "" : "s"}. See the list in the panel.`);
      } else {
        toast.warning(`${fetcher.data.error} Applied the measured fixes without Muse's review.`);
      }
    }
    setCapture(null);
    // Runs once per finished review; `onChange` and `tweaks` are read at that moment on purpose.
  }, [fetcher.state, fetcher.data]);

  /** Restores the transform and outline grow the run changed on each part, leaving any later colour or blend edits. */
  const onUndo = () => {
    if (!result) return;
    let parts = tweaks.parts;
    for (const { part, before } of result.changes) {
      const { [part]: current, ...rest } = parts;
      const restored = { ...(current ?? DEFAULT_PART), dx: before.dx, dy: before.dy, scale: before.scale, rotation: before.rotation, grow: before.grow };
      parts = isDefaultPart(restored) ? rest : { ...rest, [part]: restored };
    }
    onChange({ ...tweaks, parts });
    setResult(null);
    toast("Undid the auto-tweak.");
  };

  const disabledReason = !remix?.files
    ? "Run a remix first: auto-tweak compares it with the original rig."
    : !base?.files
      ? "The original rig has no files to compare with."
      : null;

  const onRun = async () => {
    if (!remix?.files || !base?.files) return;
    setCapturing(true);
    setResult(null);
    try {
      // Loaded on demand: it pulls in the Spine runtime and only runs in the browser.
      const { captureAutoTweak } = await import("~/lib/spine-auto-tweak");
      const result = await captureAutoTweak({ original: base.files, remix: remix.files, animation, tweaks });
      setCapture(result);
      fetcher.submit(
        JSON.stringify({ assetId: remix.id, animation, images: result.images, parts: result.parts }),
        { method: "post", action: "/api/auto-tweak", encType: "text/plain" },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't snapshot the rigs.");
    } finally {
      setCapturing(false);
    }
  };

  const stage = capturing
    ? "Snapshotting and measuring both rigs…"
    : fetcher.state !== "idle"
      ? "Muse is reviewing the fixes…"
      : null;
  return { onRun, stage, disabledReason, result, onUndo };
}

/** Parts whose offset, scale, rotation or outline grow differ between two part maps. */
function partChanges(before: SpineTweaks["parts"], after: SpineTweaks["parts"]) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].flatMap((part) => {
    const b = before[part] ?? DEFAULT_PART;
    const a = after[part] ?? DEFAULT_PART;
    const same = b.dx === a.dx && b.dy === a.dy && b.scale === a.scale && b.rotation === a.rotation && b.grow === a.grow;
    return same ? [] : [{ part, before: b, after: a }];
  });
}

// Milestones mirror the progress values the backend reports (backend/src/lib/remix.ts).
const REMIX_STEPS = [
  { label: "Read rig", until: 0.1 },
  { label: "Plan look", until: 0.2 },
  { label: "Paint textures", until: 0.95 },
  { label: "Pack atlas", until: 1 },
];

/** Muse's expanded prompt for the image model, flagged when it was re-worded for the content policy. */
function ExpandedPrompt({ job }: { job: RemixJob }) {
  if (!job.editPrompt) return null;
  return (
    <div className="flex w-full flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Expanded prompt</span>
        {job.promptStatus === "rewording" && job.status === "running" && (
          <Badge variant="outline">
            <Loader2 className="animate-spin" /> Re-wording for content policy
          </Badge>
        )}
        {job.promptStatus === "reworded" && <Badge variant="secondary">Re-worded for content policy</Badge>}
      </div>
      <p className="max-h-32 overflow-y-auto text-muted-foreground">{job.editPrompt}</p>
    </div>
  );
}

function RemixProgress({ job }: { job: RemixJob }) {
  const percent = Math.round(job.progress * 100);
  const current = REMIX_STEPS.findIndex((step) => job.progress < step.until);
  const elapsed = useElapsedSeconds(job.createdAt);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{percent}%</span>
        {elapsed !== null && <span>{formatElapsed(elapsed)} elapsed</span>}
      </div>
      <Progress value={percent} aria-label="Remix progress" />
      <ol className="grid grid-cols-4 gap-2 text-xs">
        {REMIX_STEPS.map((step, i) => {
          const state = current === -1 || i < current ? "done" : i === current ? "active" : "todo";
          return (
            <li
              key={step.label}
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5",
                state === "todo" ? "text-muted-foreground" : "text-foreground",
                state === "active" && "font-medium",
              )}
            >
              {state === "done" ? (
                <CircleCheck className="size-3.5 shrink-0 text-primary" />
              ) : state === "active" ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <Circle className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Seconds since `since`, ticking every second. Null until mounted, so SSR and hydration agree. */
function useElapsedSeconds(since: string): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now === null ? null : Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function BaseRigSummary({ base }: { base: SpineAsset }) {
  return (
    <Card className="flex-row items-center gap-4 p-3">
      <SpinePreview asset={base} className="size-20 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Step 1 · Base rig</span>
        <Link to={assetPath(base)} className="truncate font-medium hover:underline">
          {base.name}
        </Link>
        <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Bone className="size-3" /> {base.boneCount} bones
          </span>
          <span className="flex items-center gap-1">
            <Film className="size-3" /> {base.animations.length} animations kept
          </span>
        </span>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/remix">
          <ArrowLeftRight /> Change
        </Link>
      </Button>
    </Card>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

interface RemixUsage {
  used: number;
  /** null = unlimited (admins). */
  limit: number | null;
  resetsAt: string;
  plan: "free" | "pro";
}

function RemixForm({
  base,
  errors,
  signedIn,
  usage,
}: {
  base: SpineAsset;
  errors: FieldErrors;
  signedIn: boolean;
  usage: RemixUsage | null;
}) {
  const location = useLocation();
  const [prompt, setPrompt] = useState("");
  const [strength, setStrength] = useState(60);
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting" && navigation.formData?.get("baseAssetId") === base.id;

  return (
    <Form method="post" className="flex flex-col gap-6">
      <input type="hidden" name="baseAssetId" value={base.id} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="prompt">New texture</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={4}
          maxLength={500}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should ${base.name} look like?`}
          aria-invalid={Boolean(errors.prompt)}
          aria-describedby={errors.prompt ? "prompt-error" : undefined}
        />
        <FieldError id="prompt-error" message={errors.prompt} />
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((example) => (
            <Badge key={example} variant="outline" asChild>
              <button type="button" onClick={() => setPrompt(example)} className="cursor-pointer hover:bg-accent">
                {example}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="style">Art style</Label>
          <Select name="style" defaultValue="auto">
            <SelectTrigger id="style" className="w-full capitalize" aria-invalid={Boolean(errors.style)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMIX_STYLES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s === "auto" ? "Auto (from prompt)" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Auto uses a style named in your prompt, or keeps the {base.style} style.
          </p>
          <FieldError id="style-error" message={errors.style} />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="strength">Remix strength</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{strength}%</span>
          </div>
          <Slider
            id="strength"
            name="strength"
            min={0}
            max={100}
            step={5}
            value={[strength]}
            onValueChange={([v]) => setStrength(v)}
            aria-label="Remix strength"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Subtle</span>
            <span>Reimagined</span>
          </div>
          <FieldError id="strength-error" message={errors.strength} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id="keepPalette" name="keepPalette" />
        <Label htmlFor="keepPalette" className="font-normal">
          <Palette className="size-4 text-muted-foreground" /> Keep the original color palette
        </Label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Keep each part's exact</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {KEEP_PART_OPTIONS.map(({ name, label }) => (
            <div key={name} className="flex items-center gap-2">
              <Checkbox id={name} name={name} />
              <Label htmlFor={name} className="font-normal">
                {label}
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
      <FieldError id="base-error" message={errors.base} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="visibility">Who can see it</Label>
        <Select name="visibility" defaultValue="private">
          <SelectTrigger id="visibility" className="w-full" aria-describedby="visibility-hint">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">
              <Lock /> Private — only you
            </SelectItem>
            <SelectItem value="public">
              <Globe /> Public — shown in Explore, anyone can remix it
            </SelectItem>
          </SelectContent>
        </Select>
        <p id="visibility-hint" className="text-xs text-muted-foreground">
          You can change this later from the remix or your library.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="apiVersion">Remix API</Label>
        <Select name="apiVersion" defaultValue="v2">
          <SelectTrigger id="apiVersion" className="w-full sm:w-48" aria-invalid={Boolean(errors.apiVersion)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REMIX_API_VERSIONS.map((v) => (
              <SelectItem key={v} value={v}>
                {v === "v2" ? "v2 (default)" : v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError id="apiVersion-error" message={errors.apiVersion} />
      </div>

      {errors.limit && (
        <Alert>
          <AlertCircle />
          <AlertTitle>Monthly remixes used up</AlertTitle>
          <AlertDescription>
            {errors.limit}
            {usage?.plan !== "pro" && (
              <Button asChild size="sm" className="mt-2">
                <Link to="/account">Upgrade to Pro</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {signedIn ? (
        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" disabled={submitting} className="w-full">
            {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitting ? "Starting…" : "Remix textures"}
          </Button>
          {usage && <RemixAllowance usage={usage} />}
        </div>
      ) : (
        <Button asChild size="lg" className="w-full">
          <Link to={`/login?${new URLSearchParams({ next: location.pathname + location.search })}`} rel="nofollow">
            <Sparkles /> Sign in to remix
          </Link>
        </Button>
      )}
    </Form>
  );
}

function RemixAllowance({ usage }: { usage: RemixUsage }) {
  if (usage.limit === null) {
    return <p className="text-center text-xs text-muted-foreground">Unlimited remixes (admin) · {usage.used} this month</p>;
  }
  const left = Math.max(usage.limit - usage.used, 0);
  const resets = new Date(usage.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <p className="text-center text-xs text-muted-foreground">
      {left} of {usage.limit} {usage.plan === "pro" ? "Pro" : "free"} remixes left this month · resets {resets}
      {usage.plan === "free" && (
        <>
          {" · "}
          <Link to="/account" className="font-medium text-foreground underline-offset-4 hover:underline">
            Upgrade
          </Link>
        </>
      )}
    </p>
  );
}
