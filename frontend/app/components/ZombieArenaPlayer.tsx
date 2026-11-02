import {
  ArrowRight,
  ChevronsLeftRight,
  Pause,
  Play,
  Skull,
  Sparkles,
  Swords,
  Wand2,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { SpineRuntime } from "~/components/SpineRuntime";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Slider } from "~/components/ui/slider";
import { ZOMBIE_ARENA_CHARACTERS } from "~/lib/showcase-models";
import { cn } from "~/lib/utils";

interface CharacterSimState {
  x: number; // percentage (0 - 100)
  y: number; // percentage (0 - 100)
  vx: number;
  vy: number;
  facing: 1 | -1;
  isZombie: boolean;
  attackingUntil?: number; // timestamp in seconds
  targetCharId?: string | null;
  clashCooldownUntil?: number; // timestamp in seconds
}

export function ZombieArenaPlayer() {
  // Position of the repaint line, 0–100% of the arena width: rigs left of it wear their remix.
  // 0 shows every original, 100 every remix.
  const [sliderVal, setSliderVal] = useState(50);
  const [isPlaying, setIsPlaying] = useState(true);
  const [activeClip, setActiveClip] = useState<"walk" | "attack" | "idle">("walk");
  const [enableClash, setEnableClash] = useState(true);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [isAutoSweep, setIsAutoSweep] = useState(false);

  // Positions and velocities of each character
  const simStatesRef = useRef<Record<string, CharacterSimState>>({});
  const [, setTick] = useState(0);

  // Initialize simulation positions
  if (Object.keys(simStatesRef.current).length === 0) {
    for (const c of ZOMBIE_ARENA_CHARACTERS) {
      simStatesRef.current[c.id] = {
        x: c.initialX,
        y: c.initialY,
        vx: c.vx,
        vy: c.vy,
        facing: c.vx >= 0 ? 1 : -1,
        isZombie: c.initialX < 50,
      };
    }
  }

  // Animation frame loop for continuous walking & collisions
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const dt = Math.min((currentTime - lastTime) / 1000, 0.1);
      lastTime = currentTime;
      const currentTimeSec = currentTime / 1000;

      if (isPlaying) {
        const states = simStatesRef.current;

        // 1. Process active duel completions
        for (const c of ZOMBIE_ARENA_CHARACTERS) {
          const s = states[c.id];
          if (!s) continue;

          if (s.attackingUntil && currentTimeSec >= s.attackingUntil) {
            // End clash: push characters apart so they walk away in opposite directions
            const opponentId = s.targetCharId;
            const opp = opponentId ? states[opponentId] : null;
            if (opp) {
              if (s.x <= opp.x) {
                s.vx = -Math.abs(s.vx);
                s.facing = -1;
              } else {
                s.vx = Math.abs(s.vx);
                s.facing = 1;
              }
            } else {
              s.vx = -s.vx;
              s.facing = s.vx >= 0 ? 1 : -1;
            }
            s.attackingUntil = undefined;
            s.targetCharId = null;
            s.clashCooldownUntil = currentTimeSec + 3.0; // 3-second grace period
          }
        }

        // 2. Collision detection: walkers that bump into each other stop and duel
        if (activeClip === "walk" && enableClash) {
          const activeList = ZOMBIE_ARENA_CHARACTERS;

          for (let i = 0; i < activeList.length; i++) {
            const c1 = activeList[i];
            const s1 = states[c1.id];
            if (!s1) continue;
            const s1Busy = Boolean(s1.attackingUntil && currentTimeSec < s1.attackingUntil);
            const s1Cool = Boolean(s1.clashCooldownUntil && currentTimeSec < s1.clashCooldownUntil);
            if (s1Busy || s1Cool) continue;

            for (let j = i + 1; j < activeList.length; j++) {
              const c2 = activeList[j];
              const s2 = states[c2.id];
              if (!s2) continue;
              const s2Busy = Boolean(s2.attackingUntil && currentTimeSec < s2.attackingUntil);
              const s2Cool = Boolean(s2.clashCooldownUntil && currentTimeSec < s2.clashCooldownUntil);
              if (s2Busy || s2Cool) continue;

              const dx = Math.abs(s1.x - s2.x);
              const dy = Math.abs(s1.y - s2.y);

              // If characters bump horizontally and are on a similar depth plane
              if (dx <= 6.0 && dy <= 7.0) {
                const clashDuration = 2.4 + Math.random() * 0.6; // 2.4 - 3.0 seconds

                s1.attackingUntil = currentTimeSec + clashDuration;
                s2.attackingUntil = currentTimeSec + clashDuration;
                s1.targetCharId = c2.id;
                s2.targetCharId = c1.id;
                s1.clashCooldownUntil = currentTimeSec + clashDuration + 3.5;
                s2.clashCooldownUntil = currentTimeSec + clashDuration + 3.5;

                // Turn to face each other during combat!
                s1.facing = s2.x >= s1.x ? 1 : -1;
                s2.facing = s1.x >= s2.x ? 1 : -1;

                break; // c1 is now engaged
              }
            }
          }
        }

        // The sweep moves the repaint line back and forth on its own
        const lineVal = isAutoSweep ? Math.round(50 + 42 * Math.sin(currentTimeSec * 0.85)) : sliderVal;
        if (lineVal !== sliderVal) setSliderVal(lineVal);

        // 3. Movement and boundary collision
        for (const c of ZOMBIE_ARENA_CHARACTERS) {
          const s = states[c.id];
          if (!s) continue;

          const isDuelling = Boolean(s.attackingUntil && currentTimeSec < s.attackingUntil);

          let nextX = s.x;
          let nextY = s.y;
          let nextVx = s.vx;
          let nextVy = s.vy;
          let nextFacing = s.facing;

          if (activeClip === "walk" && !isDuelling) {
            nextX = s.x + s.vx * dt;
            nextY = s.y + s.vy * dt;

            // Airborne units (whelp, dragon) can fly closer to edges; ground units stay on the floor
            const isFlying = c.id === "char-whelp" || c.id === "char-dragon-frost";
            const minX = 4;
            const maxX = 92;
            const minY = isFlying ? 4 : 16;
            const maxY = isFlying ? 32 : 78;

            // Bounce horizontally
            if (nextX > maxX) {
              nextX = maxX;
              nextVx = -Math.abs(nextVx);
              nextFacing = -1;
            } else if (nextX < minX) {
              nextX = minX;
              nextVx = Math.abs(nextVx);
              nextFacing = 1;
            }

            // Bounce vertically
            if (nextY > maxY) {
              nextY = maxY;
              nextVy = -Math.abs(nextVy);
            } else if (nextY < minY) {
              nextY = minY;
              nextVy = Math.abs(nextVy);
            }
          } else if (isDuelling && s.targetCharId && states[s.targetCharId]) {
            // Keep facing opponent while fighting
            nextFacing = states[s.targetCharId].x >= s.x ? 1 : -1;
          }

          // Rigs left of the repaint line wear their remix
          const nextZombie = nextX < lineVal;

          states[c.id] = {
            ...s,
            x: nextX,
            y: nextY,
            vx: nextVx,
            vy: nextVy,
            facing: nextFacing,
            isZombie: nextZombie,
          };
        }

        // Trigger component re-render for coordinate updates
        setTick((t) => (t + 1) % 1000000);
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, activeClip, sliderVal, enableClash, isAutoSweep]);

  const handleSliderChange = (vals: number[]) => {
    setIsAutoSweep(false);
    const val = vals[0] ?? 50;
    setSliderVal(val);

    // Update zombie state immediately
    const states = simStatesRef.current;
    for (const c of ZOMBIE_ARENA_CHARACTERS) {
      const s = states[c.id];
      if (!s) continue;
      s.isZombie = s.x < val;
    }
  };

  const selectedChar = ZOMBIE_ARENA_CHARACTERS.find((c) => c.id === selectedCharId);
  const selectedState = selectedChar ? simStatesRef.current[selectedChar.id] : null;

  const remixedCount = ZOMBIE_ARENA_CHARACTERS.filter((c) => simStatesRef.current[c.id]?.isZombie).length;
  const totalCount = ZOMBIE_ARENA_CHARACTERS.length;

  const jumpTo = (val: number) => {
    setIsAutoSweep(false);
    handleSliderChange([val]);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Main Arena Container */}
      <div className="relative flex flex-col overflow-hidden rounded-2xl border bg-stone-950 text-stone-100 shadow-2xl">
        {/* Arena toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 bg-stone-900/90 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center rounded-lg border border-stone-800 bg-stone-950 p-0.5">
            <Button
              variant={sliderVal === 0 && !isAutoSweep ? "secondary" : "ghost"}
              size="sm"
              onClick={() => jumpTo(0)}
              className="h-7 px-2.5 text-xs text-stone-300"
            >
              Original packs
            </Button>
            <Button
              variant={isAutoSweep ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setIsAutoSweep(!isAutoSweep)}
              className="h-7 gap-1 px-2.5 text-xs text-stone-300"
            >
              <Zap className={cn("size-3 text-emerald-400", isAutoSweep && "animate-pulse")} /> Sweep
            </Button>
            <Button
              variant={sliderVal === 100 && !isAutoSweep ? "secondary" : "ghost"}
              size="sm"
              onClick={() => jumpTo(100)}
              className="h-7 px-2.5 text-xs text-stone-300"
            >
              One art direction
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-lg border border-stone-800 bg-stone-950 p-0.5">
              {(["walk", "attack", "idle"] as const).map((clip) => (
                <Button
                  key={clip}
                  variant={activeClip === clip ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveClip(clip)}
                  className="h-7 px-2.5 text-xs capitalize text-stone-300"
                >
                  {clip}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEnableClash(!enableClash)}
              className={cn(
                "h-7 gap-1.5 border-stone-800 bg-stone-950 px-2.5 text-xs",
                enableClash ? "text-amber-300 hover:text-amber-200" : "text-stone-400 hover:text-stone-200",
              )}
              title="Characters that bump into each other stop and play their attack animation"
            >
              <Swords className="size-3" /> Duels {enableClash ? "on" : "off"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7 border-stone-800 bg-stone-950 text-stone-300 hover:text-white"
              onClick={() => setIsPlaying(!isPlaying)}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
          </div>
        </div>
        {/* Interactive Walking Battlefield Stage */}
        <div
          className="relative h-[620px] w-full select-none overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-stone-900 via-stone-950 to-black sm:h-[720px]"
          style={{
            backgroundImage: `
              radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.05), transparent 70%),
              linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)
            `,
            backgroundSize: "100% 100%, 32px 32px, 32px 32px",
          }}
        >
          {/* Subtle Ground Shadows & Isometric Floor Lines */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-stone-950/80 via-transparent to-stone-950/40" />

          {/* Corner labels: remixed on the left of the line, originals on the right */}
          <div
            className="pointer-events-none absolute top-4 left-4 z-10 flex flex-col gap-0.5 rounded-md border border-emerald-500/20 bg-stone-950/70 px-2.5 py-2 backdrop-blur transition-opacity duration-300"
            style={{ opacity: sliderVal > 12 ? 0.95 : 0 }}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
              <span className="size-2 rounded-full bg-emerald-400" />
              Remixed with Muse
            </div>
            <div className="text-[11px] text-stone-400">One art direction</div>
          </div>
          <div
            className="pointer-events-none absolute top-4 right-4 z-10 flex flex-col gap-0.5 rounded-md border border-sky-500/20 bg-stone-950/70 px-2.5 py-2 text-right backdrop-blur transition-opacity duration-300"
            style={{ opacity: sliderVal < 88 ? 0.95 : 0 }}
          >
            <div className="flex items-center justify-end gap-1.5 text-xs font-semibold text-sky-400">
              Original asset packs
              <span className="size-2 rounded-full bg-sky-400" />
            </div>
            <div className="text-[11px] text-stone-400">Different artists, palettes, line weights</div>
          </div>
          {/* Vertical Scanner Line / Energy Rift Divider */}
          {(
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 flex w-px -translate-x-1/2 flex-col items-center"
              style={{ left: `${sliderVal}%` }}
            >
              {/* Glowing vertical line */}
              <div
                className={cn(
                  "h-full bg-gradient-to-b from-sky-400 via-emerald-400 to-emerald-500 transition-all duration-300",
                  isAutoSweep
                    ? "w-[3px] shadow-[0_0_24px_rgba(52,211,153,1)]"
                    : "w-[2px] shadow-[0_0_15px_rgba(52,211,153,0.8)]"
                )}
              />

              {/* Top Handle Pill */}
              <div
                className={cn(
                  "absolute top-2 flex items-center gap-1.5 whitespace-nowrap rounded-full border bg-stone-950 px-2.5 py-0.5 text-[10px] font-mono font-medium shadow-lg transition-colors",
                  isAutoSweep
                    ? "border-emerald-400 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                    : "border-emerald-500/50 text-emerald-300"
                )}
              >
                <ChevronsLeftRight className={cn("size-3 text-emerald-400", isAutoSweep && "animate-pulse")} />
                <span>REMIX ◂ ▸ ORIGINAL</span>
              </div>

              {/* Bottom Particle Emitter Dot */}
              <div
                className={cn(
                  "absolute bottom-2 size-3 rounded-full border-2 border-emerald-400 bg-stone-950 shadow-[0_0_10px_#10b981]",
                  isAutoSweep && "animate-ping"
                )}
              />
            </div>
          )}

          {/* Walking & Flying Characters in the Arena */}
          {ZOMBIE_ARENA_CHARACTERS.map((char) => {
            const st = simStatesRef.current[char.id] ?? {
              x: char.initialX,
              y: char.initialY,
              facing: 1,
              isZombie: false,
            };

            const isSelected = selectedCharId === char.id;
            const currentTimeSec = performance.now() / 1000;
            const isClashing = Boolean(st.attackingUntil && currentTimeSec < st.attackingUntil);

            // Pick appropriate animation based on active action toggle or active clash duel
            let animName = char.animation;
            if (isClashing || activeClip === "attack") {
              animName = char.attackAnim ?? "Attack";
            } else if (activeClip === "idle") {
              animName = char.idleAnim ?? "Idle";
            }

            // Texture swapping: pass the corresponding texture URL to pageUrls
            const pageUrls = {
              [char.pageName]: st.isZombie ? char.zombieTextureUrl : char.baseTextureUrl,
            };

            const isFlying = char.id === "char-whelp" || char.id === "char-dragon-frost";

            return (
              <div
                key={char.id}
                onClick={() => setSelectedCharId(isSelected ? null : char.id)}
                className="group absolute cursor-pointer transition-transform duration-75"
                style={{
                  left: `${st.x}%`,
                  top: `${st.y}%`,
                  zIndex: Math.floor(st.y * 10) + char.depthOffset,
                  transform: "translate(-50%, -70%)",
                }}
              >
                {/* Name tag, shown on hover or when selected */}
                <div
                  className={cn(
                    "pointer-events-none mb-1 flex items-center justify-center transition-opacity",
                    isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-medium tracking-tight backdrop-blur-[2px] border transition-colors",
                      st.isZombie
                        ? "border-emerald-500/30 bg-emerald-950/40 text-emerald-200"
                        : "border-sky-500/25 bg-stone-950/40 text-stone-300",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1 rounded-full",
                        st.isZombie ? "bg-emerald-400" : "bg-sky-400/80",
                      )}
                    />
                    <span>{st.isZombie ? char.zombieName : char.baseName}</span>
                    <span
                      className={cn(
                        "text-[8px] font-mono",
                        st.isZombie ? "text-emerald-400 font-semibold" : "text-stone-400 opacity-60"
                      )}
                    >
                      • {st.isZombie ? "Comic Ghoul" : char.baseStyle.split(" ")[0]}
                    </span>
                  </div>
                </div>

                {/* Ground Shadow & Selection Reticle */}
                <div className="relative">
                  <div
                    className={cn(
                      "absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full blur-xs transition-all",
                      isFlying ? "h-3 w-28 opacity-30" : "h-5 w-36",
                      st.isZombie ? "bg-emerald-500/20" : "bg-black/50",
                      isSelected && "ring-2 ring-emerald-400 ring-offset-2 ring-offset-stone-950",
                    )}
                  />

                  {/* Character Spine Runtime Player with Directional Flip (50% bigger size-72 / 288px) */}
                  <div
                    className="size-72 transition-transform duration-200"
                    style={{
                      transform: `scaleX(${(char.invertFacing ? -1 : 1) * st.facing}) scale(${char.scale})`,
                    }}
                  >
                    <SpineRuntime
                      files={char.files}
                      animation={animName}
                      loop
                      playing={isPlaying}
                      speed={1}
                      showBones={false}
                      tint={null}
                      pageUrls={pageUrls}
                      className="size-full"
                      lockViewport
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Repaint slider */}
        <div className="flex flex-col gap-3 border-t border-stone-800 bg-stone-900/95 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
            <span className="font-medium text-sky-400">Original packs</span>
            <span className="font-mono text-[11px] text-stone-400 tabular-nums">
              {remixedCount} of {totalCount} rigs repainted
            </span>
            <span className="font-medium text-emerald-400">One art direction</span>
          </div>
          <div className="px-1">
            <Slider
              value={[sliderVal]}
              onValueChange={handleSliderChange}
              min={0}
              max={100}
              step={1}
              className="cursor-grab py-1 active:cursor-grabbing"
              aria-label="Move the repaint line across the arena"
            />
          </div>
          <p className="text-center text-xs text-stone-400">
            The line swaps each rig's texture atlas between its original and its Muse remix. Skeleton, meshes and
            animations are the same files on both sides, so walk, attack and idle keep playing mid-swap.
          </p>
        </div>
      </div>

      {/* Selected Character Deep-Dive Card */}
      {selectedChar && selectedState && (
        <Card className="border-emerald-500/30 bg-emerald-950/10 transition-all duration-300">
          <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
            {/* Before vs After Textures */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  Inspected Rig
                </span>
                <Badge
                  variant={selectedState.isZombie ? "default" : "secondary"}
                  className="gap-1 text-xs"
                >
                  {selectedState.isZombie ? (
                    <>
                      <Skull className="size-3" /> Remixed Ghoul
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-3" /> Original Look
                    </>
                  )}
                </Badge>
              </div>
              <h4 className="text-lg font-bold text-foreground">
                {selectedState.isZombie ? selectedChar.zombieName : selectedChar.baseName}
              </h4>
              <p className="text-xs text-muted-foreground">
                Current State:{" "}
                <span className="font-medium text-foreground">
                  {selectedState.isZombie ? selectedChar.zombieStyle : selectedChar.baseStyle}
                </span>
              </p>
            </div>

            {/* AI Prompt Used */}
            <div className="flex flex-col justify-center gap-1 sm:col-span-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Wand2 className="size-3.5" />
                Prompt Fed into Meta Muse Image:
              </div>
              <blockquote className="rounded-md border bg-muted/60 p-2.5 text-xs text-muted-foreground italic">
                &ldquo;{selectedChar.zombiePrompt}&rdquo;
              </blockquote>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Atlas region coordinates & keyframes: <strong className="text-foreground">100% Preserved</strong>
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" asChild className="gap-1 text-xs">
                    <Link to={`/assets/${selectedChar.baseAssetId}`}>
                      View Base Rig <ArrowRight className="size-3" />
                    </Link>
                  </Button>
                  <Button size="sm" asChild className="gap-1 text-xs">
                    <Link to={`/remix?asset=${selectedChar.remixAssetId}`}>
                      Remix Studio <ArrowRight className="size-3" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
