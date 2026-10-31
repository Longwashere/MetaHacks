import { Search, SearchX } from "lucide-react";
import { Form, Link, data, href, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/explore";
import { AssetGrid } from "~/components/AssetGrid";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { getSavedAssetIds, listAssets, listCategories } from "~/lib/api.server";
import { getSession } from "~/lib/auth.server";
import { SITE_NAME, assetPath, breadcrumbJsonLd, categoryLabel, seoMeta } from "~/lib/seo";
import { getSiteUrl } from "~/lib/site.server";
import { SORT_OPTIONS, isCategorySlug, type AssetCategory, type SortOption } from "~/lib/types";
import { cn } from "~/lib/utils";

const isSort = (v: string | null): v is SortOption => SORT_OPTIONS.some((s) => s === v);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.slice(0, 200) ?? "";
  const sortParam = url.searchParams.get("sort");
  const categoryParam = params.category ?? null;
  if (categoryParam !== null && !isCategorySlug(categoryParam)) {
    throw data("Category not found", { status: 404 });
  }
  const category = categoryParam ?? undefined;
  const sort = isSort(sortParam) ? sortParam : "popular";

  const [assets, savedIds, categories] = await Promise.all([
    listAssets({ q, category, sort }),
    getSavedAssetIds(getSession(context)),
    listCategories(),
  ]);
  if (category && !categories.includes(category)) throw data("Category not found", { status: 404 });
  return { assets, savedIds, q, category: category ?? null, categories, sort, siteUrl: getSiteUrl(request) };
}

const CATEGORY_INTROS: Record<string, string> = {
  character: "Rigged Spine2D characters — heroes, NPCs and enemies with idle, walking, running, attack and death animations.",
  creature: "Spine2D creatures and monsters with squash-and-stretch, locomotion and attack animations.",
  effect: "Spine2D VFX — explosions, auras, magic and particles built with bones and additive blending.",
  prop: "Animated Spine2D props and pickups — chests, coins, doors and interactables.",
  ui: "Animated Spine2D UI — buttons, health bars and HUD elements with hover, press and state animations.",
};

const categoryIntro = (category: AssetCategory) =>
  CATEGORY_INTROS[category] ?? `Rigged Spine2D ${categoryLabel(category, true).toLowerCase()} with ready-made animations.`;

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: `Not found · ${SITE_NAME}` }, { name: "robots", content: "noindex" }];
  const { category, q, sort, assets, siteUrl } = loaderData;
  const path = category ? `/explore/${category}` : "/explore";
  const title = q
    ? `“${q}” Spine2D assets | ${SITE_NAME}`
    : category
      ? `Spine2D ${categoryLabel(category)} Assets & Animations | ${SITE_NAME}`
      : `Spine2D Assets & Animations Library | ${SITE_NAME}`;
  const description = category
    ? categoryIntro(category)
    : "Browse rigged Spine2D characters, creatures, props, effects and UI with ready-made animations. Preview in the browser and download for Spine 4.x.";

  return seoMeta({
    title,
    description,
    canonical: `${siteUrl}${path}`,
    // Search results and re-sorted lists are duplicates of the canonical page.
    index: !q && sort === "popular",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: title,
        url: `${siteUrl}${path}`,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: assets.map((a, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: `${siteUrl}${assetPath(a)}`,
            name: a.name,
          })),
        },
      },
      breadcrumbJsonLd(siteUrl, [
        { name: "Explore", path: "/explore" },
        ...(category ? [{ name: categoryLabel(category, true), path }] : []),
      ]),
    ],
  });
}

const SORT_LABELS: Record<SortOption, string> = {
  popular: "Most saved",
  newest: "Newest",
  name: "Name A–Z",
};

export default function Explore({ loaderData }: Route.ComponentProps) {
  const { assets, savedIds, q, category, categories, sort } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" && navigation.location.pathname === "/explore";

  const withParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    return next;
  };
  const query = searchParams.toString();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">
          {category ? `Spine2D ${categoryLabel(category, true)}` : "Explore Spine2D assets"}
        </h1>
        <p className="text-muted-foreground">
          {category ? categoryIntro(category) : "Browse rigged assets from the community and save the ones you like."}
        </p>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        {/* key resets the uncontrolled input when q changes via back/forward */}
        <Form method="get" role="search" className="flex flex-1 gap-2" key={q}>
          {sort !== "popular" && <input type="hidden" name="sort" value={sort} />}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="explore-q" className="sr-only">
              Search assets
            </label>
            <Input id="explore-q" name="q" defaultValue={q} placeholder="Search knights, slimes, explosions…" className="pl-9" />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </Form>
        <Select
          value={sort}
          onValueChange={(value) => setSearchParams(withParam("sort", value === "popular" ? null : value), { preventScrollReset: true })}
        >
          <SelectTrigger className="w-full md:w-40" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {SORT_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav aria-label="Categories" className="flex flex-wrap gap-2">
        {[null, ...categories].map((c) => {
          const active = c === category;
          return (
            <Button
              key={c ?? "all"}
              asChild
              size="sm"
              variant={active ? "default" : "outline"}
              className="rounded-full"
            >
              <Link
                to={{ pathname: href("/explore/:category?", { category: c ?? undefined }), search: query }}
                preventScrollReset
                aria-current={active ? "page" : undefined}
              >
                {c ? categoryLabel(c, true) : "All"}
              </Link>
            </Button>
          );
        })}
      </nav>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {assets.length} {assets.length === 1 ? "asset" : "assets"}
        {q && <> matching “{q}”</>}
      </p>

      {assets.length > 0 ? (
        <AssetGrid assets={assets} savedIds={savedIds} className={cn("lg:grid-cols-4 transition-opacity", isLoading && "opacity-60")} />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No assets found</EmptyTitle>
            <EmptyDescription>Try a different search, or remix a similar rig into exactly what you need.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button asChild variant="outline">
              <Link to="/explore">Clear filters</Link>
            </Button>
            <Button asChild>
              <Link to="/remix">Remix a rig</Link>
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
