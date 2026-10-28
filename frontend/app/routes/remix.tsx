import { AlertCircle, ArrowLeftRight, ShieldAlert, Bone, Circle, CircleCheck, ExternalLink, Film, Globe, Loader2, Lock, Palette, Search, SlidersHorizontal, Sparkles } from "lucide-react";
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
import { TweakPanel } from "~/components/TweakPanel";
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
  createRemixJob,
  getAccount,
  getAsset,
  getLibrary,
  getMyRemixes,
  getRemixJob,
  getSavedAssetIds,
  listAssets,
} from "~/lib/api.server";
import { getSession, requireSession } from "~/lib/auth.server";
import { SITE_NAME, assetPath, seoMeta } from "~/lib/seo";
import type { AutoTweakCapture } from "~/lib/spine-auto-tweak";
import { hasSavableTweaks } from "~/lib/spine-tweak-bake";
import { DEFAULT_TWEAKS, type RigInfo, type SpineTweakBinding, type SpineTweaks, type TweakExporter } from "~/lib/spine-tweaks";
import { getSiteUrl } from "~/lib/site.server";
import {
  REMIX_API_VERSIONS,
  REMIX_STYLES,
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
    index: !loaderData.base && !loaderData.job && !loaderData.rq,
  });
}

type PickerSource = "library" | "all";

export async function loader({ request, context }: Route.LoaderArgs) {
  // Guests can pick and preview rigs; starting a remix needs an account.
  const session = getSession(context);
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  const rq = params.get("rq")?.slice(0, 200) ?? "";
  const source: PickerSource = params.get("src") === "library" ? "library" : "all";

  const job = jobId && session ? await getRemixJob(session, jobId) : null;
  const baseId = params.get("base") ?? job?.base.id ?? null;

  const [base, savedIds, myRemixes, pickerRigs, account] = await Promise.all([
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
  ]);

  return {
    base,
    job,
    anim: params.get("anim"),
    rq,
    source,
    pickerRigs: source === "library" && rq ? filterRigs(pickerRigs, rq) : pickerRigs,
    recent: myRemixes.filter((a) => a.id !== job?.asset?.id).slice(0, 4),
    savedIds,
    signedIn: session !== null,
    usage: account && { ...account.usage, plan: account.plan },
    siteUrl: getSiteUrl(request),
  };
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
  const { base, job, anim, rq, source, pickerRigs, recent, savedIds, signedIn, usage } = loaderData;
  const [searchParams] = useSearchParams();
  const errors: FieldErrors = actionData?.errors ?? {};
  const { revalidate } = useRevalidator();
  const tweak = useTweakSession(base?.id ?? null);
  const savedRemix = job?.status === "succeeded" ? job.asset : null;
  const previewAnimation = anim ?? (savedRemix ?? base)?.animations[0]?.name ?? "idle";
  const tweakPanel = {
    ...tweak.panel,
    save: useSaveTweaks(savedRemix?.id ?? null, tweak),
    autoTweak: useAutoTweak(base, savedRemix, previewAnimation, tweak),
  };
  // Tweaks need a rig on screen: the original before a remix, or the finished remix.
  const canTweak = !job || savedRemix !== null;
  const [panelTab, setPanelTab] = useState<"generate" | "tweak">("generate");
  const tweaking = canTweak && panelTab === "tweak";
  // Picking and the part outline only make sense while the Tweak tab is open.
  const playerTweaks: SpineTweakBinding = {
    ...tweak.binding,
    picking: tweaking && tweak.binding.picking,
    selectedPart: tweaking ? tweak.binding.selectedPart : null,
  };

  // Poll the job while it's in progress. BACKEND: could be replaced by SSE/WebSocket push.
  const active = job?.status === "queued" || job?.status === "running";
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
                      <TabsTrigger value="tweak" disabled={!canTweak} title={canTweak ? undefined : "Available once the remix finishes"}>
                        <SlidersHorizontal /> Tweak
                      </TabsTrigger>
                    </TabsList>
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
              {!job ? (
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
              ) : job.status === "succeeded" && job.asset ? (
                <>
                  <AssetPlayer
                    asset={job.asset}
                    animation={anim ?? job.asset.animations[0]?.name ?? "idle"}
                    animationHref={(name) => withParams({ anim: name })}
                    tweaks={playerTweaks}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="mr-auto">
                      <h2 className="text-lg font-semibold">{job.asset.name}</h2>
                      <p className="text-xs text-muted-foreground">
                        Remix of {base.name} · API {job.apiVersion}
                        {job.promptStatus === "reworded" && " · prompt re-worded for content policy"}
                      </p>
                    </div>
                    <SaveButton assetId={job.asset.id} assetName={job.asset.name} saved={savedIds.includes(job.asset.id)} />
                    <VisibilityToggle assetId={job.asset.id} assetName={job.asset.name} visibility={job.asset.visibility} />
                    <Button asChild variant="outline">
                      <Link to={assetPath(job.asset)}>
                        <ExternalLink /> Open
                      </Link>
                    </Button>
                  </div>
                </>
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

          <SpriteSheet
            // Remount per rig/result so page and source selection start fresh.
            key={`${base.id}:${job?.asset?.id ?? ""}`}
            sources={[
              ...(job?.status === "succeeded" && job.asset ? [{ label: "Remix", asset: job.asset }] : []),
              { label: "Original", asset: base },
            ]}
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
      : !tweak.exporter.canExport
        ? "This rig's skeleton is a binary .skel file, so edits can't be saved into it."
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
 * live part tweaks. If the review fails, the measured fixes are applied on their own.
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
  const [notes, setNotes] = useState<string | null>(null);
  const { tweaks } = tweak;
  const { onChange } = tweak.panel;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !capture) return;
    if (fetcher.data.ok) {
      const { review } = fetcher.data;
      onChange(capture.apply(tweaks, review));
      const count = review.changes.length;
      setNotes(review.notes || null);
      toast.success(count === 0 ? "Muse found nothing to fix." : `Muse adjusted ${count} part${count === 1 ? "" : "s"}. Save to keep it.`);
    } else if (capture.measuredCount > 0) {
      onChange(capture.measured(tweaks));
      setNotes(null);
      toast.warning(`${fetcher.data.error} Applied the ${capture.measuredCount} measured fix${capture.measuredCount === 1 ? "" : "es"} without Muse's review.`);
    } else {
      toast.error(fetcher.data.error);
    }
    setCapture(null);
    // Runs once per finished review; `onChange` and `tweaks` are read at that moment on purpose.
  }, [fetcher.state, fetcher.data]);

  const disabledReason = !remix?.files
    ? "Run a remix first: auto-tweak compares it with the original rig."
    : !base?.files
      ? "The original rig has no files to compare with."
      : null;

  const onRun = async () => {
    if (!remix?.files || !base?.files) return;
    setCapturing(true);
    setNotes(null);
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
  return { onRun, stage, disabledReason, notes };
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
