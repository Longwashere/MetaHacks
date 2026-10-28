import type * as SpineModule from "@esotericsoftware/spine-player";
import type { SpinePlayer, TextureRegion } from "@esotericsoftware/spine-player";
import { TweakController } from "~/lib/spine-tweak-controller";
import { DEFAULT_PART, DEFAULT_TWEAKS, isDefaultPart, type PartTweak, type SpineTweaks } from "~/lib/spine-tweaks";
import type { AutoTweakPart, AutoTweakReview, AutoTweakStatus, AutoTweakTransform, SpineAssetFiles } from "~/lib/types";

// Auto-tweak, browser side. The original rig and the remix share a skeleton and meshes; only the
// atlas pixels differ. So each part's drift can be measured exactly: compare where its opaque
// pixels sit in the two atlases and map that through the attachment's UVs into world space.
// The rigs are also rendered offscreen, paused at the same poses, as labelled side-by-side
// snapshots for Muse to judge which fixes to keep.

type Spine = typeof SpineModule;

/** CSS pixels of each offscreen render, and of each panel in the snapshot. */
const RENDER_SIZE = 400;
const HEADER = 26;
/** Fractions of the animation to snapshot. */
const POSES = [0, 0.5];
/** A part needs this many opaque pixels in both atlases to be measured. */
const MIN_PIXELS = 30;
/** Painted area may change by this factor before the part counts as reshaped, like the backend's alignment. */
const SHAPE_TOLERANCE = 1.25;
/** Fixes smaller than this (% of the rig's size, or scale) aren't worth a tweak. */
const MIN_MOVE = 0.25;
const MIN_SCALE = 0.03;
const MIN_ROTATION = 2;
/** Rotation is only measured on parts whose pixels' long axis is at least this many times their short one; round parts have no clear direction. */
const MIN_ELONGATION = 1.3;
/** A measured turn beyond this is more likely a redrawn part than a drifted one, so it's left to Muse. */
const MAX_ROTATION = 45;
const LOAD_TIMEOUT_MS = 20_000;

export interface AutoTweakCapture {
  images: string[];
  parts: AutoTweakPart[];
  /** `tweaks` with every measured fix applied: the fallback when the review fails. */
  measured: (tweaks: SpineTweaks) => SpineTweaks;
  /** `tweaks` with Muse's changes applied. */
  apply: (tweaks: SpineTweaks, review: AutoTweakReview) => SpineTweaks;
  measuredCount: number;
}

/** Where a part's pixels sit, in world units at the setup pose. */
interface PartMeasure {
  cx: number;
  cy: number;
  /** RMS distance of the pixels from their centre. */
  spread: number;
  /** Direction of the pixels' long axis in degrees, or null when the part is too round to tell. */
  angle: number | null;
  /** Opaque area in world units². */
  area: number;
  /** Centre of the attachment's vertices, which part scale and rotation pivot on. */
  pivotX: number;
  pivotY: number;
  bone: { a: number; b: number; c: number; d: number };
}

type PartTransform = Pick<PartTweak, "dx" | "dy" | "scale" | "rotation">;

/**
 * Renders and measures the original and the remix, and returns what Muse needs plus helpers
 * to turn its answer into tweaks. `tweaks` are the user's current edits.
 */
