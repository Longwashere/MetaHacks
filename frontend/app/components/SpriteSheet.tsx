import { Download, Maximize2, Minimize2, RefreshCw, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type AtlasPage, parseAtlas } from "~/lib/atlas";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

export interface SpriteSheetSource {
  label: string;
  asset: SpineAsset;
}

/** Clickable regions: each box toggles its region name in `selected`. */
export interface SpriteSheetSelection {
  selected: string[];
  onToggle: (region: string) => void;
  disabled?: boolean;
}

/**
 * Atlas page PNGs for one or more rigs, e.g. a remix next to the rig it came from. With
 * `selection`, the region boxes are buttons and the labels toggle only hides their names.
 */
export function SpriteSheet({
  sources,
  selection,
  refresh,
  className,
}: {
  sources: SpriteSheetSource[];
  selection?: SpriteSheetSelection;
  /** Shows a reload button, e.g. after a part fix has changed the pages. */
  refresh?: { onRefresh: () => void; pending: boolean };
  className?: string;
}) {
  const available = sources.filter((s) => s.asset.files && s.asset.files.textureUrls.length > 0);
  const [sourceLabel, setSourceLabel] = useState(available[0]?.label);
  const [pageIndex, setPageIndex] = useState(0);
  const [actualSize, setActualSize] = useState(false);
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [atlas, setAtlas] = useState<{ url: string; pages: AtlasPage[] } | null>(null);

  const source = available.find((s) => s.label === sourceLabel) ?? available[0];
  const atlasUrl = source?.asset.files?.atlasUrl;

  // Region names and rects come from the .atlas file; remix atlases are served by the backend (with CORS).
  useEffect(() => {
    if (!atlasUrl) return;
    const controller = new AbortController();
    fetch(atlasUrl, { signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => setAtlas({ url: atlasUrl, pages: parseAtlas(text) }))
      .catch(() => {});
    return () => controller.abort();
  }, [atlasUrl]);

  if (!source?.asset.files) return null;

  const pages = source.asset.files.textureUrls;
  const page = Math.min(pageIndex, pages.length - 1);
  const url = pages[page];
  const fileName = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "texture.png");
  const dims = size?.url === url ? size : null;
  const atlasPages = atlas && atlas.url === atlasUrl ? atlas.pages : [];
  // Match the page by file name; fall back to its position in the atlas.
  const atlasPage = atlasPages.find((p) => p.name === fileName) ?? atlasPages[page];
  const pageW = atlasPage?.width ?? dims?.w;
  const pageH = atlasPage?.height ?? dims?.h;
  const regions = (showLabels || selection) && atlasPage && pageW && pageH ? atlasPage.regions : [];

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Sprite sheet</CardTitle>
        <CardDescription>
          {fileName}
          {dims && ` · ${dims.w}×${dims.h}px`}
          {pages.length > 1 && ` · page ${page + 1} of ${pages.length}`}
          {atlasPage && ` · ${atlasPage.regions.length} regions`}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {refresh && (
            <Button
              variant="outline"
              size="icon"
              onClick={refresh.onRefresh}
              disabled={refresh.pending}
              aria-label="Reload the sprite sheet"
              title="Reload the sprite sheet"
            >
              <RefreshCw className={cn(refresh.pending && "animate-spin")} />
            </Button>
          )}
          <Button
            variant={showLabels ? "secondary" : "outline"}
            size="icon"
            onClick={() => setShowLabels((v) => !v)}
            aria-label={showLabels ? "Hide region labels" : "Show region labels"}
            aria-pressed={showLabels}
            disabled={!atlasPage}
          >
            <Tags />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setActualSize((v) => !v)}
            aria-label={actualSize ? "Fit to width" : "Show actual size"}
            aria-pressed={actualSize}
          >
            {actualSize ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button asChild variant="outline" size="icon">
            <a href={url} download={fileName} target="_blank" rel="noreferrer" aria-label={`Download ${fileName}`}>
              <Download />
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(available.length > 1 || pages.length > 1) && (
          <div className="flex flex-wrap items-center gap-3">
            {available.length > 1 && (
              <Tabs value={source.label} onValueChange={setSourceLabel}>
                <TabsList>
                  {available.map((s) => (
                    <TabsTrigger key={s.label} value={s.label}>
                      {s.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
            {pages.length > 1 && (
              <Tabs value={String(page)} onValueChange={(v) => setPageIndex(Number(v))}>
                <TabsList>
                  {pages.map((p, i) => (
                    <TabsTrigger key={p} value={String(i)}>
                      Page {i + 1}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
          </div>
        )}
        <div
          className={cn(
            "max-h-[70vh] overflow-auto rounded-lg border",
            // Checkerboard so transparent regions of the atlas are visible.
            "bg-[repeating-conic-gradient(var(--muted)_0%_25%,var(--background)_0%_50%)] bg-size-[16px_16px]",
          )}
        >
          <div className={cn("relative", actualSize ? "w-max" : "mx-auto w-fit")}>
            <img
              key={url}
              src={url}
              // Same CORS mode as the Spine runtime's loader. A plain request caches a response
              // without CORS headers, which the viewer's WebGL load then reuses and rejects.
              crossOrigin="anonymous"
              alt={`${source.asset.name} texture atlas${pages.length > 1 ? `, page ${page + 1}` : ""}`}
              onLoad={(e) => setSize({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className={cn("block", actualSize ? "max-w-none" : "h-auto max-w-full")}
            />
            {pageW && pageH && regions.length > 0 && !selection && (
              // Atlas coordinates are page pixels from the top-left, so percentages keep the
              // boxes aligned at any zoom.
              <div className="absolute inset-0" aria-hidden>
                {regions.map((r, i) => (
                  <div
                    key={`${r.name}:${i}`}
                    title={r.rotate ? `${r.name} (rotated ${r.rotate}°)` : r.name}
                    className="group absolute border border-primary/60 hover:z-10 hover:border-primary hover:bg-primary/15"
                    style={{
                      left: `${(r.x / pageW) * 100}%`,
                      top: `${(r.y / pageH) * 100}%`,
                      width: `${(r.width / pageW) * 100}%`,
                      height: `${(r.height / pageH) * 100}%`,
                    }}
                  >
                    <span className="block max-w-full truncate bg-background/80 px-0.5 text-[10px] leading-tight text-foreground group-hover:max-w-none group-hover:w-max group-hover:bg-primary group-hover:text-primary-foreground">
                      {r.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {pageW && pageH && regions.length > 0 && selection && (
              <div className="absolute inset-0">
                {regions.map((r, i) => {
                  const selected = selection.selected.includes(r.name);
                  return (
                    <button
                      key={`${r.name}:${i}`}
                      type="button"
                      onClick={() => selection.onToggle(r.name)}
                      disabled={selection.disabled}
                      aria-pressed={selected}
                      aria-label={r.name}
                      title={r.rotate ? `${r.name} (rotated ${r.rotate}°)` : r.name}
                      className={cn(
                        "group absolute cursor-pointer border outline-none hover:z-10 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                        selected
                          ? "z-[5] border-2 border-primary bg-primary/30"
                          : "border-primary/60 hover:border-primary hover:bg-primary/15",
                      )}
                      style={{
                        left: `${(r.x / pageW) * 100}%`,
                        top: `${(r.y / pageH) * 100}%`,
                        width: `${(r.width / pageW) * 100}%`,
                        height: `${(r.height / pageH) * 100}%`,
                      }}
                    >
                      {(showLabels || selected) && (
                        <span
                          className={cn(
                            "absolute top-0 left-0 block max-w-full truncate px-0.5 text-left text-[10px] leading-tight group-hover:w-max group-hover:max-w-none",
                            selected
                              ? "bg-primary text-primary-foreground"
                              : "bg-background/80 text-foreground group-hover:bg-primary group-hover:text-primary-foreground",
                          )}
                        >
                          {r.name}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
