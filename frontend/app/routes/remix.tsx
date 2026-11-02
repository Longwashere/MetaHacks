import { Activity, AlertCircle, ArrowLeftRight, ShieldAlert, Bone, Circle, CircleCheck, Download, ExternalLink, Film, History, Loader2, Paintbrush, Palette, Repeat, RotateCcw, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Form,
  Link,
  data,
  href,
  redirect,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/remix";
import type { action as autoTweakAction } from "./api.auto-tweak";
import type { loader as remixJobLoader } from "./api.remix-job";
import type { action as saveSkeletonAction } from "./api.remix-skeleton";
import { AnimatePanel } from "~/components/AnimatePanel";
import { AssetGrid } from "~/components/AssetGrid";
import { AssetPlayer } from "~/components/AssetPlayer";
import { ReferenceImageField } from "~/components/ReferenceImageField";
import { RemixLivePlayer, RemixLiveSheet, RemixTimeline } from "~/components/RemixLiveView";
import { RigPicker } from "~/components/RigPicker";
import { SaveButton } from "~/components/SaveButton";
import { DeleteAssetButton } from "~/components/DeleteAssetButton";
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
  deleteRemixAnimation,
  renameRemixAnimation,
  getAccount,
  getAsset,
  getLibrary,
  getMyRemixes,
  getPartFix,
  getRemixJob,
  getRemixJobForAsset,
  getRemixVersions,
  getSavedAssetIds,
  listAssets,
  restoreRemixVersion,
} from "~/lib/api.server";
import { defaultAnimation } from "~/lib/animation";
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
  remixCredits,
  type AssetVersion,
  type CreditRules,
  type PartFixJob,
  type RemixApiVersion,
  type RemixJob,
  type RemixStyle,
  type SpineAsset,
} from "~/lib/types";
import { formatDateTime } from "~/lib/format";
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

  const [loadedBase, copySource, savedIds, myRemixes, pickerRigs, account, fix, versions, remixJob] = await Promise.all([
    baseId ? getAsset(baseId, session) : null,
    remix?.copyOf ? getAsset(remix.copyOf.id, session) : null,
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
    remix && session ? getRemixVersions(session, remix.id) : [],
    // The job that made the remix, for its Muse log.
    remix && session ? getRemixJobForAsset(session, remix.id) : null,
  ]);
  // The rig a remix was made from can be gone or private (a copy of someone's remix of their own
  // private remix). The remix then stands in for it, so the workspace still opens.
  const base = loadedBase ?? remix;
  // A copy generates from the remix it was copied from; ?from=original swaps to the original rig.
  // Tweaks, part fixes and the sprite sheet still compare against the original either way.
  const copyBase = copySource?.files && copySource.id !== base?.id ? copySource : null;
  // Before a remix is generated, a base that is itself a remix previews against its own original.
  const baseOriginal = !remix && base?.remixOf ? await getAsset(base.remixOf.id, session) : null;

  return {
    base,
    copyBase,
    baseOriginal,
    fromOriginal: params.get("from") === "original",
    remix,
    job,
    remixJob,
    fix,
    versions,
    anim: params.get("anim"),
    rq,
    source,
    pickerRigs: source === "library" && rq ? filterRigs(pickerRigs, rq) : pickerRigs,
    recent: myRemixes.filter((a) => a.id !== remix?.id).slice(0, 4),
    savedIds,
    signedIn: session !== null,
    usage: account && { ...account.usage, plan: account.plan, credits: account.credits },
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
type FieldErrors = Partial<Record<"base" | "prompt" | "style" | "strength" | "apiVersion" | "referenceImage" | "limit", string>>;

const isStyle = (v: unknown): v is RemixStyle => typeof v === "string" && REMIX_STYLES.some((s) => s === v);
const isApiVersion = (v: unknown): v is RemixApiVersion =>
  typeof v === "string" && REMIX_API_VERSIONS.some((s) => s === v);

export async function action({ request, context }: Route.ActionArgs) {
  const session = requireSession(context, request);
  const form = await request.formData();
  if (form.get("intent") === "fix-parts") return fixParts(session, form);
  if (form.get("intent") === "restore-version") return restoreVersion(session, form);
  if (form.get("intent") === "delete-animation") return deleteAnimation(session, form);
  if (form.get("intent") === "rename-animation") return renameAnimation(session, form);
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
  const referenceImage = String(form.get("referenceImage") ?? "") || null;
  // Every remix is public for now.
  const visibility = "public";

  if (!baseAssetId) errors.base = "Choose a rig to remix.";
  // With a reference image the prompt is optional; the backend fills in a default.
  if (prompt.length < 5 && !(referenceImage && prompt.length === 0)) {
    errors.prompt = "Describe the new look in at least 5 characters, or add a reference image.";
  } else if (prompt.length > 1000) errors.prompt = "Keep it under 1000 characters.";
  if (referenceImage && !REFERENCE_DATA_URL.test(referenceImage)) errors.referenceImage = "The reference must be a JPEG, PNG or WebP image.";
  else if (referenceImage && referenceImage.length > MAX_REFERENCE_CHARS) errors.referenceImage = "The reference image is too large.";
  if (referenceImage && apiVersion === "v1") errors.referenceImage = "Reference images need the v2 remix API.";
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
  }, apiVersion, referenceImage);
  if (!result.ok) {
    const key = result.limitReached ? "limit" : (result.field ?? "prompt");
    return data({ errors: { [key]: result.error } satisfies FieldErrors }, { status: result.limitReached ? 402 : 400 });
  }

  throw redirect(`/remix?${new URLSearchParams({ base: baseAssetId, job: result.job.id })}`);
}