export async function captureAutoTweak({
  original,
  remix,
  animation,
  tweaks,
}: {
  original: SpineAssetFiles;
  remix: SpineAssetFiles;
  animation: string;
  tweaks: SpineTweaks;
}): Promise<AutoTweakCapture> {
  const spine = await import("@esotericsoftware/spine-player");
  // Snapshots hold still and show only the rig: no scrub, reversal, layered animation or debug.
  const base: SpineTweaks = { ...tweaks, scrub: null, reverse: false, layer: null, debug: DEFAULT_TWEAKS.debug, parts: {} };

  const originalRig = await openRig(spine, original, animation, base);
  let originalParts: Map<string, PartMeasure>;
  const originalShots: HTMLCanvasElement[] = [];
  try {
    originalParts = measureParts(spine, originalRig.player);
    for (const pose of POSES) {
      await poseAt(originalRig.player, pose);
      originalShots.push(copyCanvas(originalRig.player));
    }
  } finally {
    originalRig.close();
  }

  const remixRig = await openRig(spine, remix, animation, base);
  try {
    // Measured before the user's part tweaks are synced, since those move the vertices.
    const remixParts = measureParts(spine, remixRig.player);
    const names = remixRig.controller.info().parts;
    const conv = new Converter(remixParts, remixRig.controller.rigSize, tweaks);

    const fixes = new Map<string, PartTransform>();
    const parts: AutoTweakPart[] = names.map((name, i) => {
      const { status, fix } = compare(originalParts.get(name), remixParts.get(name), remixRig.controller.rigSize);
      const tweak = fix && conv.toTweak(name, conv.fromWorld(fix));
      if (tweak) fixes.set(name, tweak);
      const current = tweaks.parts[name];
      return {
        id: i + 1,
        name,
        status: tweak ? status : status === "measured" ? "unmeasured" : status,
        measured: tweak ? conv.toScreen(name, tweak) : null,
        current: current && hasTransform(current) ? conv.toScreen(name, current) : null,
      };
    });
    const withFixes = (t: SpineTweaks) => {
      let next = t.parts;
      for (const [name, fix] of fixes) next = setTransform(next, name, fix);
      return { ...t, parts: next };
    };

    const panels: Panel[][] = POSES.map((_, i) => [{ title: "ORIGINAL", canvas: originalShots[i], labels: [] }]);
    const renders: [string, SpineTweaks][] = [
      ["REMIX NOW", { ...base, parts: tweaks.parts }],
      ["REMIX + MEASURED FIXES", withFixes({ ...base, parts: tweaks.parts })],
    ];
    for (const [title, values] of renders) {
      remixRig.controller.sync(values);
      for (let i = 0; i < POSES.length; i++) {
        await poseAt(remixRig.player, POSES[i]);
        panels[i].push({ title, canvas: copyCanvas(remixRig.player), labels: labelParts(spine, remixRig, parts, values) });
      }
    }

    return {
      images: panels.map(composite),
      parts,
      measuredCount: fixes.size,
      measured: withFixes,
      apply: (t, review) => {
        let next = t.parts;
        for (const change of review.changes) {
          const fix = conv.toTweak(change.part, change);
          if (fix) next = setTransform(next, change.part, fix);
        }
        return { ...t, parts: next };
      },
    };
  } finally {
    remixRig.close();
  }
}

function hasTransform(p: PartTweak) {
  return p.dx !== 0 || p.dy !== 0 || p.scale !== 1 || p.rotation !== 0;
}

