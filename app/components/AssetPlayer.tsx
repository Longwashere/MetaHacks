import { Bone, Pause, Play, Repeat } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { SpinePreview } from "~/components/SpinePreview";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Slider } from "~/components/ui/slider";
import { Toggle } from "~/components/ui/toggle";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

interface AssetPlayerProps {
  asset: SpineAsset;
  /** Currently selected animation (lives in the URL so it's shareable). */
  animation: string;
  /** Builds the link for selecting another animation. */
  animationHref: (name: string) => string;
  className?: string;
}

/** Large preview with playback controls, used on the asset page and the remix flow. */
export function AssetPlayer({ asset, animation, animationHref, className }: AssetPlayerProps) {
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showBones, setShowBones] = useState(false);
  const current = asset.animations.find((a) => a.name === animation) ?? asset.animations[0];

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card", className)}>
      <SpinePreview
        asset={asset}
        animation={current?.name}
        playing={playing}
        speed={speed}
        showBones={showBones}
        className="border-b"
      />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Animations">
          {asset.animations.map((a) => {
            const active = a.name === current?.name;
            return (
              <Button
                key={a.name}
                asChild
                size="sm"
                variant={active ? "default" : "outline"}
                className="rounded-full"
              >
                <Link to={animationHref(a.name)} replace preventScrollReset aria-current={active ? "true" : undefined}>
                  {a.loop && <Repeat className="size-3" />}
                  {a.name}
                  <span className="text-xs opacity-60">{a.durationSec.toFixed(1)}s</span>
                </Link>
              </Button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="secondary"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <div className="flex flex-1 items-center gap-3">
            <Label htmlFor="speed" className="shrink-0 text-xs text-muted-foreground">
              Speed
            </Label>
            <Slider
              id="speed"
              min={0.25}
              max={2}
              step={0.25}
              value={[speed]}
              onValueChange={([v]) => setSpeed(v)}
              className="flex-1"
            />
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
          </div>
          <Toggle
            pressed={showBones}
            onPressedChange={setShowBones}
            variant="outline"
            aria-label="Show bones"
          >
            <Bone />
          </Toggle>
        </div>
      </div>
    </div>
  );
}