/** Same rules as parseReferenceImage in backend/src/lib/validate.ts (4 MB decoded, as base64). */
const REFERENCE_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_REFERENCE_CHARS = Math.ceil((4 * 1024 * 1024 * 4) / 3) + 64;

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

/** Brings back an earlier version of the remix's sprite sheet, then reloads the page without `?fix=`. */
async function restoreVersion(session: Session, form: FormData) {
  const assetId = String(form.get("assetId") ?? "");
  const versionId = String(form.get("versionId") ?? "");
  if (!assetId || !versionId) return data({ restoreError: "Pick a version to restore." }, { status: 400 });

  const result = await restoreRemixVersion(session, assetId, versionId);
  if (!result.ok) return data({ restoreError: result.error }, { status: 400 });

  throw redirect(`/remix?${new URLSearchParams({ asset: assetId })}`);
}

async function deleteAnimation(session: Session, form: FormData) {
  const assetId = String(form.get("assetId") ?? "");
  const name = String(form.get("animation") ?? "");
  if (!assetId || !name) return data({ ok: false as const, error: "Pick an animation to delete." }, { status: 400 });

  const result = await deleteRemixAnimation(session, assetId, name);
  if (!result.ok) return data({ ok: false as const, error: result.error }, { status: 400 });
  return { ok: true as const, deleted: name };
}

async function renameAnimation(session: Session, form: FormData) {
  const assetId = String(form.get("assetId") ?? "");
  const name = String(form.get("animation") ?? "");
  const newName = String(form.get("name") ?? "").trim();
  if (!assetId || !name) return data({ ok: false as const, error: "Pick an animation to rename." }, { status: 400 });
  if (!newName) return data({ ok: false as const, error: "Give the animation a name." }, { status: 400 });

  const result = await renameRemixAnimation(session, assetId, name, newName);
  if (!result.ok) return data({ ok: false as const, error: result.error }, { status: 400 });
  // The backend may clean the name; the renamed animation keeps its place in the list.
  const index = Number(form.get("index"));
  return { ok: true as const, from: name, to: result.asset.animations[index]?.name ?? newName };
}

/** Optional prompt constraints; all off by default so the model can reshape parts. */
const KEEP_PART_OPTIONS = [
  { name: "keepPosition", label: "Position" },
  { name: "keepSize", label: "Size" },
  { name: "keepOutline", label: "Outline" },
] as const;

