import {
  ArrowRight,
  Bone,
  Brush,
  CalendarClock,
  Check,
  Clapperboard,
  Download,
  Eye,
  Image as ImageIcon,
  Layers,
  Minus,
  Paintbrush,
  ScanSearch,
  Shapes,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/showcase";
import { AnimationShowcase, type AnimationShowcaseRig } from "~/components/AnimationShowcase";
import { AutoRigShowcase, type AutoRigShowcaseRig } from "~/components/AutoRigShowcase";
import { ModelSlideshowSection } from "~/components/ModelSlideshowSection";
import { ZombieArenaPlayer } from "~/components/ZombieArenaPlayer";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { getAsset } from "~/lib/api.server";
import { SITE_NAME, seoMeta } from "~/lib/seo";
import { ANIMATION_SHOWCASE_RIGS, AUTO_RIG_SHOWCASE } from "~/lib/showcase-models";
import { getSiteUrl } from "~/lib/site.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return seoMeta({
    title: `Showcase — Rig, Repaint and Animate 2D Characters | ${SITE_NAME}`,
    description:
      "RigForge turns one character image into a Spine rig, repaints Spine 2D characters with Meta's Muse Spark and Muse Image while every animation keeps working, and keyframes brand-new animations onto existing skeletons from a text prompt.",
    canonical: `${loaderData.siteUrl}/showcase`,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const autoRigIds = [AUTO_RIG_SHOWCASE.rig.assetId, ...AUTO_RIG_SHOWCASE.remixIds];
  const [assets, autoRigAssets] = await Promise.all([
    Promise.all(ANIMATION_SHOWCASE_RIGS.map((rig) => getAsset(rig.assetId, null))),
    Promise.all(autoRigIds.map((id) => getAsset(id, null))),
  ]);
  // Only what the player needs; a missing or private rig is skipped.
  const animationRigs: AnimationShowcaseRig[] = ANIMATION_SHOWCASE_RIGS.flatMap((rig, i) => {
    const asset = assets[i];
    if (!asset?.files) return [];
    const { id, name, category, accent, animations, files, tint } = asset;
    return [{ id, name, category, accent, animations, files, tint, added: rig.added }];
  });
  const autoRigs: AutoRigShowcaseRig[] = autoRigAssets.flatMap((asset) => {
    if (!asset?.files) return [];
    const { id, name, category, accent, animations, files, tint, prompt } = asset;
    return [{ id, name, category, accent, animations, files, tint, prompt }];
  });
  // The remixes alone don't tell the story without the rig they came from.
  return { siteUrl: getSiteUrl(request), animationRigs, autoRigs: autoRigs[0]?.prompt === null ? autoRigs : [] };
}

/**
 * Remix numbers are from the production remix_jobs and assets tables (jobs 2026-10-28 to
 * 2026-11-01); remix time is from job creation to the saved asset. Animation time is the median
 * durationMs of the 24 runs in the backend's animation log. Update these by hand when re-measuring.
 */
const STATS = [
  { value: "~72 s", label: "median time per remix", detail: "90% finish in about 5 min" },
  { value: "~67 s", label: "per new animation", detail: "median, keyframed by Muse Spark" },
  { value: "1,176", label: "animations carried over", detail: "across 183 saved remixes" },
  { value: "237", label: "remixes generated", detail: "from 51 different base rigs" },
];

const USE_CASES = [
  {
    icon: Shapes,
    audience: "Game studios",
    title: "Enemy variants from one rig",
    description:
      "Turn one water elemental into lava, crude oil and storm variants for a new biome, then give the storm one a new attack of its own. A new enemy, no new rig.",
    example: "Water Elemental → 4 variants",
  },
  {
    icon: CalendarClock,
    audience: "Live-ops teams",
    title: "Seasonal and event skins",
    description:
      "Ship a Halloween horde or a Lunar New Year cast on the event's schedule. The skins drop into the same skeletons the game already loads.",
    example: "14 rigs → one zombie event",
  },
  {
    icon: Layers,
    audience: "Indie and small teams",
    title: "One look across bought asset packs",
    description:
      "Packs from the Asset Store, itch.io and freelancers never match. Repaint them to one art direction so the game reads as a single world.",
    example: "Mixed packs → one style",
  },
  {
    icon: Clapperboard,
    audience: "Animation studios",
    title: "Restyle a rigged cast",
    description:
      "Reuse a rigged cast across productions: restyle it, then block out new acting beats from a sentence before an animator polishes them.",
    example: "\"do the thriller shuffle.\" → new clip",
  },
];

