import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CompareDivider, STAGE_GRID } from "~/components/SpinePreview";
import { type SpineClock, SpineRuntime, type SpineRuntimeStatus } from "~/components/SpineRuntime";
import { defaultAnimation } from "~/lib/animation";
import { assetPath } from "~/lib/seo";
import type { SpineAnimation, SpineAsset } from "~/lib/types";
import { cn } from "~/lib/utils";

/** How long the divider takes to cross the stage, and how long each look rests before the next wipe. */
const SLIDE_MS = 2800;
const HOLD_MS = 1800;
/** With reduced motion there's no wipe; each look is shown this long, then cut to the next. */
const REDUCED_MOTION_HOLD_MS = 4000;
/** After the visitor drags the divider, autoplay waits this long before picking up again. */
const RESUME_MS = 2500;

/** Clips shorter than this are skipped when cycling; they're usually twitches or poses. */
const MIN_CYCLE_SEC = 1;
/** Each clip loops 4–6 times before the next: as many as it takes to fill this long. */
const CLIP_PLAY_SEC = 6;
/** Death clips play once; looping them would have the character die over and over. */
const DEATH_CLIP = /dead|death|die/i;
const loopsOf = (clip: SpineAnimation) =>
  DEATH_CLIP.test(clip.name) ? 1 : Math.min(6, Math.max(4, Math.ceil(CLIP_PLAY_SEC / clip.durationSec)));

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The clips a look cycles through: every clip of 1s or more that the rig's original also has, so
 * clips added to a remix (a victory dance) are left out, minus the rig's hidden ones. Else the
 * default one.
 */
function cycleClips({ asset, rig }: ShowcaseItem): SpineAnimation[] {
  const stock = new Set(rig.original.animations.map((a) => a.name));
  const long = asset.animations.filter((a) => a.durationSec >= MIN_CYCLE_SEC && stock.has(a.name) && !rig.hiddenClips?.includes(a.name));
  if (long.length) return long;
  const fallback = defaultAnimation(asset.animations);
  return fallback ? [fallback] : [];
}

/**
 * What a layer's player loads for a look. A remix on its rig's own skeleton keeps the original's
 * atlas regions, so the layer keeps the original's player and swaps in the remix's texture pages:
 * starting a new player stalls the page for a moment, which shows as a hitch in the look on show
 * just as the divider reaches the edge. Remixes with an edited skeleton get a player of their own.
 */
function playerOf({ asset, rig }: ShowcaseItem) {
  const original = rig.original.files;
  const files = asset.files;
  if (!files || !original || asset === rig.original || files.skeletonUrl !== original.skeletonUrl || files.textureUrls.length !== original.textureUrls.length) {
    return { key: asset.id, files };
  }
  const pageUrls = Object.fromEntries(original.textureUrls.map((url, i) => [url.slice(url.lastIndexOf("/") + 1), files.textureUrls[i]]));
  return { key: rig.original.id, files: original, pageUrls };
}

/** The parts of an asset the showcase plays and captions. */
export type ShowcaseAsset = Pick<SpineAsset, "id" | "name" | "prompt" | "animations" | "files" | "tint">;

export interface ShowcaseRig {
  original: ShowcaseAsset;
  /** Remixes of `original`, shown one after another. */
  remixes: ShowcaseAsset[];
  /** Clips left out of the cycle on every look of this rig. */
  hiddenClips?: string[];
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
  // Both layers play the same clip number, so remixes of one rig stay in step through the cycle.
  const [cycle, setCycle] = useState(0);
  const clipOf = (item: ShowcaseItem) => {
    const clips = cycleClips(item);
    return clips.length ? clips[cycle % clips.length] : undefined;
  };
  const currentClip = clipOf(current);
  const cycles = cycleClips(current).length > 1;

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

  // Move on to the next clip once the look on show has looped this one enough. The clock still
  // holds the old clip's time until the leader ticks after the switch, so only fresher times count.
  const clipSec = currentClip?.durationSec ?? 0;
  const clipLoops = currentClip ? loopsOf(currentClip) : 1;
  const currentReady = statuses[current.asset.id] === "ready";
  useEffect(() => {
    if (!cycles || !currentReady || clipSec <= 0) return;
    const since = performance.now();
    let frame = requestAnimationFrame(function tick() {
      const { trackTime, at } = clock.current;
      if (at > since && trackTime >= clipSec * clipLoops) return setCycle((c) => c + 1);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [cycles, currentReady, clipSec, clipLoops, cycle, order.current]);

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
        {layers.map((item, layer) => {
          const player = playerOf(item);
          return (
            <div
              key={layer}
              className={cn("absolute inset-0 bg-card", layer === 0 ? "z-10" : "z-0")}
              style={layer === 0 ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined}
            >
              {/* The grid again, so the layer underneath doesn't show through transparent pixels. */}
              <div className={cn("absolute inset-0", STAGE_GRID)}>
                {player.files && (
                  <SpineRuntime
                    key={player.key}
                    files={player.files}
                    pageUrls={player.pageUrls}
                    animation={clipOf(item)?.name ?? "idle"}
                    // A clip played once holds its last frame until the next one, instead of restarting.
                    loop={cycleClips(item).length <= 1 || loopsOf(clipOf(item)!) > 1}
                    playing
                    speed={1}
                    showBones={false}
                    tint={item.asset.tint}
                    // The look on show keeps time; a queued remix of the same rig joins it in step. A
                    // queued look from another rig plays on its own, or it would jump each time the
                    // leader moves to its next clip (the single-clip windmill after the warrior).
                    sync={layer === shown ? { clock: clock.current, lead: true } : item.rig === current.rig ? { clock: clock.current, lead: false } : undefined}
                    onStatusChange={(status) => setStatuses((s) => (s[item.asset.id] === status ? s : { ...s, [item.asset.id]: status }))}
                  />
                )}
              </div>
            </div>
          );
        })}
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