/** Prompt chips: a click puts `prompt` in the text box, or the label when there's none. */
const EXAMPLE_PROMPTS: { label: string; prompt?: string }[] = [
  {
    label: "Ukiyo-e Japanese art style",
    prompt:
      "[Character], Edo-period ukiyo-e style. Black ninja shozoku outfit, crimson accents, cloth wraps. Moonlit palette of indigo sumi ink washes, pale silver lunar light, vermilion brushwork. Crisp black sumi ink outlines with heavy modulated line weight, calligraphic tapered brushstrokes, sharp woodblock relief edges, and dry-brush accents. Rough textured washi paper, visible wood grain, subtle ink bleed, delicate bokashi gradients. Authentic vintage Japanese printmaking aesthetic.",
  },
  {
    label: "Medieval dark fantasy",
    prompt:
      "[Subject] in the style of dark fantasy medieval RPG concept art, gritty oil painting aesthetic, heavy impasto brushstrokes, dramatic chiaroscuro lighting, deep umber and blackened steel tones, volumetric mist, cold moonlight piercing through fog, worn hammered plate armor, weathered leather, archaic runic etchings, grim atmosphere, cinematic composition, hyper-detailed, masterwork oil on canvas, with heavy cross stitching shading",
  },
  {
    label: "Zombie version — torn clothes, pale green skin",
    prompt:
      "Comic book illustration of the character converted to a rotting ghoul, pale gangrenous olive-green skin with necrotic yellow undertones, stained purplish torn garments. Rendering features dense black ink crosshatching over sunken cheekbones, fine directional crosshatch shading across decayed anatomy, rough dry-brush line textures along the edges, colored with vivid murky watercolor washes and comic flats, full color, high contrast --no monochrome, black and white, grayscale, smooth 3d render",
  },
  {
    label: "Cyberpunk neon trims and chrome plating",
    prompt:
      "[Subject] in the visual style of Studio Trigger Cyberpunk: Edgerunners, modern Japanese anime aesthetic, harsh graphic cel shading, bold angular line art, ink contours, high-contrast neon palette with acid yellow, hot magenta, electric cyan, and deep shadows, retro-futuristic Night City cyberware, chrome augments, exposed cabling, glowing optical implants, holographic overlays, dramatic neon rim lighting, cinematic anime keyframe",
  },
  {
    label: "Vampire noble — gothic velvet, ashen skin",
    prompt:
      "Victorian gothic horror illustration of the character converted to a vampire aristocrat, ashen blue-grey skin with faint violet veins, sunken crimson eyes, elongated fangs, high-collared blood-red velvet coat with tarnished silver filigree and black lace cuffs. Rendering features fine engraved etching lines, stippled mezzotint shadows pooling in the eye sockets, sharp pen-and-ink contours, glazed with rich oxblood, plum and candlelit amber watercolor washes, full color, dramatic chiaroscuro --no monochrome, black and white, grayscale, cute, chibi, smooth 3d render",
  },
  {
    label: "Day of the Dead calavera — painted bones, marigolds",
    prompt:
      "Mexican folk art illustration of the character converted to a Día de Muertos calavera, bone-white skeletal face painted with ornate sugar-skull patterns, marigold flowers and papel picado ribbons woven into festive charro garments. Rendering features bold flat shapes, thick confident black outlines, hand-painted alebrije dot and stripe ornamentation across the bones, saturated hot pink, marigold orange, turquoise and cobalt flats, subtle linocut texture, full color, high contrast --no monochrome, black and white, grayscale, gore, smooth 3d render",
  },
  {
    label: "Clockwork automaton — brass gears, steam vents",
    prompt:
      "Steampunk technical illustration of the character converted to a clockwork automaton, riveted brass and oxidized copper plating, exposed interlocking gears at the joints, glass pressure gauges, leaking steam vents, glowing amber furnace core in the chest. Rendering features precise Victorian engraving linework, fine hatched shading on curved metal, ink blueprint annotation marks, colored with warm sepia, verdigris green and polished gold watercolor washes on aged parchment, full color, crisp edges --no monochrome, black and white, grayscale, modern sci-fi, smooth 3d render",
  },
  {
    label: "Frost wraith — ice-cracked skin, spectral glow",
    prompt:
      "Dark fantasy illustration of the character converted to a frost wraith, translucent pale cyan skin cracked with glowing ice fissures, frozen tattered robes trailing into drifting snow, jagged icicle crown, hollow eyes emitting cold blue light. Rendering features sharp angular ink contours, scratchy drybrush frost textures, fine crosshatching in the shadow folds, colored with glacial teal, indigo and bone-white gouache, luminous rim light, full color, high contrast --no monochrome, black and white, grayscale, warm tones, smooth 3d render",
  },
  {
    label: "Werewolf — pulp horror paperback cover",
    prompt:
      "1970s pulp horror paperback cover painting of the character converted to a snarling werewolf, coarse matted grey-brown fur sprouting through shredded clothing, elongated snout, bared yellowed fangs, glowing amber eyes, clawed hands. Rendering features loose expressive gouache brushwork, visible bristle strokes in the fur, bold black ink shadow shapes, lurid blood-orange moonlight against deep violet night, slight print grain and halftone wear, full color, high contrast --no monochrome, black and white, grayscale, cute, smooth 3d render",
  },
  {
    label: "Infernal demon — lava cracks, obsidian horns",
    prompt:
      "Dark fantasy comic illustration of the character converted to an infernal demon, charred obsidian skin split by glowing molten lava cracks, curled obsidian horns, smoldering ember eyes, scorched spiked armor plates and tattered burning cloth. Rendering features heavy black ink spotting, aggressive directional crosshatching, ragged dry-brush edges, colored with searing magma orange, sulfur yellow and ash-black flats with glowing airbrushed highlights, full color, high contrast --no monochrome, black and white, grayscale, cartoon, smooth 3d render",
  },
  {
    label: "Pumpkin-head scarecrow — burlap, candlelit grin",
    prompt:
      "Halloween storybook illustration of the character converted to a haunted scarecrow, carved jack-o'-lantern head with a flickering candlelit grin, stitched burlap skin, straw bursting from patched seams, ragged plaid shirt and crooked witch hat, crows perched on the shoulders. Rendering features scratchy pen-and-ink linework, cross-hatched shading in the folds, rough woodcut-like textures, colored with autumn pumpkin orange, mossy green, rust and midnight purple watercolor washes, full color, high contrast --no monochrome, black and white, grayscale, gore, smooth 3d render",
  },
  {
    label: "Celestial seraph — Art Nouveau gold leaf",
    prompt:
      "Art Nouveau illustration of the character converted to a celestial seraph, luminous pearl skin, flowing ivory robes with sweeping organic folds, layered feathered wings, ornate halo of radiating gold rings and stars. Rendering features elegant whiplash contour lines of varying weight, decorative flat color fields, intricate gilded ornament and mosaic patterning, colored with soft gold leaf, sky blue, rose and cream, gentle radiant glow, full color, crisp outlines --no monochrome, black and white, grayscale, dark, gore, smooth 3d render",
  },
];