type Verdict = "yes" | "no" | "partial";

const COMPARISON: { row: string; hand: [Verdict, string]; frames: [Verdict, string]; rigforge: [Verdict, string] }[] = [
  {
    row: "Keeps the rig and its animations",
    hand: ["yes", "Yes"],
    frames: ["no", "No: every frame is a new picture"],
    rigforge: ["yes", "Yes: skeleton and keyframes untouched"],
  },
  {
    row: "Looks the same on every frame",
    hand: ["yes", "Yes"],
    frames: ["no", "Drifts from frame to frame"],
    rigforge: ["yes", "Yes: one atlas drives every frame"],
  },
  {
    row: "Engine-ready output",
    hand: ["yes", "Spine export"],
    frames: ["partial", "Flat PNG frames to clean up"],
    rigforge: ["yes", "Spine skeleton, atlas and pages"],
  },
  {
    row: "Time per variant",
    hand: ["no", "Hours to days of artist time"],
    frames: ["partial", "Minutes, then cleanup"],
    rigforge: ["yes", "About a minute"],
  },
  {
    row: "Add a new animation",
    hand: ["no", "An animator keys it by hand"],
    frames: ["partial", "Generate a new frame set"],
    rigforge: ["yes", "Describe it; Muse Spark keys the bones"],
  },
  {
    row: "Fix one part without redoing the rest",
    hand: ["yes", "Yes"],
    frames: ["no", "Regenerate the frames"],
    rigforge: ["yes", "Yes: click a part, describe the change"],
  },
];

const PIPELINE = [
  {
    icon: ScanSearch,
    model: "Muse Spark",
    title: "Reads the atlas and plans",
    description:
      "Spark looks at the rig's atlas pages, plus an optional reference image, and writes a paint plan for every part: what each piece is and how it should look.",
  },
  {
    icon: Brush,
    model: "Muse Image",
    title: "Repaints the pages",
    description:
      "Muse Image repaints each atlas page from that plan. Pieces stay in their atlas boxes, so the existing UVs and meshes still line up.",
  },
  {
    icon: Eye,
    model: "RigForge",
    title: "Fits it back and checks it",
    description:
      "We key out the background, snap every piece back onto its original region, and check the layout. If the model moved parts, the page is repainted.",
  },
  {
    icon: Download,
    model: "Export",
    title: "Drops into your engine",
    description:
      "Download the original skeleton with the new .atlas and pages. Load it with the Spine runtime you already use: Unity, Godot, Unreal, Phaser, Pixi or web.",
  },
];

const REFINE = [
  { icon: Paintbrush, title: "Fix a part", description: "Click any piece of the atlas and describe the change: \"turn the axe into a sword\"." },
  { icon: ImageIcon, title: "Match a reference", description: "Give Spark a piece of your own concept art and it carries the look into the plan." },
];

/** How a prompt becomes keyframes (backend/src/lib/animate.ts). */
const ANIMATE_STEPS = [
  {
    title: "Spark sees the rig",
    description: "A labelled rig sheet and every bone's position, direction and range of motion in the rig's own clips.",
  },
  {
    title: "Plans, then keys",
    description: "Spark plans the beats, then writes keys in screen directions (\"swing the axe down\"), which we convert to bone rotations.",
  },
  {
    title: "Checked and saved",
    description: "Values are clamped, loops closed and body tilt limited, then the clip is saved into the skeleton next to the originals.",
  },
];

function VerdictCell({ verdict, children, highlight }: { verdict: Verdict; children: ReactNode; highlight?: boolean }) {
  const Icon = verdict === "yes" ? Check : verdict === "no" ? X : Minus;
  return (
    <TableCell className={highlight ? "bg-primary/5" : undefined}>
      <span className="flex items-start gap-2 whitespace-normal">
        <Icon
          className={
            verdict === "yes"
              ? "mt-0.5 size-4 shrink-0 text-emerald-500"
              : verdict === "no"
                ? "mt-0.5 size-4 shrink-0 text-destructive"
                : "mt-0.5 size-4 shrink-0 text-muted-foreground"
          }
          aria-label={verdict}
        />
        <span className={highlight ? "font-medium text-foreground" : "text-muted-foreground"}>{children}</span>
      </span>
    </TableCell>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <span className="text-xs font-semibold tracking-wider text-primary uppercase">{eyebrow}</span>
      <h2 id={id} className="text-2xl font-bold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {children && <p className="text-muted-foreground text-pretty">{children}</p>}
    </div>
  );
}

