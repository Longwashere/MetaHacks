import { useRef, useState, type PointerEvent } from "react";
import type { AutoRigJointName, AutoRigJoints } from "~/lib/types";
import { cn } from "~/lib/utils";

// Draggable joints over the auto-rig cutout (/autoRig). Coordinates are cutout pixels; the SVG's
// viewBox is the cutout's size, so pointer positions map through the SVG's screen matrix.

const LINKS: [AutoRigJointName, AutoRigJointName][] = [
  ["head", "neck"],
  ["neck", "pelvis"],
  ["neck", "shoulder_l"],
  ["neck", "shoulder_r"],
  ["shoulder_l", "elbow_l"],
  ["elbow_l", "wrist_l"],
  ["wrist_l", "hand_l"],
  ["shoulder_r", "elbow_r"],
  ["elbow_r", "wrist_r"],
  ["wrist_r", "hand_r"],
  ["pelvis", "hip_l"],
  ["pelvis", "hip_r"],
  ["hip_l", "knee_l"],
  ["knee_l", "ankle_l"],
  ["ankle_l", "toe_l"],
  ["hip_r", "knee_r"],
  ["knee_r", "ankle_r"],
  ["ankle_r", "toe_r"],
];

// Fixed colours so the sides read the same in light and dark mode (the cutout sits on a checker).
const SIDE_COLOURS = { l: "#22c55e", r: "#f97316", c: "#38bdf8" } as const;
const sideOf = (name: string) => (name.endsWith("_l") ? "l" : name.endsWith("_r") ? "r" : "c");

const LABELS: Record<string, string> = { l: "character's left", r: "character's right" };

interface JointEditorProps {
  image: string;
  width: number;
  height: number;
  joints: AutoRigJoints;
  onChange: (joints: AutoRigJoints) => void;
  className?: string;
}

export function JointEditor({ image, width, height, joints, onChange, className }: JointEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<AutoRigJointName | null>(null);
  const [hover, setHover] = useState<AutoRigJointName | null>(null);
  const r = Math.max(width, height) / 90;

  const toImage = (e: PointerEvent) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: Math.min(Math.max(p.x, 0), width), y: Math.min(Math.max(p.y, 0), height) };
  };

  const shown = dragging ?? hover;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-none rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:24px_24px] select-none"
        onPointerMove={(e) => {
          if (!dragging) return;
          const p = toImage(e);
          if (p) onChange({ ...joints, [dragging]: p });
        }}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
        role="img"
        aria-label="Character with draggable joints"
      >
        <image href={image} width={width} height={height} />
        {LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={joints[a].x} y1={joints[a].y} x2={joints[b].x} y2={joints[b].y} stroke={SIDE_COLOURS[sideOf(b)]} strokeWidth={r * 0.45} strokeLinecap="round" opacity={0.85} />
        ))}
        {(Object.keys(joints) as AutoRigJointName[]).map((name) => (
          <circle
            key={name}
            cx={joints[name].x}
            cy={joints[name].y}
            r={name === shown ? r * 1.4 : r}
            fill={SIDE_COLOURS[sideOf(name)]}
            stroke="black"
            strokeWidth={r * 0.25}
            className={cn("cursor-grab", dragging === name && "cursor-grabbing")}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture(e.pointerId);
              setDragging(name);
            }}
            onPointerEnter={() => setHover(name)}
            onPointerLeave={() => setHover((h) => (h === name ? null : h))}
          >
            <title>{name.replace("_", " ")}</title>
          </circle>
        ))}
      </svg>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{shown ? shown.replace("_", " ") : "Drag a joint to move it."}</span>
        {(["l", "r"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: SIDE_COLOURS[s] }} aria-hidden />
            {LABELS[s]}
          </span>
        ))}
      </p>
    </div>
  );
}
