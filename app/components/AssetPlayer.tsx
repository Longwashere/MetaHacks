import { Bone, Eye, Layers, Pause, Play, Repeat, Tag } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { SpinePreview } from "~/components/SpinePreview";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Slider } from "~/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Toggle } from "~/components/ui/toggle";
import type { SpineAsset, SpineViewMode } from "~/lib/types";
import { cn } from "~/lib/utils";

interface AssetPlayerProps {
  asset: SpineAsset;
  /** Currently selected animation (lives in the URL so it's shareable). */
  animation: string;
  /** Builds the link for selecting another animation. */
  animationHref: (name: string) => string;
  /** View mode: full textured skin, skeleton rig only, or overlay. */
  viewMode?: SpineViewMode;
  onViewModeChange?: (mode: SpineViewMode) => void;
  /** Hex color for the bone rig lines (e.g. "#ef4444"). */
  boneColor?: string;
  onBoneColorChange?: (color: string) => void;
  /** When true, renders bone name tags on the skeleton rig. */
  showLabels?: boolean;
  onShowLabelsChange?: (show: boolean) => void;
  className?: string;
}

const BONE_PRESET_COLORS = [
  { name: "Spine Red", value: "#ef4444" },
  { name: "Cyan", value: "#06b6d4" },
  { name: "Neon Green", value: "#22c55e" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Purple", value: "#a855f7" },
  { name: "White", value: "#ffffff" },
];

/** Large preview with playback controls, used on the asset page and the remix flow. */
export function AssetPlayer({
  asset,
  animation,
  animationHref,
  viewMode: controlledViewMode,
  onViewModeChange,
  boneColor: controlledBoneColor,
  onBoneColorChange,
  showLabels: controlledShowLabels,
  onShowLabelsChange,
  className,
}: AssetPlayerProps) {
  const [internalViewMode, setInternalViewMode] = useState<SpineViewMode>("skin");
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = onViewModeChange ?? setInternalViewMode;

  const [internalBoneColor, setInternalBoneColor] = useState<string>("#ef4444");
  const boneColor = controlledBoneColor ?? internalBoneColor;
  const setBoneColor = onBoneColorChange ?? setInternalBoneColor;

  const [internalShowLabels, setInternalShowLabels] = useState(false);
  const showLabels = controlledShowLabels ?? internalShowLabels;
  const setShowLabels = onShowLabelsChange ?? setInternalShowLabels;

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showBones, setShowBones] = useState(false);
  const current = asset.animations.find((a) => a.name === animation) ?? asset.animations[0];

  const hideSkin = viewMode === "skeleton";
  const bonesActive = viewMode === "skeleton" || viewMode === "overlay" || showBones;

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card", className)}>
      {/* View mode switcher tab bar & bone color controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
        <Tabs
          value={viewMode}
          onValueChange={(v) => {
            const next = v as SpineViewMode;
            setViewMode(next);
            setShowBones(next === "skeleton" || next === "overlay");
          }}
          className="w-auto"
        >
          <TabsList className="h-8 p-0.5">
            <TabsTrigger value="skin" className="gap-1.5 px-3 py-1 text-xs">
              <Eye className="size-3.5" />
              Skin
            </TabsTrigger>
            <TabsTrigger value="skeleton" className="gap-1.5 px-3 py-1 text-xs">
              <Bone className="size-3.5" />
              Skeleton
            </TabsTrigger>
            <TabsTrigger value="overlay" className="gap-1.5 px-3 py-1 text-xs">
              <Layers className="size-3.5" />
              Skin + Rig
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
          {/* Bone Color Picker & Labels Toggle (active whenever skeleton/bones are shown) */}
          {bonesActive && (
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5" role="group" aria-label="Bone rig line color">
                <span className="text-[11px] font-medium text-muted-foreground">Rig color:</span>
                <div className="flex items-center gap-1">
                  {BONE_PRESET_COLORS.map((preset) => {
                    const isSelected = boneColor.toLowerCase() === preset.value.toLowerCase();
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => setBoneColor(preset.value)}
                        className={cn(
                          "size-4.5 rounded-full transition-transform focus-visible:outline-2 focus-visible:outline-ring",
                          isSelected ? "scale-115 ring-2 ring-primary ring-offset-1 ring-offset-background" : "border border-border/80 opacity-80 hover:scale-110 hover:opacity-100",
                        )}
                        style={{ backgroundColor: preset.value }}
                        title={preset.name}
                        aria-label={`Set bone color to ${preset.name}`}
                        aria-pressed={isSelected}
                      />
                    );
                  })}

                  {/* Custom Color Input */}
                  <label
                    className="relative size-4.5 cursor-pointer rounded-full border border-border/80 bg-[conic-gradient(at_center,#ef4444,#f59e0b,#22c55e,#06b6d4,#a855f7,#ef4444)] shadow-xs transition-transform hover:scale-110"
                    title="Choose custom bone color"
                  >
                    <span className="sr-only">Choose custom bone color</span>
                    <input
                      type="color"
                      value={boneColor}
                      onChange={(e) => setBoneColor(e.target.value)}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                      aria-label="Custom bone color picker"
                    />
                  </label>
                </div>
              </div>

              {/* Bone Labels Toggle */}
              <Toggle
                size="sm"
                pressed={showLabels}
                onPressedChange={setShowLabels}
                variant="outline"
                className="h-6.5 gap-1.5 px-2 text-[11px] font-medium"
                aria-label={showLabels ? "Hide bone labels" : "Show bone labels"}
                title="Toggle bone name tags on skeleton"
              >
                <Tag className="size-3" />
                <span>Labels</span>
              </Toggle>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{asset.boneCount}</span> bones
            <span>·</span>
            <span className="font-medium tabular-nums text-foreground">{asset.slotCount}</span> slots
          </div>
        </div>
      </div>

      <SpinePreview
        asset={asset}
        animation={current?.name}
        playing={playing}
        speed={speed}
        showBones={bonesActive}
        hideSkin={hideSkin}
        boneColor={boneColor}
        showLabels={bonesActive && showLabels}
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
            pressed={bonesActive}
            onPressedChange={(pressed) => {
              setShowBones(pressed);
              if (!pressed) {
                setViewMode("skin");
              } else if (viewMode === "skin") {
                setViewMode("overlay");
              }
            }}
            variant="outline"
            aria-label={bonesActive ? "Hide bones" : "Show bones"}
            title="Toggle bones overlay"
          >
            <Bone />
          </Toggle>
        </div>
      </div>
    </div>
  );
}
