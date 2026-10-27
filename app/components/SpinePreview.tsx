import { Loader2 } from "lucide-react";
import { useState } from "react";
import { SpinePlaceholder } from "~/components/SpinePlaceholder";
import { SpineRuntime, type SpineRuntimeStatus } from "~/components/SpineRuntime";
import type { AssetAccent, PreviewableAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

const ACCENT_TEXT: Record<AssetAccent, string> = {
  "chart-1": "text-chart-1",
  "chart-2": "text-chart-2",
  "chart-3": "text-chart-3",
  "chart-4": "text-chart-4",
  "chart-5": "text-chart-5",
};

export interface SpinePreviewProps {
  asset: PreviewableAsset;
  /** Animation to play. Defaults to the asset's first animation. */
  animation?: string;
  playing?: boolean;
  speed?: number;
  showBones?: boolean;
  className?: string;
}

/**
 * Square stage that renders an asset's Spine rig with the real runtime when the
 * asset has exported files, and a placeholder SVG rig otherwise.
 */
export function SpinePreview({
  asset,
  animation,
  playing = true,
  speed = 1,
  showBones = false,
  className,
}: SpinePreviewProps) {
  const [status, setStatus] = useState<SpineRuntimeStatus>("idle");
  const clip = asset.animations.find((a) => a.name === animation) ?? asset.animations[0];
  const name = clip?.name ?? "idle";
  const live = asset.files !== null && status !== "error";

  return (
    <div
      role="img"
      aria-label={`${asset.category} preview playing ${name}`}
      className={cn(
        "relative flex aspect-square items-center justify-center overflow-hidden bg-muted/40",
        "bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-size-[16px_16px]",
        ACCENT_TEXT[asset.accent],
        className,
      )}
    >
      {asset.files && status !== "error" ? (
        <>
          <SpineRuntime
            files={asset.files}
            animation={name}
            loop={clip?.loop ?? true}
            playing={playing}
            speed={speed}
            showBones={showBones}
            tint={asset.tint}
            onStatusChange={setStatus}
          />
          {status !== "ready" && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />}
        </>
      ) : (
        <SpinePlaceholder
          category={asset.category}
          animation={name}
          durationSec={clip?.durationSec ?? 1.6}
          playing={playing}
          speed={speed}
          showBones={showBones}
        />
      )}
      {!live && asset.files && (
        <span className="absolute bottom-2 left-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Preview unavailable
        </span>
      )}
    </div>
  );
}
