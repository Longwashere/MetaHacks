import { Bone, ChevronsLeftRight, Loader2, Sparkles, Upload } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { SpinePlaceholder } from "~/components/SpinePlaceholder";
import { type SpineClock, SpineRuntime, type SpineRuntimeStatus } from "~/components/SpineRuntime";
import type { AssetOrigin } from "~/lib/format";
import type { SpineTweakBinding } from "~/lib/spine-tweaks";
import { defaultAnimation } from "~/lib/animation";
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
  /** When true, hide the skin textures and display only the skeleton rig. */
  hideSkin?: boolean;
  /** Hex color for the skeleton bone lines. */
  boneColor?: string;
  /** When true, display floating bone name tags on the skeleton rig. */
  showLabels?: boolean;
  /** Live rig edits; only applied when the real runtime renders. */
  tweaks?: SpineTweakBinding;
  /** Page images to swap in without reloading the rig (see SpineRuntime). */
  pageUrls?: Record<string, string>;
  /** Shown as a badge in the top-left corner: the model that made a remix, or "Original upload". */
  origin?: AssetOrigin;
  /**
   * The rig this one was remixed from. When set, it's drawn over the left of the stage, in step
   * with this one, and a draggable divider sets how much of each shows.
   */
  compareWith?: PreviewableAsset;
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
  hideSkin = false,
  boneColor,
  showLabels = false,
  tweaks,
  pageUrls,
  origin,
  compareWith,
  className,
}: SpinePreviewProps) {
  const [status, setStatus] = useState<SpineRuntimeStatus>("idle");
  const [compareStatus, setCompareStatus] = useState<SpineRuntimeStatus>("idle");
  const clock = useRef<SpineClock>({ trackTime: 0, reverse: false, at: 0 });
  const clip = asset.animations.find((a) => a.name === animation) ?? defaultAnimation(asset.animations);
  const name = clip?.name ?? "idle";
  const live = asset.files !== null && status !== "error";
  const bonesActive = showBones || hideSkin;
  const compareFiles = live && compareWith?.animations.some((a) => a.name === name) ? compareWith.files : null;
  const comparing = compareFiles !== null && compareStatus !== "error";

  return (
    <div
      role="img"
      aria-label={`${asset.category} preview playing ${name}`}
      className={cn(
        "relative flex aspect-square items-center justify-center overflow-hidden",
        STAGE_GRID,
        ACCENT_TEXT[asset.accent],
        className,
      )}
    >
      {asset.files && status !== "error" ? (
        <>
          <SpineRuntime
            files={asset.files}
            animation={name}
            // Always loop in the viewer, even one-shot clips like attacks and deaths, so the preview never freezes.
            loop
            playing={playing}
            speed={speed}
            showBones={bonesActive}
            hideSkin={hideSkin}
            boneColor={boneColor}
            showLabels={showLabels}
            tint={asset.tint}
            tweaks={tweaks}
            pageUrls={pageUrls}
            sync={compareFiles ? { clock: clock.current, lead: true } : undefined}
            onStatusChange={setStatus}
          />
          {compareWith && compareFiles && comparing && (
            <CompareLayer
              ready={status === "ready" && compareStatus === "ready"}
              original={
                <SpineRuntime
                  files={compareFiles}
                  animation={name}
                  loop
                  // The remix holds still while a tweak scrubs; follow it.
                  playing={playing && tweaks?.tweaks.scrub == null}
                  speed={speed}
                  showBones={bonesActive}
                  hideSkin={hideSkin}
                  boneColor={boneColor}
                  showLabels={showLabels}
                  tint={compareWith.tint}
                  sync={{ clock: clock.current, lead: false }}
                  onStatusChange={setCompareStatus}
                />
              }
            />
          )}
          {status !== "ready" && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />}
        </>
      ) : (
        <SpinePlaceholder
          category={asset.category}
          animation={name}
          durationSec={clip?.durationSec ?? 1.6}
          playing={playing}
          speed={speed}
          showBones={bonesActive}
          hideSkin={hideSkin}
          boneColor={boneColor}
          showLabels={showLabels}
        />
      )}
      {(origin || hideSkin) && (
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-1.5">
          {origin && (
            <span className="flex items-center gap-1.5 rounded-full border bg-background/85 px-2.5 py-0.5 text-[11px] font-medium text-foreground shadow-xs backdrop-blur-xs">
              {origin.kind === "remix" ? (
                <>
                  <Sparkles className="size-3 text-primary" />
                  Made with {origin.model}
                </>
              ) : (
                <>
                  <Upload className="size-3 text-primary" />
                  Original upload
                </>
              )}
            </span>
          )}
          {hideSkin && (
            <span className="flex items-center gap-1.5 rounded-full border bg-background/85 px-2.5 py-0.5 text-[11px] font-medium text-foreground shadow-xs backdrop-blur-xs">
              <Bone className="size-3 text-primary" />
              Skeleton Rig
            </span>
          )}
        </div>
      )}
      {!live && asset.files && (
        <span className="absolute bottom-2 left-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Preview unavailable
        </span>
      )}
    </div>
  );
}

