import { cn } from "~/lib/utils";
import type { AssetCategory } from "~/lib/types";

// Stand-in for assets that have no exported Spine files yet: a stylised SVG rig
// whose animations are faked with CSS keyframes (see the spine-* keyframes in app.css).
// Rendered inside <SpinePreview>, which supplies the frame and accent color.

interface Motion {
  root?: string;
  body?: string;
  armL?: string;
  armR?: string;
  legL?: string;
  legR?: string;
  /** Multiplier on the clip duration. */
  pace?: number;
}

const BIPED_MOTION: Record<string, Motion> = {
  idle: { body: "animate-spine-bob", armL: "animate-spine-sway", armR: "animate-spine-sway" },
  walk: {
    body: "animate-spine-bob",
    armL: "animate-spine-swing",
    armR: "animate-spine-swing-rev",
    legL: "animate-spine-swing-rev",
    legR: "animate-spine-swing",
    pace: 1,
  },
  run: {
    body: "animate-spine-bob",
    armL: "animate-spine-swing",
    armR: "animate-spine-swing-rev",
    legL: "animate-spine-swing-rev",
    legR: "animate-spine-swing",
    pace: 0.6,
  },
  jump: { root: "animate-spine-jump", armL: "animate-spine-sway", armR: "animate-spine-sway" },
  attack: { body: "animate-spine-sway", armR: "animate-spine-strike" },
  hit: { body: "animate-spine-sway", pace: 0.5 },
  death: { body: "animate-spine-sway", root: "animate-spine-pulse" },
};

interface SpinePlaceholderProps {
  category: AssetCategory;
  animation: string;
  durationSec: number;
  playing: boolean;
  speed: number;
  showBones: boolean;
  hideSkin?: boolean;
  boneColor?: string;
  showLabels?: boolean;
}

export function SpinePlaceholder({
  category,
  animation,
  durationSec,
  playing,
  speed,
  showBones,
  hideSkin = false,
  boneColor,
  showLabels = false,
}: SpinePlaceholderProps) {
  const motion = BIPED_MOTION[animation];
  const dur = (durationSec * (motion?.pace ?? 1)) / Math.max(speed, 0.1);
  const bonesActive = showBones || hideSkin;

  return (
    <svg
      viewBox="0 0 120 140"
      aria-hidden
      className={cn(
        "size-3/4 [&_.part]:origin-top [&_.part]:[transform-box:fill-box]",
        !playing && "[&_*]:[animation-play-state:paused]",
      )}
      style={{ "--spine-dur": `${dur}s` } as React.CSSProperties}
    >
      <ellipse cx="60" cy="130" rx="28" ry="4" className="fill-foreground/10" />
      {category === "character" ? (
        <Biped motion={motion ?? BIPED_MOTION.idle} showBones={bonesActive} hideSkin={hideSkin} boneColor={boneColor} showLabels={showLabels} />
      ) : category === "creature" ? (
        <Blob animation={animation} showBones={bonesActive} hideSkin={hideSkin} boneColor={boneColor} showLabels={showLabels} />
      ) : category === "effect" ? (
        <Burst />
      ) : category === "prop" ? (
        <Prop animation={animation} showBones={bonesActive} hideSkin={hideSkin} boneColor={boneColor} showLabels={showLabels} />
      ) : category === "ui" ? (
        <UiWidget />
      ) : (
        // Categories Muse added get the generic prop shape.
        <Prop animation={animation} showBones={bonesActive} hideSkin={hideSkin} boneColor={boneColor} showLabels={showLabels} />
      )}
    </svg>
  );
}

function Bone({
  x1,
  y1,
  x2,
  y2,
  color,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  label?: string;
}) {
  return (
    <g className="stroke-foreground" style={color ? { stroke: color } : undefined}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth="1.4" />
      <circle cx={x1} cy={y1} r="2" className="fill-background" strokeWidth="1.2" />
      {label && (
        <g className="pointer-events-none select-none" transform={`translate(${x1 + 4}, ${y1 - 4})`}>
          <rect x="0" y="-6" width={label.length * 5.2 + 8} height="11" rx="2" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(255, 255, 255, 0.2)" strokeWidth="0.5" />
          <text x="4" y="2" fill="#f8fafc" fontSize="6.5" fontFamily="monospace" fontWeight="600">{label}</text>
        </g>
      )}
    </g>
  );
}

function Limb({
  x1,
  y1,
  x2,
  y2,
  className,
  showBones,
  hideSkin,
  boneColor,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  className?: string;
  showBones: boolean;
  hideSkin?: boolean;
  boneColor?: string;
  label?: string;
}) {
  return (
    <g className={cn("part", className)}>
      {!hideSkin && (
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="9" strokeLinecap="round" opacity="0.7" />
      )}
      {showBones && <Bone x1={x1} y1={y1} x2={x2} y2={y2} color={boneColor} label={label} />}
    </g>
  );
}

