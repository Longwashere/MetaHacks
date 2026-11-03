import { ArrowRight, Bone, Download, Search, Sparkles, Upload, Wand2 } from "lucide-react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/home";
import { AssetGrid } from "~/components/AssetGrid";
import { RemixShowcase } from "~/components/RemixShowcase";
import { RotatingWord } from "~/components/RotatingWord";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { getAsset, getSavedAssetIds, listFeaturedAssets } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";
import { SITE_NAME, seoMeta } from "~/lib/seo";
import { SHOWCASE_RIGS } from "~/lib/showcase";
import { getSiteUrl } from "~/lib/site.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return seoMeta({
    title: `${SITE_NAME} — Remix, Rig & Animate Spine2D Characters with AI`,
    description:
      "Auto-rig a Spine2D character from a single image, remix any rig with new AI-generated textures, and generate new animations. Export production-ready Spine 4.2 rigs.",
    canonical: `${loaderData.siteUrl}/`,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE_NAME,
        url: `${loaderData.siteUrl}/`,
        potentialAction: {
          "@type": "SearchAction",
          target: `${loaderData.siteUrl}/explore?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      },
    ],
  });
}

/** Hand-picked assets for "Popular in the library", in display order. Missing or private ones are skipped. */
const PINNED_ASSET_IDS = [
  "black-crude-oil-elemental-7c067abb",
  "tempest-wind-elemental-523d43e4",
  "desert-troll-bruiser-057725aa",
  "forest-bark-wizard-d47ec5b4",
  "dark-pixel-samurai-lord-ece13bc2",
  "one-eyed-goblin-troll-d16e68b3",
  "ember-fire-knight-7e215105",
  "arcane-spellcaster-skeleton-copy-df2c05e9",
];
const FEATURED_COUNT = 8;

export async function loader({ request, context }: Route.LoaderArgs) {
  const [pinned, popular, savedIds] = await Promise.all([
    Promise.all(PINNED_ASSET_IDS.map((assetId) => getAsset(assetId, null))),
    listFeaturedAssets(FEATURED_COUNT),
    getSavedAssetIds(getSession(context)),
  ]);
  // Pinned first, topped up with the most-saved assets so the row is never short.
  const picked = pinned.filter((asset) => asset !== null);
  const pickedIds = new Set(picked.map((asset) => asset.id));
  const featured = [...picked, ...popular.filter((asset) => !pickedIds.has(asset.id))].slice(0, FEATURED_COUNT);
  return { featured, savedIds, siteUrl: getSiteUrl(request) };
}

const STEPS = [
  {
    icon: Bone,
    title: "Pick a rig",
    body: "Any rigged, animated asset from the library, or one you've saved.",
  },
  {
    icon: Wand2,
    title: "Describe the new look",
    body: "We repaint the textures to fit the existing atlas, so bones, slots and animations stay intact.",
  },
  {
    icon: Download,
    title: "Preview and export",
    body: "Scrub animations in the browser, then download a Spine 4.2 export for your engine.",
  },
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { featured, savedIds } = loaderData;
  return (
    <div className="flex flex-col gap-16 lg:gap-20">
      <section className="grid items-center gap-10 pt-4 lg:grid-cols-2 lg:gap-12">
        <div className="flex flex-col items-center gap-6 text-center lg:items-start lg:text-left">
          <Badge variant="secondary" className="gap-1">
            <Sparkles className="size-3" /> Powered by Muse
          </Badge>
          <h1 className="text-4xl leading-tight font-bold tracking-tight text-balance sm:text-5xl">
            <span className="sr-only">Remix, rig and animate Spine2D characters with a prompt</span>
            <RotatingWord words={["Remix", "Rig", "Animate"]} className="text-primary" />{" "}
            <span aria-hidden>Spine2D characters with a prompt</span>
          </h1>
          <p className="max-w-xl text-lg text-pretty text-muted-foreground">
            Turn one image into a playable rig, give any library rig a new look, or generate new animations. Then export production-ready Spine 4.2 rigs.
          </p>
          <Form method="get" action="/remix" className="flex w-full max-w-xl flex-col gap-2 sm:flex-row">
            <label htmlFor="hero-q" className="sr-only">
              Find a rig to remix
            </label>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="hero-q" name="rq" placeholder="Find a rig: monk, knight, slime…" className="h-11 pl-9" />
            </div>
            <Button type="submit" size="lg" className="h-11">
              <Wand2 /> Remix a rig
            </Button>
          </Form>
          <div className="flex gap-2 text-sm text-muted-foreground">
            <span>or</span>
            <Link to="/explore" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
              browse the full library
            </Link>
          </div>
        </div>

        {SHOWCASE_RIGS.length > 0 && (
          <div className="mx-auto flex w-full max-w-xl flex-col gap-2">
            <RemixShowcase rigs={SHOWCASE_RIGS} />
            <p className="text-center text-sm text-muted-foreground">Same bones, same animation. Drag the slider to compare with the original.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="how-title" className="flex flex-col gap-6">
        <h2 id="how-title" className="sr-only">
          How it works
        </h2>
        <ol className="grid gap-6 md:grid-cols-3 md:gap-8">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {i + 1}
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2 font-medium">
                  <step.icon className="size-4 text-muted-foreground" aria-hidden />
                  {step.title}
                </h3>
                <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Popular in the library</h2>
            <p className="text-sm text-muted-foreground">Rigs and remixes you can save and use right away.</p>
          </div>
          <Button asChild variant="ghost">
            <Link to="/explore">
              Browse all <ArrowRight />
            </Link>
          </Button>
        </div>
        <AssetGrid assets={featured} savedIds={savedIds} compact />
      </section>

      <Card>
        <CardContent className="flex flex-col items-center gap-6 py-4 text-center md:flex-row md:justify-between md:text-left">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">Have your own rig?</h2>
            <p className="max-w-lg text-pretty text-muted-foreground">
              Upload a Spine export and remix it the same way. Your skeleton and animations never change, only the textures do.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Button asChild variant="outline">
              <Link to="/upload">
                <Upload /> Upload a rig
              </Link>
            </Button>
            <Button asChild>
              <Link to="/remix">
                <Wand2 /> Start remixing
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
