import { ArrowRight, Bone, Library, Search, Sparkles, Wand2 } from "lucide-react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/home";
import { AssetGrid } from "~/components/AssetGrid";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { getAsset, getSavedAssetIds, listFeaturedAssets } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";
import { SITE_NAME, seoMeta } from "~/lib/seo";
import { getSiteUrl } from "~/lib/site.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return seoMeta({
    title: `${SITE_NAME} — Remix Spine2D Rigs & Animations with AI Textures`,
    description:
      "Browse a library of rigged, animated Spine2D characters and props, then remix any rig with new AI-generated textures — every animation keeps working.",
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
    body: "Choose any rigged, animated asset from the library — or one you've saved.",
  },
  {
    icon: Wand2,
    title: "Describe the new look",
    body: "We repaint the textures to fit the existing atlas, so bones, slots and animations stay intact.",
  },
  {
    icon: Library,
    title: "Preview, save, export",
    body: "Scrub animations in the browser, save to your library, and drop into your engine.",
  },
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { featured, savedIds } = loaderData;
  return (
    <div className="flex flex-col gap-16">
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 pt-8 text-center">
        <Badge variant="secondary" className="gap-1">
          <Sparkles className="size-3" /> Spine 4.2 export
        </Badge>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Remix production-ready Spine2D rigs with a prompt
        </h1>
        <p className="max-w-xl text-lg text-pretty text-muted-foreground">
          Start from a fully rigged, animated character or prop and give it a brand-new look. Every walk cycle, attack and idle keeps working.
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
            <Wand2 /> Find a rig
          </Button>
        </Form>
        <div className="flex gap-2 text-sm text-muted-foreground">
          <span>or</span>
          <Link to="/explore" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
            browse the full library
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <Card key={step.title}>
            <CardHeader>
              <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <step.icon className="size-5" />
              </div>
              <CardTitle>
                {i + 1}. {step.title}
              </CardTitle>
              <CardDescription>{step.body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Popular in the library</h2>
            <p className="text-sm text-muted-foreground">Community assets you can save and use right away.</p>
          </div>
          <Button asChild variant="ghost">
            <Link to="/explore">
              Browse all <ArrowRight />
            </Link>
          </Button>
        </div>
        <AssetGrid assets={featured} savedIds={savedIds} />
        <div className="flex justify-center pt-4">
          <Button
            asChild
            size="lg"
            variant="outline"
            className="group h-12 gap-2 rounded-full px-8 text-base font-semibold has-[>svg]:px-8 sm:h-14 sm:px-10 sm:text-lg sm:has-[>svg]:px-10"
          >
            <Link to="/explore">
              Explore more <ArrowRight className="size-5 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
        </div>
      </section>

      <Card className="items-center bg-primary text-center text-primary-foreground">
        <CardContent className="flex flex-col items-center gap-4 py-4">
          <h2 className="text-2xl font-semibold">Every rig in the library is remixable</h2>
          <p className="max-w-md opacity-80">
            Turn a knight into a frost knight or a monk into a shadow monk — same skeleton, same animations, new textures.
          </p>
          <Button asChild variant="secondary">
            <Link to="/remix">
              <Wand2 /> Start remixing
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