export default function ShowcaseRoute({ loaderData }: Route.ComponentProps) {
  return (
    <div className="flex flex-col gap-20 lg:gap-28">
      {/* Hero */}
      <section className="flex flex-col items-center pt-2 text-center md:pt-8">
        <Badge variant="secondary" className="mb-5 gap-1.5 px-3 py-1 text-xs">
          <Sparkles className="size-3.5 text-primary" />
          Built on Meta Muse Spark, Muse Image and SAM 3.1
        </Badge>
        <h1 className="max-w-4xl text-4xl font-extrabold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          New art and new moves for your 2D characters.{" "}
          <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
            No re-rigging.
          </span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground text-pretty">
          Rigging and animating a 2D character takes days, and every new skin or new move takes days more. RigForge
          uses Meta&apos;s Muse models to repaint a Spine rig in about a minute with every animation still working,
          to keyframe brand-new animations onto the skeleton you already have from one sentence, and to rig a new
          character from a single image.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" asChild className="gap-2">
            <Link to="/remix">
              <Wand2 className="size-4" /> Remix a rig
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="gap-2">
            <a href="#autorig-heading">
              <Bone className="size-4" /> Rig from one image
            </a>
          </Button>
          <Button size="lg" variant="ghost" asChild className="gap-2">
            <a href="#animate-heading">
              See new animations <ArrowRight className="size-4" />
            </a>
          </Button>
        </div>

        {/* Measured numbers */}
        <dl className="mt-12 grid w-full max-w-4xl grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border text-left md:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5 bg-card p-4 sm:p-5">
              <dt className="order-2 text-sm font-medium text-foreground">{stat.label}</dt>
              <dd className="order-1 text-3xl font-extrabold tracking-tight tabular-nums">{stat.value}</dd>
              <dd className="order-3 text-xs text-muted-foreground">{stat.detail}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Remix numbers from RigForge production jobs, Oct 28 – Nov 1, 2026. Animation time from 24 logged generation runs.
        </p>
      </section>

      {/* Slideshows */}
      <section aria-labelledby="slideshows-heading" className="flex flex-col gap-6">
        <ModelSlideshowSection />
      </section>

      {/* Live arena */}
      <section aria-labelledby="arena-heading" className="flex scroll-mt-20 flex-col gap-6">
        <SectionHeading id="arena-heading" eyebrow="Live demo" title="14 rigs from different packs, pulled into one art direction">
          Knights, cavalry, golems, slimes and dragons from different creators, each with its own palette and line
          weight. Every one was remixed into the same comic-ink ghoul style. Drag the line across the arena and
          watch each rig swap textures mid-stride. Rigs that bump into each other stop and fight, so you see attack
          animations too.
        </SectionHeading>
        <ZombieArenaPlayer />
      </section>

      {/* New animations on existing skeletons */}
      {loaderData.animationRigs.length > 0 && (
        <section aria-labelledby="animate-heading" className="flex scroll-mt-20 flex-col gap-6">
          <SectionHeading
            id="animate-heading"
            eyebrow="New animations"
            title="Type a move. Muse Spark keyframes it onto the skeleton you already have."
          >
            This ghoul shipped with an attack, a run and a death. It never had a zombie split, a thriller shuffle or a
            philosopher&apos;s pose. Each was described in a sentence and keyframed by Muse Spark on the rig&apos;s
            existing bones in about a minute: no new rig, no new art, no animator. Turn on the bones to see it&apos;s
            real skeletal animation, not a video.
          </SectionHeading>
          <AnimationShowcase rigs={loaderData.animationRigs} />
          <ol className="grid gap-4 sm:grid-cols-3">
            {ANIMATE_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-xs text-primary">
                  {i + 1}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{step.title}</span>
                  <span className="text-sm text-muted-foreground">{step.description}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Auto-rig: one image to a Spine rig */}
      {loaderData.autoRigs.length > 0 && (
        <section aria-labelledby="autorig-heading" className="flex scroll-mt-20 flex-col gap-6">
          <SectionHeading id="autorig-heading" eyebrow="Auto-rig" title="No rig yet? Start from one image.">
            Upload a picture of a character and get a Spine rig you can play, remix and animate. Muse Image poses it,
            Muse Spark places the joints and names the gear, SAM 3.1 keeps each piece of gear whole, and RigForge
            builds the bones, meshes and weights. Posing and joints take about 45 seconds; the rig builds in 2–30
            more, depending on whether it&apos;s one smooth image or cut into parts.
          </SectionHeading>
          <AutoRigShowcase rigs={loaderData.autoRigs} />
        </section>
      )}

      {/* Use cases */}
      <section aria-labelledby="use-cases-heading" className="flex flex-col gap-8">
        <SectionHeading id="use-cases-heading" eyebrow="Who it's for" title="The rig is the expensive part. Reuse it.">
          A rig&apos;s skeleton, weights and animations are where the hours go. The art painted on top is what
          changes from game to game, season to season and enemy to enemy. RigForge changes only that layer.
        </SectionHeading>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((item) => (
            <Card key={item.title} className="bg-card/60">
              <CardContent className="flex h-full flex-col gap-3 p-5">
                <div className="flex items-center gap-2">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <item.icon className="size-4.5" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">{item.audience}</span>
                </div>
                <h3 className="font-semibold text-foreground">{item.title}</h3>
                <p className="flex-1 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
                <span className="w-fit rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {item.example}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Comparison */}
      <section aria-labelledby="compare-heading" className="flex flex-col gap-8">
        <SectionHeading id="compare-heading" eyebrow="Why not just…" title="Why repaint the atlas instead of generating sprites">
          Image models can draw a character, but a game needs that character on every frame of every animation, looking
          the same each time, in a format the engine loads. Painting the atlas once gets all three.
        </SectionHeading>
        <div className="overflow-hidden rounded-xl border">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[26%]" />
                <TableHead className="w-[24%]">Repaint by hand</TableHead>
                <TableHead className="w-[24%]">Generate sprite frames</TableHead>
                <TableHead className="w-[26%] bg-primary/5 font-semibold text-foreground">
                  <span className="flex items-center gap-1.5">
                    <Bone className="size-4 text-primary" /> RigForge
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARISON.map((c) => (
                <TableRow key={c.row} className="hover:bg-transparent">
                  <TableCell className="font-medium whitespace-normal">{c.row}</TableCell>
                  <VerdictCell verdict={c.hand[0]}>{c.hand[1]}</VerdictCell>
                  <VerdictCell verdict={c.frames[0]}>{c.frames[1]}</VerdictCell>
                  <VerdictCell verdict={c.rigforge[0]} highlight>
                    {c.rigforge[1]}
                  </VerdictCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Pipeline */}
      <section aria-labelledby="pipeline-heading" className="flex flex-col gap-8">
        <SectionHeading id="pipeline-heading" eyebrow="How it works" title="Two Meta models, and checks around them">
          Muse Spark does the looking and planning; Muse Image does the painting. RigForge does the parts a game
          needs to be exact: fitting pixels back where the rig expects them.
        </SectionHeading>
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {PIPELINE.map((step, i) => (
            <li key={step.title} className="relative flex flex-col gap-3 rounded-xl border bg-card p-5">
              <div className="flex items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <step.icon className="size-4.5" />
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {i + 1} · {step.model}
                </span>
              </div>
              <h3 className="font-semibold text-foreground">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
        <div className="grid gap-4 rounded-xl border bg-muted/30 p-5 sm:grid-cols-3">
          <span className="text-sm font-semibold text-foreground sm:col-span-3">Then refine it in the studio</span>
          <div className="flex gap-3">
            <Wand2 className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">Add an animation</span>
              <span className="text-sm text-muted-foreground">
                Describe a new move and Muse Spark keyframes it on the rig&apos;s own bones.{" "}
                <a href="#animate-heading" className="underline underline-offset-2">
                  See examples
                </a>
              </span>
            </div>
          </div>
          {REFINE.map((item) => (
            <div key={item.title} className="flex gap-3">
              <item.icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">{item.title}</span>
                <span className="text-sm text-muted-foreground">{item.description}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-primary/10 p-8 text-center shadow-lg sm:p-12">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-5">
          <h2 className="text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            Bring one of your rigs
          </h2>
          <p className="text-muted-foreground text-pretty">
            Upload a Spine export (skeleton, atlas and pages), remix it with a prompt and give it moves it never had.
            No rig yet? Auto-rig one from a single image. Or start from a rig in the library.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Button size="lg" asChild className="gap-2">
              <Link to="/upload">
                <Upload className="size-4" /> Upload a Spine rig
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="gap-2">
              <Link to="/autoRig">
                <Bone className="size-4" /> Auto-rig an image
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="gap-2">
              <Link to="/explore">
                Browse the rig library <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