function Biped({ motion, showBones, hideSkin, boneColor, showLabels }: { motion: Motion; showBones: boolean; hideSkin?: boolean; boneColor?: string; showLabels?: boolean }) {
  return (
    <g className={cn("part", motion.root)}>
      <Limb x1={54} y1={84} x2={50} y2={122} className={motion.legL} showBones={showBones} hideSkin={hideSkin} boneColor={boneColor} label={showLabels ? "leg_L" : undefined} />
      <Limb x1={66} y1={84} x2={70} y2={122} className={motion.legR} showBones={showBones} hideSkin={hideSkin} boneColor={boneColor} label={showLabels ? "leg_R" : undefined} />
      <g className={cn("part", motion.body)}>
        <Limb x1={46} y1={54} x2={38} y2={86} className={motion.armL} showBones={showBones} hideSkin={hideSkin} boneColor={boneColor} label={showLabels ? "arm_L" : undefined} />
        {!hideSkin ? (
          <>
            <rect x="45" y="48" width="30" height="40" rx="11" fill="currentColor" />
            <circle cx="60" cy="33" r="15" fill="currentColor" />
            <circle cx="55" cy="31" r="2.2" className="fill-background" />
            <circle cx="65" cy="31" r="2.2" className="fill-background" />
          </>
        ) : (
          <>
            <rect x="45" y="48" width="30" height="40" rx="11" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
            <circle cx="60" cy="33" r="15" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
          </>
        )}
        <Limb x1={74} y1={54} x2={82} y2={86} className={motion.armR} showBones={showBones} hideSkin={hideSkin} boneColor={boneColor} label={showLabels ? "arm_R" : undefined} />
        {showBones && (
          <>
            <Bone x1={60} y1={88} x2={60} y2={50} color={boneColor} label={showLabels ? "spine" : undefined} />
            <Bone x1={60} y1={50} x2={60} y2={20} color={boneColor} label={showLabels ? "head" : undefined} />
          </>
        )}
      </g>
    </g>
  );
}

function Blob({
  animation,
  showBones,
  hideSkin,
  boneColor,
  showLabels,
}: {
  animation: string;
  showBones: boolean;
  hideSkin?: boolean;
  boneColor?: string;
  showLabels?: boolean;
}) {
  const anim =
    animation === "jump" ? "animate-spine-jump" : animation === "attack" ? "animate-spine-sway" : "animate-spine-pulse";
  return (
    <g className={cn("part origin-bottom!", anim)}>
      {!hideSkin ? (
        <>
          <path d="M22 124 C 18 76, 44 52, 62 52 C 84 52, 104 78, 98 124 Z" fill="currentColor" />
          <circle cx="50" cy="86" r="6" className="fill-background" />
          <circle cx="74" cy="86" r="6" className="fill-background" />
          <circle cx="51" cy="87" r="2.5" className="fill-foreground" />
          <circle cx="75" cy="87" r="2.5" className="fill-foreground" />
        </>
      ) : (
        <path d="M22 124 C 18 76, 44 52, 62 52 C 84 52, 104 78, 98 124 Z" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
      )}
      {showBones && (
        <>
          <Bone x1={60} y1={124} x2={60} y2={86} color={boneColor} label={showLabels ? "body" : undefined} />
          <Bone x1={60} y1={86} x2={40} y2={66} color={boneColor} label={showLabels ? "eye_l" : undefined} />
          <Bone x1={60} y1={86} x2={82} y2={66} color={boneColor} label={showLabels ? "eye_r" : undefined} />
        </>
      )}
    </g>
  );
}

function Burst() {
  return (
    <g>
      <g className="part animate-spine-spin origin-center!">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <rect key={deg} x="58" y="20" width="4" height="22" rx="2" fill="currentColor" opacity="0.6" transform={`rotate(${deg} 60 70)`} />
        ))}
      </g>
      <g className="part animate-spine-pulse origin-center!">
        <circle cx="60" cy="70" r="26" fill="none" stroke="currentColor" strokeWidth="4" />
        <circle cx="60" cy="70" r="14" fill="currentColor" />
      </g>
    </g>
  );
}

function Prop({
  animation,
  showBones,
  hideSkin,
  boneColor,
  showLabels,
}: {
  animation: string;
  showBones: boolean;
  hideSkin?: boolean;
  boneColor?: string;
  showLabels?: boolean;
}) {
  const lid = animation === "open" || animation === "collect" ? "animate-spine-strike origin-bottom-left!" : "";
  return (
    <g className="part animate-spine-bob">
      {!hideSkin ? (
        <>
          <rect x="28" y="72" width="64" height="50" rx="6" fill="currentColor" />
          <rect x="54" y="84" width="12" height="14" rx="2" className="fill-background" />
          <g className={cn("part", lid)}>
            <rect x="26" y="54" width="68" height="22" rx="8" fill="currentColor" opacity="0.75" />
          </g>
        </>
      ) : (
        <>
          <rect x="28" y="72" width="64" height="50" rx="6" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
          <g className={cn("part", lid)}>
            <rect x="26" y="54" width="68" height="22" rx="8" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
          </g>
        </>
      )}
      {showBones && <Bone x1={28} y1={74} x2={92} y2={74} color={boneColor} label={showLabels ? "lid_joint" : undefined} />}
    </g>
  );
}

function UiWidget() {
  return (
    <g className="part animate-spine-pulse origin-center!">
      <rect x="14" y="48" width="92" height="44" rx="22" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M52 58 L 74 70 L 52 82 Z" fill="currentColor" />
    </g>
  );
}