function setTransform(parts: Record<string, PartTweak>, name: string, t: PartTransform): Record<string, PartTweak> {
  const { [name]: current, ...rest } = parts;
  const next = { ...(current ?? DEFAULT_PART), ...t };
  return isDefaultPart(next) ? rest : { ...rest, [name]: next };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** Measures every part's setup-pose attachment against its atlas pixels. */
function measureParts(spine: Spine, player: SpinePlayer): Map<string, PartMeasure> {
  const live = player.skeleton;
  const out = new Map<string, PartMeasure>();
  if (!live) return out;
  const skeleton = new spine.Skeleton(live.data);
  skeleton.setSkin(live.skin);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform(spine.Physics.none);

  const pages = new Map<unknown, ImageData | null>();
  for (const slot of skeleton.slots) {
    const att = slot.attachment;
    let vertices: number[];
    let uvs: ArrayLike<number>;
    let region: TextureRegion | null;
    if (att instanceof spine.RegionAttachment) {
      vertices = new Array<number>(8);
      att.computeWorldVertices(slot, vertices, 0, 2);
      uvs = att.uvs;
      region = att.region;
    } else if (att instanceof spine.MeshAttachment) {
      vertices = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(slot, 0, att.worldVerticesLength, vertices, 0, 2);
      uvs = att.uvs;
      region = att.region;
    } else continue;
    if (!region || region.u2 === region.u || region.v2 === region.v) continue;

    // Region-relative coordinates (0–1 across the packed rect), so a repacked atlas still compares.
    const points: number[] = [];
    for (let i = 0; i < vertices.length; i += 2) {
      points.push((uvs[i] - region.u) / (region.u2 - region.u), (uvs[i + 1] - region.v) / (region.v2 - region.v));
    }
    const affine = fitAffine(points, vertices);
    if (!affine) continue;

    if (!pages.has(region.texture)) pages.set(region.texture, pagePixels(region.texture));
    const pixels = pages.get(region.texture);
    const stats = pixels ? pixelStats(pixels, region) : null;
    if (!stats) continue;

    const [ax, bx, cx, ay, by, cy] = affine;
    // Covariance mapped through the affine's linear part; its trace is the squared spread, and its
    // main eigenvector the direction the part points.
    const sxx = ax * ax * stats.vss + 2 * ax * bx * stats.vst + bx * bx * stats.vtt;
    const syy = ay * ay * stats.vss + 2 * ay * by * stats.vst + by * by * stats.vtt;
    const sxy = ax * ay * stats.vss + (ax * by + bx * ay) * stats.vst + bx * by * stats.vtt;
    let pivotX = 0;
    let pivotY = 0;
    for (let i = 0; i < vertices.length; i += 2) {
      pivotX += vertices[i];
      pivotY += vertices[i + 1];
    }
    const bone = slot.bone;
    out.set(slot.data.name, {
      cx: ax * stats.s + bx * stats.t + cx,
      cy: ay * stats.s + by * stats.t + cy,
      spread: Math.sqrt(sxx + syy),
      angle: longAxis(sxx, syy, sxy),
      area: stats.coverage * Math.abs(ax * by - bx * ay),
      pivotX: pivotX / (vertices.length / 2),
      pivotY: pivotY / (vertices.length / 2),
      bone: { a: bone.a, b: bone.b, c: bone.c, d: bone.d },
    });
  }
  return out;
}

function pagePixels(texture: unknown): ImageData | null {
  const image = (texture as { getImage?: () => CanvasImageSource & { width: number; height: number } } | null)?.getImage?.();
  if (!image?.width || !image.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  try {
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    // A page served without CORS taints the canvas.
    return null;
  }
}

/** Alpha-weighted centre and covariance of a region's pixels, in region-relative coordinates. */
function pixelStats(image: ImageData, region: TextureRegion) {
  const { width: w, height: h, data } = image;
  const left = region.u * w;
  const top = region.v * h;
  const rw = (region.u2 - region.u) * w;
  const rh = (region.v2 - region.v) * h;
  const x0 = Math.max(Math.round(left), 0);
  const x1 = Math.min(Math.round(left + rw), w);
  const y0 = Math.max(Math.round(top), 0);
  const y1 = Math.min(Math.round(top + rh), h);
  let sw = 0, ss = 0, st = 0, sss = 0, stt = 0, sst = 0;
  for (let y = y0; y < y1; y++) {
    const t = (y + 0.5 - top) / rh;
    for (let x = x0; x < x1; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a === 0) continue;
      const weight = a / 255;
      const s = (x + 0.5 - left) / rw;
      sw += weight;
      ss += weight * s;
      st += weight * t;
      sss += weight * s * s;
      stt += weight * t * t;
      sst += weight * s * t;
    }
  }
  if (sw < MIN_PIXELS) return null;
  const s = ss / sw;
  const t = st / sw;
  return { s, t, vss: sss / sw - s * s, vtt: stt / sw - t * t, vst: sst / sw - s * t, coverage: sw / ((x1 - x0) * (y1 - y0)) };
}

/** Least-squares affine map from (s, t) points to world vertices: [ax, bx, cx, ay, by, cy]. */
function fitAffine(points: number[], world: number[]): number[] | null {
  // Normal equations: N · p = r, with N = Σ [s t 1]ᵀ[s t 1].
  let ss = 0, st = 0, s1 = 0, tt = 0, t1 = 0, n = 0;
  let rxs = 0, rxt = 0, rx1 = 0, rys = 0, ryt = 0, ry1 = 0;
  for (let i = 0; i < points.length; i += 2) {
    const s = points[i], t = points[i + 1], x = world[i], y = world[i + 1];
    ss += s * s; st += s * t; s1 += s; tt += t * t; t1 += t; n++;
    rxs += x * s; rxt += x * t; rx1 += x;
    rys += y * s; ryt += y * t; ry1 += y;
  }
  const det = ss * (tt * n - t1 * t1) - st * (st * n - t1 * s1) + s1 * (st * t1 - tt * s1);
  if (n < 3 || Math.abs(det) < 1e-12) return null;
  // Cramer's rule on the symmetric 3×3 system.
  const solve = (r0: number, r1: number, r2: number) => [
    (r0 * (tt * n - t1 * t1) - st * (r1 * n - t1 * r2) + s1 * (r1 * t1 - tt * r2)) / det,
    (ss * (r1 * n - t1 * r2) - r0 * (st * n - t1 * s1) + s1 * (st * r2 - r1 * s1)) / det,
    (ss * (tt * r2 - t1 * r1) - st * (st * r2 - r1 * s1) + r0 * (st * t1 - tt * s1)) / det,
  ];
  return [...solve(rxs, rxt, rx1), ...solve(rys, ryt, ry1)];
}

/** Angle (degrees) of a covariance's long axis, or null when its axes are too close in length. */
function longAxis(sxx: number, syy: number, sxy: number): number | null {
  const half = (sxx + syy) / 2;
  const r = Math.hypot((sxx - syy) / 2, sxy);
  const small = half - r;
  // Eigenvalues are squared axis lengths.
  if (small <= 0 ? r === 0 : (half + r) / small < MIN_ELONGATION * MIN_ELONGATION) return null;
  return (Math.atan2(2 * sxy, sxx - syy) * 90) / Math.PI;
}

/**
 * The fix that puts the remix's pixels where the original's are, as a world-space offset of the
 * part's pivot (% of the rig's size), a scale and a counter-clockwise rotation about it.
 */
function compare(
  original: PartMeasure | undefined,
  remix: PartMeasure | undefined,
  rigSize: number,
): { status: AutoTweakStatus; fix: AutoTweakTransform | null } {
  if (!original || !remix || original.spread === 0 || remix.spread === 0) return { status: "unmeasured", fix: null };
  const ratio = remix.area / original.area;
  if (ratio > SHAPE_TOLERANCE || ratio < 1 / SHAPE_TOLERANCE) return { status: "reshaped", fix: null };

  let scale = original.spread / remix.spread;
  if (Math.abs(scale - 1) < MIN_SCALE) scale = 1;

  let rotate = 0;
  if (original.angle !== null && remix.angle !== null) {
    // An axis has no head or tail, so the turn wraps at ±90°.
    const turn = ((((original.angle - remix.angle + 90) % 180) + 180) % 180) - 90;
    if (Math.abs(turn) >= MIN_ROTATION && Math.abs(turn) <= MAX_ROTATION) rotate = Math.round(turn);
  }

  // Scaling and turning about the pivot move the pixel centre too, so solve for the offset after them.
  const rad = (rotate * Math.PI) / 180;
  const rx = remix.cx - remix.pivotX;
  const ry = remix.cy - remix.pivotY;
  const ox = original.cx - remix.pivotX - scale * (rx * Math.cos(rad) - ry * Math.sin(rad));
  const oy = original.cy - remix.pivotY - scale * (rx * Math.sin(rad) + ry * Math.cos(rad));
  const x = (ox / rigSize) * 100;
  const y = (oy / rigSize) * 100;
  if (Math.abs(x) > 15 || Math.abs(y) > 15) return { status: "reshaped", fix: null };
  if (Math.abs(x) < MIN_MOVE && Math.abs(y) < MIN_MOVE && scale === 1 && rotate === 0) return { status: "aligned", fix: null };
  return { status: "measured", fix: { x, y, scale, rotate } };
}

/**
 * Converts between part tweaks (offsets in the part's bone space, see TweakController.offsetPart)
 * and screen terms (right/up, counter-clockwise), which is what Muse sees in the snapshots.
 * Fixes from `compare` are in the unflipped, unscaled world, so they go through `fromWorld` first.
 */
class Converter {
  private readonly sx: number;
  private readonly sy: number;

  constructor(
    private readonly parts: Map<string, PartMeasure>,
    private readonly rigSize: number,
    tweaks: SpineTweaks,
  ) {
    this.sx = (tweaks.flipX ? -1 : 1) * tweaks.scaleX;
    this.sy = tweaks.scaleY;
  }

  /** A fix measured in the unflipped world, in screen terms (the rig's flip and scale applied). */
  fromWorld(t: AutoTweakTransform): AutoTweakTransform {
    const norm = Math.sqrt(Math.abs(this.sx * this.sy)) || 1;
    // A mirrored rig turns the other way on screen.
    const rotate = t.rotate * (Math.sign(this.sx * this.sy) || 1);
    return { x: round((t.x * this.sx) / norm), y: round((t.y * this.sy) / norm), scale: t.scale, rotate };
  }

  /** A screen-space transform as the part's tweak, or null when the part can't be placed. */
  toTweak(name: string, t: AutoTweakTransform): PartTransform | null {
    const m = this.parts.get(name);
    if (!m) return null;
    const { a, b, c, d } = m.bone;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;
    const unit = Math.sqrt(Math.abs(det)) * Math.sqrt(Math.abs(this.sx * this.sy));
    // Undo the rig's flip and scale, then the bone: u = unit · M⁻¹ · S⁻¹ · o.
    const wx = ((t.x / 100) * this.rigSize) / this.sx;
    const wy = ((t.y / 100) * this.rigSize) / this.sy;
    const ux = (unit * (d * wx - b * wy)) / det;
    const uy = (unit * (-c * wx + a * wy)) / det;
    const sign = Math.sign(det * this.sx * this.sy) || 1;
    return {
      dx: round(clamp((ux / this.rigSize) * 100, -15, 15)),
      dy: round(clamp((uy / this.rigSize) * 100, -15, 15)),
      scale: round(clamp(t.scale, 0.5, 2)),
      rotation: Math.round(clamp(t.rotate * sign, -180, 180)),
    };
  }

  /** A part tweak in screen terms. */
  toScreen(name: string, p: PartTransform): AutoTweakTransform {
    const m = this.parts.get(name);
    if (!m) return { x: 0, y: 0, scale: p.scale, rotate: p.rotation };
    const { a, b, c, d } = m.bone;
    const det = a * d - b * c;
    const unit = Math.sqrt(Math.abs(det)) * Math.sqrt(Math.abs(this.sx * this.sy)) || 1;
    const ux = (p.dx / 100) * this.rigSize;
    const uy = (p.dy / 100) * this.rigSize;
    const wx = (this.sx * (a * ux + b * uy)) / unit;
    const wy = (this.sy * (c * ux + d * uy)) / unit;
    const sign = Math.sign(det * this.sx * this.sy) || 1;
    return { x: round((wx / this.rigSize) * 100), y: round((wy / this.rigSize) * 100), scale: round(p.scale), rotate: p.rotation * sign };
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Rig {
  player: SpinePlayer;
  controller: TweakController;
  close: () => void;
}

/** Loads a rig into a hidden player of a fixed size, so the original and the remix frame identically. */
function openRig(spine: Spine, files: SpineAssetFiles, animation: string, tweaks: SpineTweaks): Promise<Rig> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${RENDER_SIZE}px`,
    height: `${RENDER_SIZE}px`,
    pointerEvents: "none",
  });
  document.body.append(host);

  let player: SpinePlayer | null = null;
  let controller: TweakController | null = null;
  const close = () => {
    const canvas = host.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    player?.dispose();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    host.remove();
  };

  return new Promise<Rig>((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(new Error("The rig took too long to load."));
    }, LOAD_TIMEOUT_MS);
    player = new spine.SpinePlayer(host, {
      skeleton: files.skeletonUrl,
      atlas: files.atlasUrl,
      skin: files.skin ?? undefined,
      premultipliedAlpha: files.premultipliedAlpha,
      showControls: false,
      showLoading: false,
      interactive: false,
      alpha: true,
      backgroundColor: "#00000000",
      // Lets the canvas be copied after the frame that drew it.
      preserveDrawingBuffer: true,
      // Same padding as SpineRuntime; no transition, so the first posed frame is final.
      viewport: { padLeft: "8%", padRight: "8%", padTop: "8%", padBottom: "8%", transitionTime: 0 },
      updateWorldTransform: (p) => {
        if (controller) controller.pose(spine.Physics.update);
        else p.skeleton?.updateWorldTransform(spine.Physics.update);
      },
      update: () => controller?.frame(),
      success: (p) => {
        clearTimeout(timer);
        const data = p.skeleton?.data;
        const name = data?.findAnimation(animation) ? animation : data?.animations[0]?.name;
        if (name) p.setAnimation(name, true);
        // In the setup pose here, like SpineRuntime, so rigSize matches the live preview's.
        controller = new TweakController(spine, p, files.atlasUrl, tweaks);
        resolve({ player: p, controller, close });
      },
      error: (_p, message) => {
        clearTimeout(timer);
        close();
        reject(new Error(`Couldn't load the rig: ${message}`));
      },
    });
  });
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Pauses the rig at a fraction of the animation and waits until that pose has been drawn. */
async function poseAt(player: SpinePlayer, fraction: number) {
  // The player starts playback right after `success`, so pause here rather than on load.
  player.pause();
  const entry = player.animationState?.getCurrent(0);
  if (entry?.animation) entry.trackTime = fraction * entry.animation.duration;
  // TweakController.frame applies the paused pose on the next frame; one more to be sure it's drawn.
  for (let i = 0; i < 3; i++) await nextFrame();
}

