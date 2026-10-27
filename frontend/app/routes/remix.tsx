import { AlertCircle, ArrowLeftRight, ShieldAlert, Bone, Circle, CircleCheck, ExternalLink, Film, Loader2, Palette, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/remix";
import { AssetGrid } from "~/components/AssetGrid";
import { AssetPlayer } from "~/components/AssetPlayer";
import { RigPicker } from "~/components/RigPicker";
import { SaveButton } from "~/components/SaveButton";
import { SpinePreview } from "~/components/SpinePreview";
import { SpriteSheet } from "~/components/SpriteSheet";
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
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import {
  createRemixJob,
  getAsset,
  getLibrary,
  getMyRemixes,
  getRemixJob,
  getSavedAssetIds,
  listAssets,
} from "~/lib/api.server";
import { getCurrentUser } from "~/lib/auth.server";
import { SITE_NAME, assetPath, seoMeta } from "~/lib/seo";
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

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getCurrentUser(request);
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  const rq = params.get("rq")?.slice(0, 200) ?? "";
  const source: PickerSource = params.get("src") === "library" ? "library" : "all";

  const job = jobId ? await getRemixJob(user.id, jobId) : null;
  const baseId = params.get("base") ?? job?.base.id ?? null;

  const [base, savedIds, myRemixes, pickerRigs] = await Promise.all([
    baseId ? getAsset(baseId) : null,
    getSavedAssetIds(user.id),
    getMyRemixes(user.id),
    // Only load the picker when no rig is selected yet.
    baseId
      ? []
      : source === "library"
        ? getLibrary(user.id)
        : listAssets({ q: rq, sort: "popular" }),
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
    siteUrl: getSiteUrl(request),
  };
}

function filterRigs(rigs: SpineAsset[], q: string) {
  const needle = q.toLowerCase();
  return rigs.filter((r) => [r.name, r.description, ...r.tags].join(" ").toLowerCase().includes(needle));
}

type FieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength" | "apiVersion", string>>;

const isStyle = (v: unknown): v is RemixStyle => typeof v === "string" && REMIX_STYLES.some((s) => s === v);
const isApiVersion = (v: unknown): v is RemixApiVersion =>
  typeof v === "string" && REMIX_API_VERSIONS.some((s) => s === v);

export async function action({ request }: Route.ActionArgs) {
  const user = await getCurrentUser(request);
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

  if (!baseAssetId) errors.base = "Choose a rig to remix.";
  if (prompt.length < 5) errors.prompt = "Describe the new look in at least 5 characters.";
  else if (prompt.length > 500) errors.prompt = "Keep it under 500 characters.";
  if (!isStyle(style)) errors.style = "Choose a style.";
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) errors.strength = "Strength must be 0–100.";
  if (!isApiVersion(apiVersion)) errors.apiVersion = "Choose a remix API version.";

  if (Object.keys(errors).length > 0 || !isStyle(style) || !isApiVersion(apiVersion)) {
    return data({ errors }, { status: 400 });
  }

  const base = await getAsset(baseAssetId);
  if (!base?.files) {
    const message = base ? "This rig has no textures to repaint yet. Choose another one." : "That rig no longer exists.";
    return data({ errors: { base: message } satisfies FieldErrors }, { status: 400 });
  }

  const job = await createRemixJob(user.id, {
    baseAssetId,
    prompt,
    style,
    strength: strength / 100,
    keepPalette,
    keepPosition,
    keepSize,
    keepOutline,
  }, apiVersion);
  if (!job) return data({ errors: { base: "That rig no longer exists." } satisfies FieldErrors }, { status: 400 });

  throw redirect(`/remix?${new URLSearchParams({ base: baseAssetId, job: job.id })}`);
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
  const { base, job, anim, rq, source, pickerRigs, recent, savedIds } = loaderData;
  const [searchParams] = useSearchParams();
  const errors: FieldErrors = actionData?.errors ?? {};
  const { revalidate } = useRevalidator();

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
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-6 lg:self-start">
            <BaseRigSummary base={base} />
            <Card>
              <CardHeader>
                <CardTitle>
                  <span className="text-muted-foreground">Step 2 ·</span> Describe the new look
                </CardTitle>
                <CardDescription>Textures are repainted to fit the existing atlas regions, so every animation keeps working.</CardDescription>
              </CardHeader>
              <CardContent>
                <RemixForm key={base.id} base={base} errors={errors} />
              </CardContent>
            </Card>
          </div>

          <section aria-label="Result" aria-live="polite" className="flex flex-col gap-4">
            {!job ? (
              <>
                <AssetPlayer
                  asset={base}
                  animation={anim ?? base.animations[0]?.name ?? "idle"}
                  animationHref={(name) => withParams({ anim: name })}
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

          <SpriteSheet
            // Remount per rig/result so page and source selection start fresh.
            key={`${base.id}:${job?.asset?.id ?? ""}`}
            className="lg:col-span-2"
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

function RemixForm({ base, errors }: { base: SpineAsset; errors: FieldErrors }) {
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

      <Button type="submit" size="lg" disabled={submitting} className="w-full">
        {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {submitting ? "Starting…" : "Remix textures"}
      </Button>
    </Form>
  );
}
