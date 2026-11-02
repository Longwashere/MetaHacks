import {
  ArrowLeft,
  ArrowRight,
  Bone,
  ChevronsLeftRight,
  Layers,
  LayoutGrid,
  Maximize2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { CompareDivider, STAGE_GRID } from "~/components/SpinePreview";
import { type SpineClock, SpineRuntime } from "~/components/SpineRuntime";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type ShowcaseModel, SHOWCASE_SLIDESHOW_MODELS } from "~/lib/showcase-models";
import { cn } from "~/lib/utils";

interface SingleModelSlideshowProps {
  model: ShowcaseModel;
  className?: string;
}

export function SingleModelSlideshow({ model, className }: SingleModelSlideshowProps) {
  // Open on the first remix with the wipe half way, so the before/after is visible without a click.
  const [currentSlideIndex, setCurrentSlideIndex] = useState(model.slides.length > 1 ? 1 : 0);
  const [selectedAnimation, setSelectedAnimation] = useState(model.defaultAnimation);
  const [compareSplit, setCompareSplit] = useState(50); // % of the stage showing the original, from the left
  const [isPlaying, setIsPlaying] = useState(true);
  const clock = useRef<SpineClock>({ trackTime: 0, reverse: false, at: 0 });

  const slide = model.slides[currentSlideIndex] ?? model.slides[0];
  const originalSlide = model.slides[0];

  const goTo = (index: number) => {
    setCompareSplit(50);
    setCurrentSlideIndex((index + model.slides.length) % model.slides.length);
  };
  const handlePrev = () => goTo(currentSlideIndex - 1);
  const handleNext = () => goTo(currentSlideIndex + 1);

  // Build pageUrls for the compare slider
  const pageUrls = slide.isOriginal
    ? undefined
    : {
        // The atlas page filename is the last part of textureUrl
        [originalSlide.textureUrl.slice(originalSlide.textureUrl.lastIndexOf("/") + 1)]: slide.textureUrl,
      };

  return (
    <Card className={cn("overflow-hidden border bg-card shadow-md", className)}>
      <div className="grid lg:grid-cols-12">
        {/* Left Side: Spine 2D Canvas Player with Interactive Compare Wipe */}
        <div className="relative aspect-square select-none bg-muted/30 lg:col-span-7">
          <div className={cn("relative size-full select-none overflow-hidden", STAGE_GRID)}>
            {/* Base Layer: Current Remixed Look */}
            <div className="size-full select-none">
              <SpineRuntime
                files={originalSlide.files}
                animation={selectedAnimation}
                loop
                playing={isPlaying}
                speed={1}
                showBones={false}
                tint={null}
                pageUrls={pageUrls}
                sync={!slide.isOriginal ? { clock: clock.current, lead: true } : undefined}
                className="size-full"
              />
            </div>

            {/* Compare Wipe Layer: Shows Original on the left of divider */}
            {!slide.isOriginal && (
              <div
                className="pointer-events-none absolute inset-0 select-none overflow-hidden bg-card"
                style={{ clipPath: `inset(0 ${100 - compareSplit}% 0 0)` }}
              >
                <div className={cn("absolute inset-0 select-none", STAGE_GRID)}>
                  <SpineRuntime
                    files={originalSlide.files}
                    animation={selectedAnimation}
                    loop
                    playing={isPlaying}
                    speed={1}
                    showBones={false}
                    tint={null}
                    sync={{ clock: clock.current, lead: false }}
                    className="size-full"
                  />
                </div>
              </div>
            )}

            {/* Draggable Divider Line */}
            {!slide.isOriginal && (
              <CompareDivider
                split={compareSplit}
                onSplitChange={setCompareSplit}
                leftLabel="Original"
                rightLabel={slide.name}
                labelClassName="bottom-14"
              />
            )}

            {/* Top Overlay Badges */}
            <div className="pointer-events-none absolute top-3 left-3 right-3 flex items-center justify-between">
              <Badge
                variant={slide.isOriginal ? "secondary" : "default"}
                className="gap-1 shadow-sm backdrop-blur"
              >
                {slide.isOriginal ? (
                  <>
                    <Bone className="size-3" /> Base Rig
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3" /> Remix {currentSlideIndex} of {model.slides.length - 1}
                  </>
                )}
              </Badge>

              <div className="flex items-center gap-1 rounded-md bg-background/80 px-2 py-0.5 text-[11px] font-mono text-muted-foreground backdrop-blur">
                Slide {currentSlideIndex + 1} / {model.slides.length}
              </div>
            </div>

            {/* Bottom Floating Navigation Arrows */}
            <div className="z-30 absolute bottom-3 left-3 right-3 flex items-center justify-between">
              <Button
                variant="secondary"
                size="icon"
                className="size-8 rounded-full bg-background/90 shadow-md backdrop-blur hover:bg-background pointer-events-auto"
                onClick={handlePrev}
                aria-label="Previous slide"
              >
                <ArrowLeft className="size-4" />
              </Button>

              {/* Dot Indicators */}
              <div className="flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 backdrop-blur">
                {model.slides.map((s, idx) => (
                  <button
                    key={s.id}
                    onClick={() => goTo(idx)}
                    className={cn(
                      "size-2 rounded-full transition-all",
                      idx === currentSlideIndex
                        ? "w-5 bg-primary"
                        : "bg-muted-foreground/30 hover:bg-muted-foreground/60",
                    )}
                    aria-label={`Jump to slide ${idx + 1}: ${s.name}`}
                  />
                ))}
              </div>

              <Button
                variant="secondary"
                size="icon"
                className="size-8 rounded-full bg-background/90 shadow-md backdrop-blur hover:bg-background pointer-events-auto"
                onClick={handleNext}
                aria-label="Next slide"
              >
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Right Side: Slide Details, AI Prompt & Animation Controls */}
        <div className="flex flex-col justify-between border-t p-5 sm:p-6 lg:col-span-5 lg:border-t-0 lg:border-l">
          <div className="flex flex-col gap-4">
            {/* Header info */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {model.category} • {model.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({model.boneCount} bones)
                </span>
              </div>
              <h3 className="text-xl font-bold text-foreground sm:text-2xl">
                {slide.name}
              </h3>
              <p className="text-xs text-muted-foreground">{slide.subtitle}</p>
            </div>

            {/* Tags */}
            {slide.tags && (
              <div className="flex flex-wrap gap-1.5">
                {slide.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {/* AI Prompt Box */}
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Wand2 className="size-3.5 text-primary" />
                {slide.isOriginal ? "The source rig" : "The whole prompt"}
              </span>
              <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                {slide.prompt ?? (
                  <span className="italic">
                    Base Spine 2D rig. Original hand-authored textures, skeleton, and slots.
                  </span>
                )}
              </div>
            </div>

            {/* Animation Selector */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Same skeleton, every animation:
              </span>
              <div className="flex flex-wrap gap-1">
                {model.animations.map((anim) => (
                  <Button
                    key={anim.name}
                    variant={selectedAnimation === anim.name ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSelectedAnimation(anim.name)}
                  >
                    {anim.name}
                    {anim.durationSec > 0 && <span className="opacity-60">{anim.durationSec}s</span>}
                  </Button>
                ))}
              </div>
              <span className="text-[11px] text-muted-foreground">
                These clips come from the original rig&apos;s skeleton file. The remix only ships new atlas pages.
              </span>
            </div>

            {/* Compare Hint if Remix */}
            {!slide.isOriginal && (
              <div className="flex items-center gap-2 rounded-md bg-primary/5 p-2 text-xs text-primary">
                <ChevronsLeftRight className="size-4 shrink-0" />
                <span>Drag the divider on the stage to wipe between the original and the remix.</span>
              </div>
            )}
          </div>

          {/* Bottom Actions */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCompareSplit(compareSplit === 0 ? 50 : 0)}
              disabled={slide.isOriginal}
              className="text-xs"
            >
              <Layers className="size-3.5 mr-1" />
              {compareSplit === 0 ? "Compare with original" : "Show full remix"}
            </Button>

            <Button size="sm" asChild className="gap-1.5 text-xs">
              <Link to={`/remix?rig=${model.id}`}>
                Remix in Studio <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function ModelSlideshowSection() {
  const [activeTab, setActiveTab] = useState(SHOWCASE_SLIDESHOW_MODELS[0].id);
  const [layoutMode, setLayoutMode] = useState<"focused" | "grid">("focused");

  const currentModel =
    SHOWCASE_SLIDESHOW_MODELS.find((m) => m.id === activeTab) ?? SHOWCASE_SLIDESHOW_MODELS[0];

  return (
    <div className="flex flex-col gap-8">
      {/* Section Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Badge variant="outline" className="mb-2 gap-1 text-xs">
            <Sparkles className="size-3 text-primary" /> Enemy variants &amp; seasonal skins
          </Badge>
          <h2 id="slideshows-heading" className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            One rig in, a whole cast out
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A rigged character is days of an animator&apos;s work. Each remix below reuses that work as is: the
            same skeleton and the same clips, with new atlas pages painted by Muse Image. Switch clips to check
            any frame, and drag the divider to compare.
          </p>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
          <Button
            variant={layoutMode === "focused" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setLayoutMode("focused")}
            className="h-7 text-xs"
          >
            <Maximize2 className="size-3.5 mr-1" /> One at a time
          </Button>
          <Button
            variant={layoutMode === "grid" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setLayoutMode("grid")}
            className="h-7 text-xs"
          >
            <LayoutGrid className="size-3.5 mr-1" /> All four
          </Button>
        </div>
      </div>

      {/* Focused Tabs View */}
      {layoutMode === "focused" ? (
        <div className="flex flex-col gap-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 md:grid-cols-4">
              {SHOWCASE_SLIDESHOW_MODELS.map((model, idx) => (
                <TabsTrigger key={model.id} value={model.id} className="text-xs sm:text-sm">
                  {idx + 1}. {model.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <SingleModelSlideshow model={currentModel} />
        </div>
      ) : (
        /* 2x2 Grid View of All 4 Slideshows */
        <div className="grid gap-6 md:grid-cols-2">
          {SHOWCASE_SLIDESHOW_MODELS.map((model) => (
            <SingleModelSlideshow key={model.id} model={model} />
          ))}
        </div>
      )}
    </div>
  );
}