/** `next` with the log events its poll skipped taken from `prev`, the same job as seen last. */
function withEarlierEvents(next: RemixJob, prev: RemixJob | null): RemixJob {
  if (!next.live || next.live.eventsFrom === 0) return next;
  const earlier = prev?.id === next.id ? (prev.live?.events ?? []).slice(0, next.live.eventsFrom) : [];
  return { ...next, live: { ...next.live, events: [...earlier, ...next.live.events], eventsFrom: 0 } };
}

/** A folder tab on the panel card's top edge; the active one merges into the card below. */
const FOLDER_TAB =
  "h-auto! flex-none rounded-t-lg rounded-b-none border-border bg-muted px-4 py-2 data-[state=inactive]:border-b data-[state=active]:border-b-0 data-[state=active]:bg-card data-[state=active]:shadow-none dark:data-[state=active]:border-border dark:data-[state=active]:bg-card";

export default function Remix({ loaderData, actionData }: Route.ComponentProps) {
  const { base, copyBase, baseOriginal, fromOriginal, remix, job: loadedJob, remixJob, fix, versions, anim, rq, source, pickerRigs, recent, savedIds, signedIn, usage } = loaderData;
  const [searchParams] = useSearchParams();
  const errors: FieldErrors = actionData && "errors" in actionData ? actionData.errors : {};
  const fixError = actionData && "fixError" in actionData ? actionData.fixError : null;
  const restoreError = actionData && "restoreError" in actionData ? actionData.restoreError : null;
  const { revalidate } = useRevalidator();
  // A running job is polled through /api/remix-job, which skips the rest of this page's loader.
  const jobFetcher = useFetcher<typeof remixJobLoader>();
  const fetchedJob = jobFetcher.data?.job;
  // Each poll returns only the log events after the ones the page has; this puts them back together.
  const [polled, setPolled] = useState<{ from: RemixJob; job: RemixJob } | null>(null);
  if (fetchedJob && fetchedJob !== polled?.from) {
    setPolled({ from: fetchedJob, job: withEarlierEvents(fetchedJob, polled?.job.id === fetchedJob.id ? polled.job : loadedJob) });
  }
  const polledJob = polled && polled.from === fetchedJob ? polled.job : null;
  const job = polledJob && polledJob.id === loadedJob?.id ? polledJob : loadedJob;
  const jobActive = job?.status === "queued" || job?.status === "running";
  const jobId = job?.id;
  const eventCount = job?.live?.events.length ?? 0;
  useEffect(() => {
    if (!jobId || !jobActive || jobFetcher.state !== "idle") return;
    // The next poll starts a second after the last one returned, so slow polls never pile up.
    const t = setTimeout(() => jobFetcher.load(`/api/remix-job?${new URLSearchParams({ id: jobId, events: String(eventCount) })}`), 1000);
    return () => clearTimeout(t);
  }, [jobId, jobActive, eventCount, jobFetcher.state, jobFetcher.data, jobFetcher.load]);
  // Once it has finished, the page loader shows the result (or redirects to the new remix).
  const finished = loadedJob && fetchedJob?.id === loadedJob.id && !jobActive && fetchedJob.status !== loadedJob.status;
  useEffect(() => {
    if (finished) void revalidate();
  }, [finished, revalidate]);
  const tweak = useTweakSession(base?.id ?? null);
  // A finished part fix carries the remix as it saved it. The loader reads the remix first, so on
  // the poll where the fix finishes, the remix can still have the files from before the fix.
  const fixedRemix = fix?.status === "succeeded" && fix.asset?.id === remix?.id ? fix.asset : null;
  const savedRemix = remix && (fixedRemix ?? remix);
  const previewAnimation = anim ?? defaultAnimation((savedRemix ?? base)?.animations ?? [])?.name ?? "idle";
  const tweakPanel = {
    ...tweak.panel,
    save: useSaveTweaks(savedRemix?.id ?? null, tweak),
    autoTweak: useAutoTweak(base, savedRemix, previewAnimation, tweak),
  };
  // Tweaks need a rig on screen: the original before a remix, or the finished remix.
  const canTweak = !job || savedRemix !== null;
  const [panelTab, setPanelTab] = useState<"generate" | "tweak" | "animate">("generate");
  // The folder tab the user picked, and the job running when they picked it: a newly started job
  // switches to "What Muse is doing" until the user picks again.
  const [picked, setPicked] = useState<{ view: "edit" | "muse"; jobId: string | null }>({ view: "edit", jobId: null });
  // The log to show: the job on screen, else the one that made the open remix.
  const logJob = job ?? remixJob;
  const watching = (jobActive && picked.jobId !== jobId) || picked.view === "muse";
  const tweaking = canTweak && !watching && panelTab === "tweak";
  const animating = savedRemix !== null && !watching && panelTab === "animate";
  const navigate = useNavigate();
  // Picking and the part outline only make sense while the Tweak tab is open.
  const playerTweaks: SpineTweakBinding = {
    ...tweak.binding,
    picking: tweaking && tweak.binding.picking,
    selectedPart: tweaking ? tweak.binding.selectedPart : null,
  };

  // Poll a part fix while it's in progress. BACKEND: could be replaced by SSE/WebSocket push.
  const active = fix?.status === "queued" || fix?.status === "running";
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

  // What Generate repaints: a copy starts from the remix it was copied from, unless swapped back to the original.
  const fromCopy = copyBase !== null && !fromOriginal;

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
              <BaseRigSummary
                base={fromCopy ? copyBase : base}
                swap={
                  copyBase && {
                    label: fromCopy ? `Use the original, ${base.name}` : `Use ${copyBase.name}`,
                    href: withParams({ from: fromCopy ? "original" : null }),
                  }
                }
              />
              <Tabs value={watching ? "muse" : "edit"} onValueChange={(v) => setPicked({ view: v === "muse" ? "muse" : "edit", jobId: jobId ?? null })} className="gap-0">
                {/* Overlaps the card's top border by a pixel, so the active tab joins the card. */}
                <TabsList className="relative z-10 -mb-px h-auto! gap-1 rounded-none bg-transparent p-0">
                  <TabsTrigger value="edit" className={FOLDER_TAB}>
                    <Sparkles /> Remix
                  </TabsTrigger>
                  <TabsTrigger value="muse" className={FOLDER_TAB}>
                    {jobActive ? <Loader2 className="animate-spin" /> : <Activity />} What Muse is doing
                  </TabsTrigger>
                </TabsList>
                <Card className="rounded-tl-none">
                  <TabsContent value="edit" forceMount className="data-[state=inactive]:hidden">
                    <Tabs
                      value={tweaking ? "tweak" : animating ? "animate" : "generate"}
                      onValueChange={(v) => setPanelTab(v === "tweak" || v === "animate" ? v : "generate")}
                      className="gap-6"
                    >
                      <div className="px-6">
                        <TabsList className="grid w-full grid-cols-3">
                          <TabsTrigger value="generate">
                            <Sparkles /> Generate
                          </TabsTrigger>
                          <TabsTrigger value="tweak" disabled={!canTweak} title={canTweak ? undefined : "Available once the remix finishes"}>
                            <SlidersHorizontal /> Tweak
                          </TabsTrigger>
                          <TabsTrigger value="animate" disabled={!savedRemix} title={savedRemix ? undefined : "Available once the remix finishes"}>
                            <Film /> Animate
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
                          <RemixForm key={fromCopy ? copyBase.id : base.id} base={fromCopy ? copyBase : base} errors={errors} signedIn={signedIn} usage={usage} />
                        </CardContent>
                      </TabsContent>
                      <TabsContent value="tweak" forceMount className="data-[state=inactive]:hidden">
                        <CardContent>
                          <TweakPanel {...tweakPanel} />
                        </CardContent>
                      </TabsContent>
                      <TabsContent value="animate" forceMount className="data-[state=inactive]:hidden">
                        <CardContent>
                          <AnimatePanel
                            key={savedRemix?.id ?? ""}
                            remix={savedRemix}
                            baseAnimations={base?.animations.map((a) => a.name) ?? null}
                            onAnimated={(name) => navigate(withParams({ anim: name }), { replace: true, preventScrollReset: true })}
                            onDeleted={(name) => anim === name && navigate(withParams({ anim: null }), { replace: true, preventScrollReset: true })}
                            onRenamed={(from, to) => anim === from && navigate(withParams({ anim: to }), { replace: true, preventScrollReset: true })}
                          />
                        </CardContent>
                      </TabsContent>

                    </Tabs>
                  </TabsContent>
                  <TabsContent value="muse" className="flex flex-col gap-6">
                    {logJob?.live ? (
                      <RemixTimeline job={logJob} />
                    ) : (
                      <CardHeader>
                        <CardTitle>What Muse is doing</CardTitle>
                        <CardDescription>
                          {logJob
                            ? "This remix didn't keep a log of Muse's steps."
                            : "Start a remix and Muse's steps show up here: planning the look, painting each page and checking the result."}
                        </CardDescription>
                      </CardHeader>
                    )}
                  </TabsContent>
                </Card>
              </Tabs>
            </div>

            {/* Sticks while the tweak panel scrolls, so the rig stays beside the controls. */}
            <section aria-label="Result" aria-live="polite" className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
              {savedRemix ? (
                <>
                  <AssetPlayer
                    asset={savedRemix}
                    animation={anim ?? defaultAnimation(savedRemix.animations)?.name ?? "idle"}
                    animationHref={(name) => withParams({ anim: name })}
                    tweaks={playerTweaks}
                    // When the original rig is gone, the remix stands in as the base.
                    compareWith={base.id === savedRemix.id ? undefined : base}
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
                    <Button asChild variant="outline">
                      {/* reloadDocument: this is a resource route returning a file */}
                      <Link to={href("/assets/:assetId/download", { assetId: savedRemix.id })} reloadDocument rel="nofollow">
                        <Download /> Download
                      </Link>
                    </Button>
                    <DeleteAssetButton assetId={savedRemix.id} assetName={savedRemix.name} redirectTo="/library?tab=remixes" />
                  </div>
                </>
              ) : !job ? (
                <>
                  <AssetPlayer
                    asset={base}
                    animation={anim ?? defaultAnimation(base.animations)?.name ?? "idle"}
                    animationHref={(name) => withParams({ anim: name })}
                    tweaks={playerTweaks}
                    compareWith={baseOriginal ?? undefined}
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
                    <CardDescription className="flex items-center gap-3">
                      {job.referenceUrl && (
                        <img src={job.referenceUrl} alt="Reference image" className="size-12 shrink-0 rounded-md bg-muted object-contain" />
                      )}
                      <span className="line-clamp-2">“{job.input.prompt}”</span>
                    </CardDescription>
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
                    {job.live ? (
                      <RemixLivePlayer job={job} />
                    ) : (
                      <SpinePreview asset={job.base} className="animate-pulse rounded-lg opacity-50" showBones />
                    )}
                  </CardContent>
                </Card>
              )}
            </section>
          </div>

          {job?.live && jobActive ? (
            <RemixLiveSheet job={job} />
          ) : (
            <PartFixSection
              // Remount per rig/result so page, source and part selection start fresh.
              key={`${base.id}:${savedRemix?.id ?? ""}`}
              base={base}
              remix={savedRemix}
              fix={fix?.assetId === savedRemix?.id ? fix : null}
              error={fixError}
              usage={usage}
              versions={versions}
              restoreError={restoreError}
            />
          )}
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
          <AssetGrid assets={recent} savedIds={savedIds} className="lg:grid-cols-4" />
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
  versions,
  restoreError,
}: {
  base: SpineAsset;
  remix: SpineAsset | null;
  fix: PartFixJob | null;
  error: string | null;
  usage: RemixUsage | null;
  versions: AssetVersion[];
  restoreError: string | null;
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
      <div className="flex flex-col gap-8 lg:self-start">
        <Card>
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
                  <Button
                    type="submit"
                    disabled={selected.length === 0 || fixing || submitting || (usage !== null && usage.credits.partFix > creditsLeft(usage))}
                    className="w-full"
                  >
                    {submitting || fixing ? <Loader2 className="animate-spin" /> : <Paintbrush />}
                    {submitting
                      ? "Starting…"
                      : fixing
                        ? "Repainting…"
                        : selected.length === 0
                          ? "Repaint parts"
                          : `Repaint ${selected.length} part${selected.length === 1 ? "" : "s"}`}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Uses {usage ? creditsLabel(usage.credits.partFix) : "credits"} from your monthly allowance.
                  </p>
                  {usage && <RemixAllowance usage={usage} needed={usage.credits.partFix} />}
                </div>
              </Form>
            </CardContent>
          )}
        </Card>
        {remix && versions.length > 0 && <VersionHistory assetId={remix.id} versions={versions} disabled={fixing} error={restoreError} />}
      </div>

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

