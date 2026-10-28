// Live, in-browser edits to a Spine rig on the remix page. Nothing here calls a model:
// the runtime applies these on top of the loaded skeleton every frame.

import type { MeshReason } from "~/lib/spine-mesh";

/** Wind and gravity sliders run from -1 to 1; this times the rig's size is the force at the ends. */
export const PHYSICS_FORCE_SCALE = 0.2;

export const TWEAK_BLEND_MODES = ["rig", "normal", "additive", "multiply", "screen"] as const;
export type TweakBlendMode = (typeof TWEAK_BLEND_MODES)[number];

/** Edits to one slot ("part"). Offsets are a percentage of the rig's size so they mean the same on every rig. */
export interface PartTweak {
  hidden: boolean;
  dx: number;
  dy: number;
  scale: number;
  /** Degrees. */
  rotation: number;
  /** Hex multiplied over the part, or null for none. */
  color: string | null;
  /** Hex for the part's darks (two-color tint), or null to use the global shadow. */
  shadow: string | null;
  blend: TweakBlendMode;
  /**
   * Draw the part's whole atlas region instead of only the inside of its mesh outline, so a
   * repainted part with a new shape isn't cut off. Only rigid meshes can (see RigInfo.meshes).
   */
  fullTexture: boolean;
}

/** Changes a bone's setup pose; animations play relative to it, so they keep working. */
export interface BoneTweak {
  scaleX: number;
  scaleY: number;
  /** Degrees added to the setup rotation. */
  rotation: number;
}

export interface SpineTweaks {
  // Look
  tint: string;
  alpha: number;
  shadow: string | null;
  blend: TweakBlendMode;
  pixelated: boolean;
  flipX: boolean;
  scaleX: number;
  scaleY: number;
  debug: { meshes: boolean; regions: boolean; bounds: boolean; clipping: boolean };
  // Motion
  /** Crossfade seconds when switching animations. */
  mix: number;
  reverse: boolean;
  /** Fraction (0–1) of the animation to hold, or null to play. */
  scrub: number | null;
  /** Animation layered on track 1, or null. */
  layer: string | null;
  layerAlpha: number;
  // Rig
  /** Skins to combine, or null for the rig's default. */
  skins: string[] | null;
  physicsMix: number;
  wind: number;
  gravity: number;
  /** Multiplier on each physics constraint's strength. */
  stiffness: number;
  /** Bumped to shake the physics. */
  kick: number;
  ikMix: number;
  ikFlip: boolean;
  transformMix: number;
  // Parts
  parts: Record<string, PartTweak>;
  bones: Record<string, BoneTweak>;
}

export const DEFAULT_TWEAKS: SpineTweaks = {
  tint: "#ffffff",
  alpha: 1,
  shadow: null,
  blend: "rig",
  pixelated: false,
  flipX: false,
  scaleX: 1,
  scaleY: 1,
  debug: { meshes: false, regions: false, bounds: false, clipping: false },
  mix: 0.25,
  reverse: false,
  scrub: null,
  layer: null,
  layerAlpha: 1,
  skins: null,
  physicsMix: 1,
  wind: 0,
  gravity: 0,
  stiffness: 1,
  kick: 0,
  ikMix: 1,
  ikFlip: false,
  transformMix: 1,
  parts: {},
  bones: {},
};

export const DEFAULT_PART: PartTweak = {
  hidden: false,
  dx: 0,
  dy: 0,
  scale: 1,
  rotation: 0,
  color: null,
  shadow: null,
  blend: "rig",
  fullTexture: false,
};

export const DEFAULT_BONE: BoneTweak = { scaleX: 1, scaleY: 1, rotation: 0 };

export function isDefaultPart(p: PartTweak) {
  return (Object.keys(DEFAULT_PART) as (keyof PartTweak)[]).every((k) => p[k] === DEFAULT_PART[k]);
}

export function isDefaultBone(b: BoneTweak) {
  return b.scaleX === 1 && b.scaleY === 1 && b.rotation === 0;
}

/** What the loaded skeleton offers, reported by the runtime so the panel only shows controls that do something. */
export interface RigInfo {
  skins: string[];
  /** The skin the rig loads with. */
  baseSkin: string | null;
  /** Slots that draw a region or mesh in some skin. */
  parts: string[];
  /**
   * Parts drawn with a mesh, which only shows the texture inside its outline. Null when the part
   * can show its full texture (`PartTweak.fullTexture`), else why not (see MESH_REASONS).
   */
  meshes: Record<string, MeshReason | null>;
  bones: string[];
  animations: string[];
  physics: number;
  ik: number;
  transform: number;
}

/** Bakes tweaks into the rig's skeleton JSON. Provided by the runtime once the rig has loaded. */
export interface TweakExporter {
  /** False for binary .skel rigs, which the bake can't edit. */
  canExport: boolean;
  exportSkeleton: (tweaks: SpineTweaks) => Promise<{ skeleton: unknown; skin: string | null }>;
}

/** Wires a runtime to the tweak panel. */
export interface SpineTweakBinding {
  tweaks: SpineTweaks;
  selectedPart: string | null;
  /** When true, clicking the preview selects the part under the cursor. */
  picking: boolean;
  onPickPart: (part: string | null) => void;
  onRigInfo: (info: RigInfo) => void;
  /** Called with an exporter when the rig loads, and null when it unloads. */
  onExporter?: (exporter: TweakExporter | null) => void;
}
