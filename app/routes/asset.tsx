import { ChevronRight, Download, FileJson, GitFork, Repeat, Wand2 } from "lucide-react";
import { Link, data, href, isRouteErrorResponse, useSearchParams } from "react-router";
import type { Route } from "./+types/asset";
import { AssetGrid } from "~/components/AssetGrid";
import { AssetPlayer } from "~/components/AssetPlayer";
import { SaveButton } from "~/components/SaveButton";
import type { SpineViewMode } from "~/lib/types";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { getAsset, getSavedAssetIds, listRelatedAssets, listRemixesOf } from "~/lib/api.server";
import { getCurrentUser } from "~/lib/auth.server";
import { formatCount, formatDate } from "~/lib/format";
import {
  SITE_NAME,
  animationLabel,
  assetJsonLd,
  assetPath,
  breadcrumbJsonLd,
  categoryLabel,
  describeAsset,
  seoMeta,
} from "~/lib/seo";
import { getSiteUrl } from "~/lib/site.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await getCurrentUser(request);
  const [asset, savedIds] = await Promise.all([
    getAsset(params.assetId),
    getSavedAssetIds(user.id),
  ]);
  if (!asset) throw data("Asset not found", { status: 404 });

  // /assets/:id/:animation must name a real clip, otherwise it's a 404 (no soft-404s for crawlers).
  const animation = params.animation
    ? asset.animations.find((a) => a.name === params.animation)
    : undefined;
  if (params.animation && !animation) throw data("Animation not found", { status: 404 });

  const [related, remixes] = asset.visibility === "public"
    ? await Promise.all([listRelatedAssets(asset), listRemixesOf(asset.id)])
    : [[], []];
  return {
    asset,
    animation: animation ?? null,
    related: related.filter((a) => !remixes.some((r) => r.id === a.id)),
    remixes,
    savedIds,
    siteUrl: getSiteUrl(request),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: `Asset not found · ${SITE_NAME}` }, { name: "robots", content: "noindex" }];
  const { asset, animation, siteUrl } = loaderData;
  const category = categoryLabel(asset.category);
  const title = animation
    ? `${asset.name} ${animationLabel(animation.name)} Animation – Spine2D ${category} | ${SITE_NAME}`
    : `${asset.name} – Spine2D ${category} Asset & Animations | ${SITE_NAME}`;

  return seoMeta({
    title,
    description: describeAsset(asset, animation ?? undefined),
    canonical: `${siteUrl}${assetPath(asset, animation?.name)}`,
    index: asset.visibility === "public",
    image: asset.thumbnailUrl,
    type: "article",
    jsonLd: [
      assetJsonLd(siteUrl, asset, animation ?? undefined),
      breadcrumbJsonLd(siteUrl, [
        { name: "Explore", path: "/explore" },
        { name: categoryLabel(asset.category, true), path: `/explore/${asset.category}` },
        { name: asset.name, path: assetPath(asset) },
        ...(animation ? [{ name: `${animationLabel(animation.name)} animation`, path: assetPath(asset, animation.name) }] : []),
      ]),
    ],
  });
}

