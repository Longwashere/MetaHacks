import {
  ArrowRight,
  Bone,
  CheckCircle2,
  Cpu,
  Layers,
  Palette,
  Play,
  RotateCcw,
  ShieldCheck,
  Skull,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/showcase";
import { ModelSlideshowSection } from "~/components/ModelSlideshowSection";
import { ZombieArenaPlayer } from "~/components/ZombieArenaPlayer";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { SITE_NAME, seoMeta } from "~/lib/seo";
import { getSiteUrl } from "~/lib/site.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return seoMeta({
    title: `Showcase — Unify Any 2D Assets into One Cohesive Art Direction | ${SITE_NAME}`,
    description:
      "See how RigForge takes Spine 2D assets from different creators and unifies them into a single, cohesive game art style using Meta's Muse Image and Muse Spark models. Interactive walking arena and 4 model slideshows.",
    canonical: `${loaderData.siteUrl}/showcase`,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  return { siteUrl: getSiteUrl(request) };
}

const HIGHLIGHTS = [
  {
    icon: Palette,
    title: "1. Take Any Mismatched Assets",
    description:
      "Game developers often buy or gather Spine 2D characters from Unity Asset Store, itch.io, or different freelancers with clashing art styles and lighting.",
  },
  {
    icon: Wand2,
    title: "2. Prompt a Unified Art Direction",
    description:
      "Feed in a single prompt (e.g. 'Comic book illustration converted to a rotting ghoul with pale olive-green skin and dark crosshatch shading') to align every asset.",
  },
  {
    icon: Bone,
    title: "3. 100% Animations Preserved",
    description:
      "Meta's Muse repaints within existing atlas UV regions. Every walk cycle, run, attack, and death animation plays without touching a single bone.",
  },
];

export default function ShowcaseRoute() {
  return (
    <div className="flex flex-col gap-16 lg:gap-24">
      {/* Hero Section: What RigForge Does */}
      <section className="flex flex-col items-center text-center pt-2 md:pt-6">
        <Badge variant="secondary" className="mb-4 gap-1.5 px-3 py-1 text-xs">
          <Sparkles className="size-3.5 text-primary" />
          The Art Direction Engine for Spine 2D
        </Badge>
        <h1 className="max-w-4xl text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl text-balance">
          One Game. One Art Direction.{" "}
          <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
            Any Asset Pack.
          </span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground text-pretty">
          Don&apos;t throw away mismatched 2D rigs. RigForge uses Meta&apos;s Muse Image and Muse Spark to
          repaint character texture atlases into a single cohesive aesthetic — while keeping every bone,
          slot hierarchy, and keyframe animation 100% intact.
        </p>

        {/* Feature Pill Stats */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-xs sm:text-sm">
          <div className="flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 shadow-sm">
            <CheckCircle2 className="size-4 text-emerald-500" />
            <span>Zero Re-Rigging Required</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 shadow-sm">
            <CheckCircle2 className="size-4 text-emerald-500" />
            <span>Spine 4.2 Native Exports</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 shadow-sm">
            <CheckCircle2 className="size-4 text-emerald-500" />
            <span>Meta Muse AI Texture Synthesis</span>
          </div>
        </div>
      </section>

      {/* Main Interactive Feature: The Walking Zombie Arena */}
      <section aria-labelledby="arena-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Badge variant="outline" className="w-fit gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <Skull className="size-3" /> Live Interactive Demonstration
          </Badge>
          <h2 id="arena-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Watch Mismatched Rigs Unify in Real-Time
          </h2>
          <p className="text-sm text-muted-foreground max-w-3xl">
            14 completely different base models — from Knights, Mounted Cavaliers, Gladiators, and Barbarians to Golems, Acid Grubs, Slimes, Frost Dragons,
            Lurkers, and Fire Whelps — traverse the battlefield and clash in melee duels when they collide. Drag the slider to transform their disparate textures into a
            cohesive <strong>Rotting Ghoul / Zombie Apocalypse</strong> art style!
          </p>
        </div>

        {/* Interactive Spine Player Arena with Walking Characters and Slider */}
        <ZombieArenaPlayer />
      </section>

      {/* 3 Steps Explaining The Magic */}
      <section aria-labelledby="how-it-works-heading" className="flex flex-col gap-6">
        <div className="text-center">
          <h2 id="how-it-works-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Why Game Developers Need This
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Solve the #1 problem of 2D game asset production: style clashing.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {HIGHLIGHTS.map((item) => (
            <Card key={item.title} className="border bg-card/60 shadow-sm backdrop-blur">
              <CardContent className="flex flex-col gap-3 p-6">
                <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <item.icon className="size-5" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* 4 Slideshows with 4 Different Models */}
      <section aria-labelledby="slideshows-heading" className="flex flex-col gap-6">
        <ModelSlideshowSection />
      </section>

      {/* Bottom CTA Banner */}
      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-primary/5 p-8 text-center shadow-lg sm:p-12">
        <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-5">
          <Badge variant="secondary" className="gap-1">
            <Zap className="size-3.5 text-primary" /> Ready to Harmonize Your Game?
          </Badge>
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl text-balance">
            Start Remixing Any Spine 2D Rig Today
          </h2>
          <p className="text-muted-foreground text-pretty">
            Browse our library of pre-rigged characters and props, or upload your studio&apos;s own Spine rigs
            to repaint them with Meta&apos;s Muse models in minutes.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Button size="lg" asChild className="gap-2">
              <Link to="/remix">
                <Wand2 className="size-4" /> Open Remix Studio
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="gap-2">
              <Link to="/explore">
                Explore 40+ Rigs <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