function copyCanvas(player: SpinePlayer): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = RENDER_SIZE;
  out.height = RENDER_SIZE;
  if (player.canvas) out.getContext("2d")?.drawImage(player.canvas, 0, 0, RENDER_SIZE, RENDER_SIZE);
  return out;
}

interface Label {
  id: number;
  x: number;
  y: number;
  measured: boolean;
}

interface Panel {
  title: string;
  canvas: HTMLCanvasElement;
  labels: Label[];
}

/** Each drawn part's number, at the centre of its outline in the current pose. */
function labelParts(spine: Spine, rig: Rig, parts: AutoTweakPart[], tweaks: SpineTweaks): Label[] {
  const { player, controller } = rig;
  const camera = player.sceneRenderer?.camera as unknown as
    | { worldToScreen: (v: InstanceType<Spine["Vector3"]>, w: number, h: number) => { x: number; y: number } }
    | undefined;
  const canvas = player.canvas;
  const skeleton = player.skeleton;
  if (!camera || !canvas || !skeleton) return [];
  const w = canvas.clientWidth || RENDER_SIZE;
  const h = canvas.clientHeight || RENDER_SIZE;
  const vec = new spine.Vector3();
  const labels: Label[] = [];
  for (const part of parts) {
    const slot = skeleton.findSlot(part.name);
    if (!slot?.attachment || !slot.bone.active || slot.color.a === 0 || tweaks.parts[part.name]?.hidden) continue;
    const hull = controller.outline(part.name);
    if (!hull || hull.length < 6) continue;
    let x = 0;
    let y = 0;
    for (let i = 0; i < hull.length; i += 2) {
      x += hull[i];
      y += hull[i + 1];
    }
    vec.set(x / (hull.length / 2), y / (hull.length / 2), 0);
    camera.worldToScreen(vec, w, h);
    labels.push({ id: part.id, x: (vec.x / w) * RENDER_SIZE, y: ((h - vec.y) / h) * RENDER_SIZE, measured: part.status === "measured" });
  }
  return labels;
}

/** One pose: the panels side by side under their titles, with part numbers. */
function composite(panels: Panel[]): string {
  const out = document.createElement("canvas");
  out.width = RENDER_SIZE * panels.length;
  out.height = RENDER_SIZE + HEADER;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Couldn't draw the snapshot.");
  // A plain mid-light backdrop reads well for dark and light art alike; the image is for Muse, not the page.
  ctx.fillStyle = "#d4d4d8";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = "middle";

  panels.forEach((panel, i) => {
    const left = i * RENDER_SIZE;
    ctx.fillStyle = "#18181b";
    ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${i + 1}. ${panel.title}`, left + 8, HEADER / 2);
    ctx.drawImage(panel.canvas, left, HEADER);
    if (i > 0) ctx.fillRect(left, 0, 1, out.height);

    ctx.font = "700 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    for (const label of panel.labels) {
      const x = left + label.x;
      const y = HEADER + label.y;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = label.measured ? "#ea580c" : "rgba(24, 24, 27, 0.8)";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(label.id), x, y + 0.5);
    }
  });
  return out.toDataURL("image/jpeg", 0.85);
}
