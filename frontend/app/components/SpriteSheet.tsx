import { Download, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

export interface SpriteSheetSource {
  label: string;
  asset: SpineAsset;
}

/** Atlas page PNGs for one or more rigs, e.g. a remix next to the rig it came from. */
export function SpriteSheet({ sources, className }: { sources: SpriteSheetSource[]; className?: string }) {
  const available = sources.filter((s) => s.asset.files && s.asset.files.textureUrls.length > 0);
  const [sourceLabel, setSourceLabel] = useState(available[0]?.label);
  const [pageIndex, setPageIndex] = useState(0);
  const [actualSize, setActualSize] = useState(false);
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);

  const source = available.find((s) => s.label === sourceLabel) ?? available[0];
  if (!source?.asset.files) return null;

  const pages = source.asset.files.textureUrls;
  const page = Math.min(pageIndex, pages.length - 1);
  const url = pages[page];
  const fileName = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "texture.png");
  const dims = size?.url === url ? size : null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Sprite sheet</CardTitle>
        <CardDescription>
          {fileName}
          {dims && ` · ${dims.w}×${dims.h}px`}
          {pages.length > 1 && ` · page ${page + 1} of ${pages.length}`}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
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
          <img
            key={url}
            src={url}
            alt={`${source.asset.name} texture atlas${pages.length > 1 ? `, page ${page + 1}` : ""}`}
            onLoad={(e) => setSize({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className={cn("block", actualSize ? "max-w-none" : "mx-auto h-auto max-w-full")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