export default function AssetPage({ loaderData }: Route.ComponentProps) {
  const { asset, animation, related, remixes, savedIds } = loaderData;
  const saved = savedIds.includes(asset.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  const viewMode: SpineViewMode =
    viewParam === "skeleton" || viewParam === "overlay" ? viewParam : "skin";
  const boneColorParam = searchParams.get("boneColor");
  const boneColor = boneColorParam ? `#${boneColorParam.replace("#", "")}` : "#ef4444";

  const handleViewModeChange = (nextMode: SpineViewMode) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (nextMode === "skin") {
          next.delete("view");
        } else {
          next.set("view", nextMode);
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const handleBoneColorChange = (nextColor: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const clean = nextColor.replace("#", "").toLowerCase();
        if (clean === "ef4444") {
          next.delete("boneColor");
        } else {
          next.set("boneColor", clean);
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  const stats = [
    { label: "Bones", value: asset.boneCount },
    { label: "Slots", value: asset.slotCount },
    { label: "Animations", value: asset.animations.length },
    { label: "Spine", value: asset.spineVersion },
  ];

  const buildAnimationUrl = (name: string) => {
    const base = assetPath(asset, name);
    const q = new URLSearchParams();
    if (viewMode !== "skin") q.set("view", viewMode);
    if (boneColor.toLowerCase() !== "#ef4444") q.set("boneColor", boneColor.replace("#", ""));
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
  };

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <li>
              <Link to="/explore" className="hover:text-foreground">Explore</Link>
            </li>
            <ChevronRight className="size-3.5" aria-hidden />
            <li>
              <Link to={href("/explore/:category?", { category: asset.category })} className="hover:text-foreground">
                {categoryLabel(asset.category, true)}
              </Link>
            </li>
            <ChevronRight className="size-3.5" aria-hidden />
            <li>
              {animation ? (
                <Link to={assetPath(asset)} className="hover:text-foreground">{asset.name}</Link>
              ) : (
                <span aria-current="page" className="text-foreground">{asset.name}</span>
              )}
            </li>
            {animation && (
              <>
                <ChevronRight className="size-3.5" aria-hidden />
                <li aria-current="page" className="text-foreground">{animationLabel(animation.name)}</li>
              </>
            )}
          </ol>
        </nav>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <AssetPlayer
            asset={asset}
            animation={animation?.name ?? asset.animations[0]?.name ?? "idle"}
            animationHref={buildAnimationUrl}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            boneColor={boneColor}
            onBoneColorChange={handleBoneColorChange}
          />

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge className="capitalize">{asset.category}</Badge>
                <Badge variant="secondary" className="capitalize">{asset.style}</Badge>
                {asset.remixOf ? (
                  <Badge variant="outline" asChild>
                    <Link to={assetPath(asset.remixOf)}>
                      <GitFork /> Remix of {asset.remixOf.name}
                    </Link>
                  </Badge>
                ) : (
                  <Badge variant="outline">Original rig</Badge>
                )}
                {asset.visibility === "private" && <Badge variant="outline">Private</Badge>}
              </div>
              <h1 className="text-3xl font-bold tracking-tight">
                {asset.name}
                {animation && <span className="text-muted-foreground"> {animationLabel(animation.name)} Animation</span>}
              </h1>
              <p className="text-muted-foreground">{describeAsset(asset, animation ?? undefined)}</p>
              <p className="text-sm text-muted-foreground">
                by <span className="font-medium text-foreground">{asset.author.name}</span> ·{" "}
                <time dateTime={asset.createdAt}>{formatDate(asset.createdAt)}</time> · {formatCount(asset.saves)} saves ·{" "}
                {formatCount(asset.downloads)} downloads
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to={`/remix?${new URLSearchParams({ base: asset.id })}`} rel="nofollow">
                  <Wand2 /> Remix this rig
                </Link>
              </Button>
              <SaveButton assetId={asset.id} assetName={asset.name} saved={saved} />
              <Button asChild variant="outline">
                {/* reloadDocument: this is a resource route returning a file */}
                <Link to={href("/assets/:assetId/download", { assetId: asset.id })} reloadDocument rel="nofollow">
                  <Download /> Download
                </Link>
              </Button>
            </div>

            <Card className="gap-4">
              <CardHeader>
                <CardTitle className="text-base">Rig details</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="grid grid-cols-4 gap-2 text-center">
                  {stats.map((s) => (
                    <div key={s.label} className="rounded-md bg-muted p-2">
                      <dt className="text-xs text-muted-foreground">{s.label}</dt>
                      <dd className="font-semibold tabular-nums">{s.value}</dd>
                    </div>
                  ))}
                </dl>
                <Separator />
                {asset.files ? (
                  <ul className="flex flex-col gap-2 text-sm">
                    {[
                      { url: asset.files.skeletonUrl, kind: "skeleton" },
                      { url: asset.files.atlasUrl, kind: "atlas" },
                      ...asset.files.textureUrls.map((url) => ({ url, kind: "texture" })),
                    ].map((file) => (
                      <li key={file.url} className="flex items-center gap-2">
                        <FileJson className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{file.url.split("/").pop()}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{file.kind}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No exported files yet — showing a placeholder rig.</p>
                )}
              </CardContent>
            </Card>

            {asset.prompt && (
              <Card className="gap-2">
                <CardHeader>
                  <CardTitle className="text-base">Texture prompt</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground italic">“{asset.prompt}”</p>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-wrap gap-2">
              {asset.tags.map((tag) => (
                <Badge key={tag} variant="outline" asChild>
                  <Link to={`/explore?q=${encodeURIComponent(tag)}`}>#{tag}</Link>
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Plain, crawlable links to every animation page. */}
      <section aria-labelledby="animations-heading" className="flex flex-col gap-4">
        <h2 id="animations-heading" className="text-xl font-semibold tracking-tight">
          {asset.name} animations
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {asset.animations.map((a) => (
            <li key={a.name}>
              <Link
                to={buildAnimationUrl(a.name)}
                aria-current={a.name === animation?.name ? "page" : undefined}
                className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent aria-[current=page]:border-primary"
              >
                {a.loop && <Repeat className="size-4 text-muted-foreground" aria-label="Loops" />}
                <span className="font-medium">
                  {asset.name} {animationLabel(a.name).toLowerCase()} animation
                </span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{a.durationSec.toFixed(1)}s</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {remixes.length > 0 && (
        <section aria-labelledby="remixes-heading" className="flex flex-col gap-4">
          <h2 id="remixes-heading" className="text-xl font-semibold tracking-tight">
            Remixes of {asset.name}
          </h2>
          <AssetGrid assets={remixes} savedIds={savedIds} />
        </section>
      )}

      {related.length > 0 && (
        <section aria-labelledby="related-heading" className="flex flex-col gap-4">
          <div className="flex items-end justify-between">
            <h2 id="related-heading" className="text-xl font-semibold tracking-tight">
              More Spine2D {categoryLabel(asset.category, true).toLowerCase()}
            </h2>
            <Button asChild variant="ghost" size="sm">
              <Link to={href("/explore/:category?", { category: asset.category })}>View all</Link>
            </Button>
          </div>
          <AssetGrid assets={related} savedIds={savedIds} />
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">{notFound ? "Asset not found" : "Something went wrong"}</h1>
      <p className="text-muted-foreground">
        {notFound ? "It may have been removed or the link is wrong." : "We couldn't load this asset."}
      </p>
      <Button asChild>
        <Link to="/explore">Back to Explore</Link>
      </Button>
    </div>
  );
}
