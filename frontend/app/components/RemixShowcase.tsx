import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CompareDivider, STAGE_GRID } from "~/components/SpinePreview";
import { type SpineClock, SpineRuntime, type SpineRuntimeStatus } from "~/components/SpineRuntime";
import { defaultAnimation } from "~/lib/animation";
import { assetPath } from "~/lib/seo";
import type { SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

/** How long the divider takes to cross the stage, and how long each look rests before the next wipe. */
const SLIDE_MS = 2800;
const HOLD_MS = 1800;
/** With reduced motion there's no wipe; each look is shown this long, then cut to the next. */
const REDUCED_MOTION_HOLD_MS = 4000;
/** After the visitor drags the divider, autoplay waits this long before picking up again. */
const RESUME_MS = 2500;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The parts of an asset the showcase plays and captions. */
export type ShowcaseAsset = Pick<SpineAsset, "id" | "name" | "prompt" | "animations" | "files" | "tint">;

export interface ShowcaseRig {
  original: ShowcaseAsset;
  /** Remixes of `original`, shown one after another. */
  remixes: ShowcaseAsset[];
}

interface ShowcaseItem {
  asset: ShowcaseAsset;
  rig: ShowcaseRig;
}

/**
 * Each rig plays as original, its remixes, then the original again before the next rig. With a
 * single rig the loop itself comes back to the original, so it isn't repeated.
 */
function sequence(rigs: ShowcaseRig[]): ShowcaseItem[] {
  return rigs.flatMap((rig) => {
    const looks = [rig.original, ...rig.remixes, ...(rigs.length > 1 ? [rig.original] : [])];
    return looks.map((asset) => ({ asset, rig }));
  });
}

interface RemixShowcaseProps {
  rigs: ShowcaseRig[];
  className?: string;
}

/**
 * The divider sweeps back and forth over two layers: the top one is clipped left of the divider,
 * the bottom one fills the stage. Each sweep reveals the layer holding the next look; the layer it
 * hides then loads the look after, out of sight.
 */
export function RemixShowcase({ rigs, className }: RemixShowcaseProps) {
  const items = sequence(rigs);
  // Indexes (wrapping) of the look on show and the one queued, and the layer showing (0 is the top one).
  const [order, setOrder] = useState({ current: 0, next: 1, shown: 0 });
  const [split, setSplit] = useState(100);
  const [statuses, setStatuses] = useState<Record<string, SpineRuntimeStatus>>({});
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const clock = useRef<SpineClock>({ trackTime: 0, reverse: false, at: 0 });
  const splitRef = useRef(split);
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const at = (k: number) => items[k % items.length];
  const current = at(order.current);
  const next = at(order.next);
  const { shown } = order;
  const layers = [0, 1].map((layer) => (layer === shown ? current : next));
  // Where the divider rests while each layer is showing: right edge for the top one, left for the bottom.
  const restAt = (layer: number) => (layer === 0 ? 100 : 0);
  const ready = statuses[current.asset.id] === "ready" && statuses[next.asset.id] === "ready";

  useEffect(() => {
    splitRef.current = split;
  });

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => () => clearTimeout(resumeTimer.current), []);

  /** Queues the look after `index` in place of `leaving`, unless it's the same asset. */
  const queueAfter = (index: number, leaving: ShowcaseAsset) => {
    const incoming = at(index + 1).asset.id;
    if (incoming !== leaving.id) setStatuses((s) => ({ ...s, [incoming]: "idle" }));
  };

  const advance = () => {
    queueAfter(order.next, current.asset);
    // The divider is already at the far edge after a sweep; this only matters for reduced motion's cut.
    setSplit(restAt(1 - shown));
    setOrder({ current: order.next, next: order.next + 1, shown: 1 - shown });
  };

  // Rest on the current look, then wipe to the next one.
  useEffect(() => {
    if (!ready || dragging) return;
    if (reducedMotion) {
      const timer = setTimeout(advance, REDUCED_MOTION_HOLD_MS);
      return () => clearTimeout(timer);
    }
    const from = splitRef.current;
    const to = restAt(1 - shown);
    // Picking up mid-sweep after a drag goes straight on.
    const hold = from === restAt(shown) ? HOLD_MS : 0;
    const sweep = (Math.abs(to - from) / 100) * SLIDE_MS;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = now - start - hold;
      if (t >= sweep) return advance();
      if (t > 0) setSplit(from + (to - from) * ease(t / sweep));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, dragging, reducedMotion, order]);

  // Skip a look whose files won't load, as long as something other than the current look is left.
  const nextFailed = statuses[next.asset.id] === "error";
  useEffect(() => {
    if (!nextFailed || at(order.next + 1).asset.id === current.asset.id) return;
    queueAfter(order.next, next.asset);
    setOrder((o) => ({ ...o, next: o.next + 1 }));
  }, [nextFailed]);

  const onSplitChange = (value: number) => {
    setSplit(value);
    setDragging(true);
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setDragging(false), RESUME_MS);
  };

  const label = (item: ShowcaseItem) => (item.asset.id === item.rig.original.id ? `Original ${item.asset.name.toLowerCase()}` : item.asset.name);
  const remixNumber = current.rig.remixes.indexOf(current.asset);

  return (
    <figure className={cn("flex flex-col overflow-hidden rounded-xl border bg-card", className)}>
      <div
        role="img"
        aria-label={`${label(current)}, then ${label(next)}`}
        className={cn("relative flex aspect-square items-center justify-center overflow-hidden", STAGE_GRID)}
      >
        {layers.map((item, layer) => (
          <div
            key={layer}
            className={cn("absolute inset-0 bg-card", layer === 0 ? "z-10" : "z-0")}
            style={layer === 0 ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
          >
            {/* The grid again, so the layer underneath doesn't show through transparent pixels. */}
            <div className={cn("absolute inset-0", STAGE_GRID)}>
              {item.asset.files && (
                <SpineRuntime
                  key={item.asset.id}
                  files={item.asset.files}
                  animation={defaultAnimation(item.asset.animations)?.name ?? "idle"}
                  loop
                  playing
                  speed={1}
                  showBones={false}
                  tint={item.asset.tint}
                  // The look on show keeps time; the queued one joins it in step.
                  sync={{ clock: clock.current, lead: layer === shown }}
                  onStatusChange={(status) => setStatuses((s) => (s[item.asset.id] === status ? s : { ...s, [item.asset.id]: status }))}
                />
              )}
            </div>
          </div>
        ))}
        {statuses[current.asset.id] === "ready" ? (
          <CompareDivider split={split} onSplitChange={onSplitChange} leftLabel={label(layers[0])} rightLabel={label(layers[1])} />
        ) : (
          <Loader2 className="z-20 size-5 animate-spin text-muted-foreground" aria-hidden />
        )}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 text-sm">
        <Link to={assetPath(current.asset)} className="font-medium underline-offset-4 hover:underline">
          {current.asset.name}
        </Link>
        {current.asset.prompt && <span className="line-clamp-1 min-w-0 flex-1 text-muted-foreground">“{current.asset.prompt}”</span>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {remixNumber >= 0 ? `Remix ${remixNumber + 1} / ${current.rig.remixes.length}` : "Original"}
        </span>
      </figcaption>
    </figure>
  );
}