const VERSION_KIND_LABEL: Record<AssetVersion["kind"], string> = { original: "Before any fixes", part_fix: "Part fix" };

/**
 * The remix's sprite sheet history, newest first. Restoring brings back that version's pages and
 * moves the Current badge; the version left behind stays listed, so it can be restored again.
 * No model runs, so it's free.
 */
function VersionHistory({ assetId, versions, disabled, error }: { assetId: string; versions: AssetVersion[]; disabled: boolean; error: string | null }) {
  const navigation = useNavigation();
  const restoring = navigation.state === "submitting" && navigation.formData?.get("intent") === "restore-version";
  const restoringId = restoring ? navigation.formData?.get("versionId") : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" /> History
        </CardTitle>
        <CardDescription>Every part fix saves a version. Restore any of them to bring its sprite sheet back, and switch back the same way. It doesn't use your allowance.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FieldError id="restore-error" message={error ?? undefined} />
        <ol className="flex flex-col divide-y divide-border">
          {versions.map((v) => (
            <li key={v.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="line-clamp-2 text-sm font-medium break-words">{v.label}</span>
                <span className="text-xs text-muted-foreground">
                  {VERSION_KIND_LABEL[v.kind]}
                  {v.regions.length > 0 && ` · ${v.regions.join(", ")}`} · {formatDateTime(v.createdAt)}
                </span>
              </div>
              {v.current ? (
                <Badge variant="secondary" className="shrink-0">
                  Current
                </Badge>
              ) : (
                <Form method="post" preventScrollReset className="shrink-0">
                  <input type="hidden" name="intent" value="restore-version" />
                  <input type="hidden" name="assetId" value={assetId} />
                  <input type="hidden" name="versionId" value={v.id} />
                  <Button type="submit" variant="outline" size="sm" disabled={disabled || restoring}>
                    {restoringId === v.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    Restore
                  </Button>
                </Form>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
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
          <AlertDescription>
            The remix and its download now use the new parts. If a new part looks cut off, open Tweak and run Line up parts: it grows
            the part's outline until it all shows. Not right? Pick them again and try another prompt.
          </AlertDescription>
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

function BaseRigSummary({ base, swap }: { base: SpineAsset; swap?: { label: string; href: string } | null }) {
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
        {swap && (
          <Link to={swap.href} replace preventScrollReset className="flex w-fit items-center gap-1 text-xs text-primary hover:underline">
            <Repeat className="size-3" /> {swap.label}
          </Link>
        )}
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

/** This month's credits. */
interface RemixUsage {
  used: number;
  /** null = unlimited (admins). */
  limit: number | null;
  resetsAt: string;
  plan: "free" | "pro";
  credits: CreditRules;
}

/** Credits left this month; Infinity for admins. */
function creditsLeft(usage: RemixUsage): number {
  return usage.limit === null ? Infinity : Math.max(usage.limit - usage.used, 0);
}

function creditsLabel(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
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
  const [apiVersion, setApiVersion] = useState<RemixApiVersion>("v2");
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting" && navigation.formData?.get("baseAssetId") === base.id;
  const pages = Math.max(base.files?.textureUrls.length ?? 1, 1);
  const cost = usage ? remixCredits(usage.credits, apiVersion, base) : null;
  const short = usage !== null && cost !== null && cost > creditsLeft(usage);

  return (
    <Form method="post" className="flex flex-col gap-6">
      <input type="hidden" name="baseAssetId" value={base.id} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="prompt">New texture</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={4}
          maxLength={1000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should ${base.name} look like?`}
          aria-invalid={Boolean(errors.prompt)}
          aria-describedby={errors.prompt ? "prompt-error" : undefined}
        />
        <FieldError id="prompt-error" message={errors.prompt} />
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((example) => (
            <Badge key={example.label} variant="outline" asChild>
              <button type="button" onClick={() => setPrompt(example.prompt ?? example.label)} className="cursor-pointer hover:bg-accent">
                {example.label}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <ReferenceImageField error={errors.referenceImage} />

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
            Auto uses a style named in your prompt or shown in your reference image, or keeps the {base.style} style.
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
        <Select name="apiVersion" value={apiVersion} onValueChange={(v) => setApiVersion(v as RemixApiVersion)}>
          <SelectTrigger id="apiVersion" className="w-full sm:w-72" aria-invalid={Boolean(errors.apiVersion)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REMIX_API_VERSIONS.map((v) => (
              <SelectItem key={v} value={v}>
                {v === "v2" ? "v2 (default)" : v === "v3" ? "v3 (self-checking, slower)" : v}
                {usage && ` · ${creditsLabel(usage.credits.perPage[v])}/page`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError id="apiVersion-error" message={errors.apiVersion} />
      </div>

      {errors.limit && (
        <Alert>
          <AlertCircle />
          <AlertTitle>Not enough credits</AlertTitle>
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
          <Button type="submit" size="lg" disabled={submitting || short} className="w-full">
            {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitting
              ? "Starting…"
              : cost === null
                ? "Remix textures"
                : `Remix textures · ${creditsLabel(cost)}${pages > 1 ? ` (${pages} pages)` : ""}`}
          </Button>
          {usage && <RemixAllowance usage={usage} needed={cost ?? 0} />}
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

/** Credits left this month; `needed` is what the button next to it costs, to say when it's more than that. */
function RemixAllowance({ usage, needed }: { usage: RemixUsage; needed: number }) {
  if (usage.limit === null) {
    return <p className="text-center text-xs text-muted-foreground">Unlimited credits (admin) · {usage.used} used this month</p>;
  }
  const left = creditsLeft(usage);
  const resets = new Date(usage.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <p className="text-center text-xs text-muted-foreground">
      {needed > left && `Needs ${creditsLabel(needed)}. `}
      {left} of {usage.limit} {usage.plan === "pro" ? "Pro" : "free"} credits left this month · resets {resets}
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
