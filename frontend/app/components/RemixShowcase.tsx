import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CompareLayer } from "~/components/SpinePreview";
import { type SpineClock, SpineRuntime, type SpineRuntimeStatus } from "~/components/SpineRuntime";
import { defaultAnimation } from "~/lib/animation";
import { assetPath } from "~/lib/seo";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

/** How long the divider takes to cross the stage, and how long it rests at each end. */
const SLIDE_MS = 3200;
const HOLD_REMIX_MS = 1600;
const HOLD_ORIGINAL_MS = 700;
/** After the visitor drags the divider, autoplay waits this long before picking up again. */
const RESUME_MS = 2500;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface RemixShowcaseProps {
  /** The original rig. Its runtime leads the shared clock, so it keeps playing while remixes swap in. */
  original: SpineAsset;
  /** Remixes of `original`, shown one after another. */
  remixes: SpineAsset[];
  className?: string;
}

/**
 * Before/after showcase: starts on the original, slides left to reveal a remix, slides back, then
 * swaps in the next remix while the original covers the stage, so the reload is never seen.
 */
export function RemixShowcase({ original, remixes, className }: RemixShowcaseProps) {
  const [cycle, setCycle] = useState(0);
  const [split, setSplit] = useState(100);
  const [originalStatus, setOriginalStatus] = useState<SpineRuntimeStatus>("idle");
  const [remixStatus, setRemixStatus] = useState<SpineRuntimeStatus>("idle");
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const clock = useRef<SpineClock>({ trackTime: 0, reverse: false, at: 0 });
  const splitRef = useRef(split);
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const remix = remixes[cycle % remixes.length];
  const animation = defaultAnimation(original.animations)?.name ?? "idle";
  const ready = originalStatus === "ready" && remixStatus === "ready";

  useEffect(() => {
    splitRef.current = split;
  });

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReducedMotion(query.matches);
      // Without autoplay, start halfway so both sides show.
      if (query.matches) setSplit(50);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => () => clearTimeout(resumeTimer.current), []);

  const next = () => {
    // A single remix keeps its player; otherwise the next one loads behind the original.
    if (remixes.length > 1) setRemixStatus("idle");
    setCycle((c) => c + 1);
  };

  // One pass: slide to the remix, rest, slide back to the original, rest, then the next remix.
  useEffect(() => {
    if (!ready || dragging || reducedMotion) return;
    const from = splitRef.current;
    const toRemix = (from / 100) * SLIDE_MS;
    const t1 = toRemix + HOLD_REMIX_MS;
    const t2 = t1 + SLIDE_MS;
    const t3 = t2 + HOLD_ORIGINAL_MS;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = now - start;
      if (t < toRemix) setSplit(from * (1 - ease(t / toRemix)));
      else if (t < t1) setSplit(0);
      else if (t < t2) setSplit(100 * ease((t - t1) / SLIDE_MS));
      else if (t < t3) setSplit(100);
      else return next();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // `cycle` restarts the pass for a single remix, whose status never leaves "ready".
  }, [ready, dragging, reducedMotion, cycle]);

  // Skip a remix whose files won't load.
  useEffect(() => {
    if (remixStatus === "error" && remixes.length > 1) next();
  }, [remixStatus]);

  const onSplitChange = (value: number) => {
    setSplit(value);
    setDragging(true);
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setDragging(false), RESUME_MS);
  };

  const runtime = { animation, loop: true, playing: true, speed: 1, showBones: false } as const;

  return (
    <figure className={cn("flex flex-col overflow-hidden rounded-xl border bg-card", className)}>
      <div
        role="img"
        aria-label={`${original.name} before and after: ${remix.name}`}
        className={cn(
          "relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40",
          "bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-size-[16px_16px]",
        )}
      >
        {remix.files && (
          <SpineRuntime
            key={remix.id}
            files={remix.files}
            tint={remix.tint}
            {...runtime}
            sync={{ clock: clock.current, lead: false }}
            onStatusChange={setRemixStatus}
          />
        )}
        {original.files && (
          <CompareLayer
            ready={originalStatus === "ready"}
            split={split}
            onSplitChange={onSplitChange}
            remixLabel={remix.name}
            original={
              <SpineRuntime
                files={original.files}
                tint={original.tint}
                {...runtime}
                sync={{ clock: clock.current, lead: true }}
                onStatusChange={setOriginalStatus}
              />
            }
          />
        )}
        {originalStatus !== "ready" && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 text-sm">
        <Link to={assetPath(remix)} className="font-medium underline-offset-4 hover:underline">
          {remix.name}
        </Link>
        {remix.prompt && <span className="line-clamp-1 min-w-0 flex-1 text-muted-foreground">“{remix.prompt}”</span>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {(cycle % remixes.length) + 1} / {remixes.length}
        </span>
      </figcaption>
    </figure>
  );
}
