import {
  AlertTriangle,
  ArrowRight,
  ChevronsLeftRight,
  Flame,
  Info,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Skull,
  Sparkles,
  Swords,
  Wand2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { SpineRuntime } from "~/components/SpineRuntime";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Slider } from "~/components/ui/slider";
import {
  type ArenaCharacterConfig,
  ZOMBIE_ARENA_CHARACTERS,
} from "~/lib/showcase-models";
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

type SquadCategory = "all" | "humanoids" | "monsters" | "drakes";

const HUMANOIDS = new Set(["char-warrior", "char-troll", "char-barbarian", "char-warlord", "char-warrior04", "char-horseman"]);
const MONSTERS = new Set(["char-elemental", "char-golem-crag", "char-golem-magma", "char-lurker", "char-slime", "char-grub"]);
const DRAKES = new Set(["char-dragon-frost", "char-whelp"]);

export function ZombieArenaPlayer() {
  // Slider position from 0 (All Base Originals) to 100 (All Unified Zombie Remixes)
  const [sliderVal, setSliderVal] = useState(50);
  const [mode, setMode] = useState<"scanner" | "global">("scanner");
  const [squad, setSquad] = useState<SquadCategory>("all");
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
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
        isZombie: c.initialX >= 50,
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

        // 2. Collision detection between characters in the active squad (when activeClip === 'walk' and enableClash is true)
        if (activeClip === "walk" && enableClash) {
          const activeList = ZOMBIE_ARENA_CHARACTERS.filter((c) => {
            if (squad === "all") return true;
            if (squad === "humanoids") return HUMANOIDS.has(c.id);
            if (squad === "monsters") return MONSTERS.has(c.id);
            if (squad === "drakes") return DRAKES.has(c.id);
            return true;
          });

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
            nextX = s.x + s.vx * dt * speed;
            nextY = s.y + s.vy * dt * speed;

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

          // Determine current slider divider position (smooth sine sweep when isAutoSweep is active)
          let effectiveSliderVal = sliderVal;
          if (isAutoSweep && isPlaying) {
            effectiveSliderVal = Math.round(50 + 42 * Math.sin(currentTimeSec * 0.85));
            setSliderVal(effectiveSliderVal);
          }

          // Determine zombie state based on mode
          let nextZombie = s.isZombie;
          if (mode === "scanner") {
            // Characters right of the divider become zombie
            nextZombie = nextX >= effectiveSliderVal;
          } else {
            // Global slider threshold
            const index = ZOMBIE_ARENA_CHARACTERS.findIndex((item) => item.id === c.id);
            const threshold = (index / (ZOMBIE_ARENA_CHARACTERS.length - 1)) * 100;
            nextZombie = effectiveSliderVal > threshold;
          }

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
  }, [isPlaying, speed, activeClip, mode, sliderVal, squad, enableClash, isAutoSweep]);

  const handleSliderChange = (vals: number[]) => {
    setIsAutoSweep(false);
    const val = vals[0] ?? 50;
    setSliderVal(val);

    // Update zombie state immediately
    const states = simStatesRef.current;
    for (const c of ZOMBIE_ARENA_CHARACTERS) {
      const s = states[c.id];
      if (!s) continue;
      if (mode === "scanner") {
        s.isZombie = s.x >= val;
      } else {
        const index = ZOMBIE_ARENA_CHARACTERS.findIndex((item) => item.id === c.id);
        const threshold = (index / (ZOMBIE_ARENA_CHARACTERS.length - 1)) * 100;
        s.isZombie = val > threshold;
      }
    }
  };

  const filteredCharacters = ZOMBIE_ARENA_CHARACTERS.filter((c) => {
    if (squad === "all") return true;
    if (squad === "humanoids") return HUMANOIDS.has(c.id);
    if (squad === "monsters") return MONSTERS.has(c.id);
    if (squad === "drakes") return DRAKES.has(c.id);
    return true;
  });

  const selectedChar = ZOMBIE_ARENA_CHARACTERS.find((c) => c.id === selectedCharId);
  const selectedState = selectedChar ? simStatesRef.current[selectedChar.id] : null;

  // Calculate real-time visual cohesion metrics for judges and demos
  const zombieCount = filteredCharacters.filter(
    (c) => simStatesRef.current[c.id]?.isZombie
  ).length;
  const totalCount = filteredCharacters.length || 1;
  const cohesionPct = Math.round(14 + (zombieCount / totalCount) * 86);

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner / Explanation */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Skull className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-foreground">Interactive Style Harmonizer</h3>
              <Badge variant="outline" className="border-emerald-500/30 text-xs text-emerald-600 dark:text-emerald-400">
                14-Unit Live Arena
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              14 distinct rigs walking & flying across the battlefield. When two characters crash into each other, they stop and duel! Drag the slider or use Auto-Sweep to transform their textures into one unified art direction!
            </p>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="flex flex-wrap items-center gap-2 pt-2 md:pt-0">
          <Button
            size="sm"
            variant={sliderVal === 0 && !isAutoSweep ? "default" : "outline"}
            onClick={() => {
              setIsAutoSweep(false);
              handleSliderChange([0]);
            }}
            className="text-xs"
          >
            🎨 100% Diverse Base
          </Button>
          <Button
            size="sm"
            variant={isAutoSweep ? "default" : "outline"}
            onClick={() => {
              setMode("scanner");
              setIsAutoSweep(!isAutoSweep);
            }}
            className={cn(
              "text-xs gap-1.5 transition-all",
              isAutoSweep
                ? "border-emerald-500 bg-emerald-600 text-white shadow-[0_0_12px_rgba(16,185,129,0.5)] hover:bg-emerald-500"
                : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
            )}
          >
            <Zap className={cn("size-3.5", isAutoSweep && "animate-pulse")} />
            <span>{isAutoSweep ? "⚡ Auto-Sweep Active" : "⚡ Auto-Sweep Rift"}</span>
          </Button>
          <Button
            size="sm"
            variant={sliderVal === 50 && mode === "scanner" && !isAutoSweep ? "default" : "outline"}
            onClick={() => {
              setIsAutoSweep(false);
              setMode("scanner");
              handleSliderChange([50]);
            }}
            className="text-xs"
          >
            Split Scanner (50%)
          </Button>
          <Button
            size="sm"
            variant={sliderVal === 100 && !isAutoSweep ? "default" : "outline"}
            onClick={() => {
              setIsAutoSweep(false);
              handleSliderChange([100]);
            }}
            className="text-xs text-emerald-600 dark:text-emerald-400"
          >
            🧟 100% Rotting Ghoul Horde
          </Button>
        </div>
      </div>

      {/* Main Arena Container */}
      <div className="relative flex flex-col overflow-hidden rounded-2xl border bg-stone-950 text-stone-100 shadow-2xl">
        {/* Arena Controls Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 bg-stone-900/90 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="flex size-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold tracking-wider uppercase text-stone-300">
              Live Arena ({filteredCharacters.length} Units Active): {sliderVal === 0 ? "Mismatched Base Assets" : sliderVal === 100 ? "Unified Undead Horde" : "Dynamic Style Rift"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Squad Filters */}
            <div className="flex items-center rounded-lg border border-stone-800 bg-stone-950 p-0.5 text-xs">
              <Button
                variant={squad === "all" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSquad("all")}
                className="h-7 px-2 text-[11px] text-stone-300"
              >
                All (14)
              </Button>
              <Button
                variant={squad === "humanoids" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSquad("humanoids")}
                className="h-7 px-2 text-[11px] text-stone-300"
              >
                Humanoids & Mounts (6)
              </Button>
              <Button
                variant={squad === "monsters" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSquad("monsters")}
                className="h-7 px-2 text-[11px] text-stone-300"
              >
                Monsters, Slimes & Grubs (6)
              </Button>
              <Button
                variant={squad === "drakes" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSquad("drakes")}
                className="h-7 px-2 text-[11px] text-stone-300"
              >
                Drakes (2)
              </Button>
            </div>

            {/* Action Toggles */}
            <div className="flex items-center rounded-lg border border-stone-800 bg-stone-950 p-0.5">
              <Button
                variant={activeClip === "walk" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveClip("walk")}
                className="h-7 px-2.5 text-xs text-stone-300"
              >
                Walk / Fly
              </Button>
              <Button
                variant={activeClip === "attack" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveClip("attack")}
                className="h-7 px-2.5 text-xs text-stone-300"
              >
                All Attack
              </Button>
              <Button
                variant={activeClip === "idle" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveClip("idle")}
                className="h-7 px-2.5 text-xs text-stone-300"
              >
                All Idle
              </Button>
            </div>

            {/* Crash Duel Toggle Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEnableClash(!enableClash)}
              className={cn(
                "h-7 px-2.5 text-xs gap-1.5 border-stone-800 bg-stone-950 transition-colors",
                enableClash
                  ? "border-amber-500/50 bg-amber-950/40 text-amber-300 hover:bg-amber-950/60"
                  : "text-stone-400 hover:text-stone-200"
              )}
              title="Toggle characters clashing into combat duels on collision"
            >
              <Swords className="size-3 text-amber-400" />
              <span>Crash Duels: {enableClash ? "ON" : "OFF"}</span>
            </Button>

            {/* Play / Pause */}
            <Button
              variant="outline"
              size="icon"
              className="size-7 border-stone-800 bg-stone-950 text-stone-300 hover:text-white"
              onClick={() => setIsPlaying(!isPlaying)}
              aria-label={isPlaying ? "Pause movement" : "Resume movement"}
            >
              {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>

            {/* Speed Toggle */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-stone-800 bg-stone-950 px-2 text-xs text-stone-300 hover:text-white"
              onClick={() => setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 0.6 : 1)}
            >
              {speed}x
            </Button>
          </div>
        </div>

        {/* Style Cohesion HUD for Judges & Live Demos */}
        <div className="border-b border-stone-800/80 bg-stone-950/95 px-4 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-stone-400">
                Visual Art Direction Cohesion:
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 font-mono text-xs font-semibold transition-all duration-300",
                  cohesionPct >= 85
                    ? "border-emerald-500/50 bg-emerald-950/40 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.3)]"
                    : cohesionPct <= 30
                    ? "border-amber-500/40 bg-amber-950/30 text-amber-300"
                    : "border-sky-500/40 bg-sky-950/30 text-sky-300"
                )}
              >
                {cohesionPct >= 85 ? (
                  <>
                    <Sparkles className="size-3 text-emerald-400" />
                    <span>100% UNIFIED GAME WORLD</span>
                  </>
                ) : cohesionPct <= 30 ? (
                  <>
                    <AlertTriangle className="size-3 text-amber-400" />
                    <span>{cohesionPct}% INCOHERENT ASSET PACKS</span>
                  </>
                ) : (
                  <>
                    <Zap className="size-3 text-sky-400" />
                    <span>{cohesionPct}% ACTIVE STYLE RIFT</span>
                  </>
                )}
              </Badge>
            </div>

            {/* Micro Breakdown of units */}
            <div className="flex items-center gap-3 text-[11px] font-mono text-stone-400">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-sky-400" />
                <span>Base Packs: {totalCount - zombieCount}</span>
              </span>
              <span className="text-stone-600">/</span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                <span className="font-medium text-emerald-400">Unified Ghouls: {zombieCount}</span>
              </span>
            </div>
          </div>

          {/* Micro Progress Bar */}
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-stone-900">
            <div
              className={cn(
                "h-full transition-all duration-300",
                cohesionPct >= 85
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-300 shadow-[0_0_8px_#10b981]"
                  : cohesionPct <= 30
                  ? "bg-gradient-to-r from-amber-600 to-amber-400"
                  : "bg-gradient-to-r from-sky-500 via-emerald-500 to-emerald-400"
              )}
              style={{ width: `${cohesionPct}%` }}
            />
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

          {/* Left Zone Label (Originals) */}
          <div
            className="pointer-events-none absolute top-4 left-4 z-10 flex flex-col gap-1 rounded-md border border-sky-500/20 bg-stone-950/70 p-2.5 backdrop-blur transition-opacity duration-300"
            style={{ opacity: sliderVal > 15 ? 0.9 : 0.2 }}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-400">
              <span className="size-2 rounded-full bg-sky-400" />
              Original Asset Packs
            </div>
            <div className="text-[11px] text-stone-400">
              Clashing styles, mixed palettes & authors
            </div>
          </div>

          {/* Right Zone Label (Rotting Ghoul Remixes) */}
          <div
            className="pointer-events-none absolute top-4 right-4 z-10 flex flex-col gap-1 rounded-md border border-emerald-500/20 bg-stone-950/70 p-2.5 text-right backdrop-blur transition-opacity duration-300"
            style={{ opacity: sliderVal < 85 ? 0.9 : 0.2 }}
          >
            <div className="flex items-center justify-end gap-1.5 text-xs font-semibold text-emerald-400">
              Unified Rotting Ghoul Style
              <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <div className="text-[11px] text-stone-400">
              Meta Muse AI repainted • 1 cohesive game world
            </div>
          </div>

          {/* Vertical Scanner Line / Energy Rift Divider */}
          {mode === "scanner" && (
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
                  "absolute top-2 flex items-center gap-1.5 rounded-full border bg-stone-950 px-2.5 py-0.5 text-[10px] font-mono font-medium shadow-lg transition-colors",
                  isAutoSweep
                    ? "border-emerald-400 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                    : "border-emerald-500/50 text-emerald-300"
                )}
              >
                <ChevronsLeftRight className={cn("size-3 text-emerald-400", isAutoSweep && "animate-pulse")} />
                <span>STYLE RIFT {sliderVal}%{isAutoSweep ? " (AUTO-SWEEP)" : ""}</span>
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
          {filteredCharacters.map((char) => {
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
                className="absolute cursor-pointer transition-transform duration-75"
                style={{
                  left: `${st.x}%`,
                  top: `${st.y}%`,
                  zIndex: Math.floor(st.y * 10) + char.depthOffset,
                  transform: "translate(-50%, -70%)",
                }}
              >
                {/* Minimal, Translucent Character Name Tag with Style Indicator */}
                <div className="pointer-events-none mb-1 flex items-center justify-center opacity-85 transition-opacity">
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
                      speed={speed}
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

        {/* Tactile Transformation Slider Bar */}
        <div className="flex flex-col gap-3 border-t border-stone-800 bg-stone-900/95 p-4 sm:p-5">
          <div className="flex items-center justify-between text-xs sm:text-sm">
            <div className="flex items-center gap-1.5 font-medium text-sky-400">
              <span className="size-2 rounded-full bg-sky-400" />
              <span>Original Styles (0%)</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-stone-700 bg-stone-950 text-xs text-stone-300">
                {mode === "scanner" ? "Interactive Rift Scanner" : "Global Horde Infection"}: {sliderVal}%
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMode(mode === "scanner" ? "global" : "scanner")}
                className="h-6 text-[11px] text-stone-400 hover:text-white"
              >
                Switch to {mode === "scanner" ? "Global Mode" : "Scanner Mode"}
              </Button>
            </div>
            <div className="flex items-center gap-1.5 font-medium text-emerald-400">
              <span>(100%) Unified Ghoul Horde</span>
              <Skull className="size-3 text-emerald-400" />
            </div>
          </div>

          {/* Slider Element */}
          <div className="px-2">
            <Slider
              value={[sliderVal]}
              onValueChange={handleSliderChange}
              min={0}
              max={100}
              step={1}
              className="py-1 cursor-grab active:cursor-grabbing"
              aria-label="Style Transformation Slider"
            />
          </div>

          <p className="text-center text-xs text-stone-400">
            {sliderVal === 0 ? (
              <span className="text-amber-300">
                ⚠️ Mismatched Asset Packs: 14 distinct rigs from different creators clashing in lighting, color palettes, and art styles.
              </span>
            ) : sliderVal === 100 ? (
              <span className="text-emerald-400">
                ✨ Unified Game World: All 14 characters share the exact same comic book cross-hatched rotting ghoul watercolor art direction!
              </span>
            ) : (
              <span>
                {isAutoSweep
                  ? "⚡ Auto-Sweep active: Watch the rift line sweep across the battlefield and dynamically repaint rigs on the GPU in real time!"
                  : "Move the slider or enable Auto-Sweep. As each character crosses the rift line, its texture atlas repaints on the GPU while keeping its walk cycle intact!"}
              </span>
            )}
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