/** The stage's grid background, for a layer that has to hide what's under it. */
export const STAGE_GRID =
  "bg-muted/40 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-size-[16px_16px]";

/**
 * Clips the original rig to the left of a draggable divider, over the remix. The divider is the
 * only thing taking pointer input, so clicks elsewhere still reach the remix (part picking).
 */
function CompareLayer({ original, ready }: { original: ReactNode; ready: boolean }) {
  const [split, setSplit] = useState(50);
  return (
    <div className={cn("pointer-events-none absolute inset-0 transition-opacity duration-300", ready ? "opacity-100" : "opacity-0")}>
      {/* The stage's grid, so the remix doesn't show through where the original is transparent. */}
      <div className="absolute inset-0 bg-card" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <div className={cn("absolute inset-0", STAGE_GRID)}>{original}</div>
      </div>
      <CompareDivider split={split} onSplitChange={setSplit} leftLabel="Original" rightLabel="Remix" />
    </div>
  );
}

interface CompareDividerProps {
  /** Percent of the stage, from the left, showing the left layer. */
  split: number;
  onSplitChange: (split: number) => void;
  leftLabel: string;
  rightLabel: string;
}

/** The draggable divider and side labels of a before/after stage. Fills its positioned parent. */
export function CompareDivider({ split, onSplitChange, leftLabel, rightLabel }: CompareDividerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const setSplit = (next: number) => onSplitChange(Math.min(100, Math.max(0, next)));

  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect?.width) setSplit(((e.clientX - rect.left) / rect.width) * 100);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const next = { ArrowLeft: split - step, ArrowRight: split + step, Home: 0, End: 100 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setSplit(next);
  };
  const label = "absolute bottom-3 max-w-[45%] truncate rounded-full border bg-background/85 px-2.5 py-0.5 text-[11px] font-medium text-foreground shadow-xs backdrop-blur-xs transition-opacity duration-200";

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20">
      {/* Each label shows only while its side is on screen. */}
      <span className={cn(label, "left-3", split > 2 ? "opacity-100" : "opacity-0")}>{leftLabel}</span>
      <span className={cn(label, "right-3", split < 98 ? "opacity-100" : "opacity-0")}>{rightLabel}</span>
      <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-background shadow-[0_0_0_1px_var(--color-border)]" style={{ left: `${split}%` }}>
        <div
          role="slider"
          tabIndex={0}
          aria-label={`Compare ${leftLabel} and ${rightLabel}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          aria-valuetext={`${Math.round(split)}% ${leftLabel}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            moveTo(e);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) moveTo(e);
          }}
          onKeyDown={onKeyDown}
          className="pointer-events-auto absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center rounded-full border bg-background text-foreground shadow-md focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronsLeftRight className="size-4" />
        </div>
      </div>
    </div>
  );
}
