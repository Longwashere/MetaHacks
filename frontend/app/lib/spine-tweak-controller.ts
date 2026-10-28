import type * as SpineModule from "@esotericsoftware/spine-player";
import type {
  Attachment,
  BlendMode,
  BoneData,
  Color,
  NumberArrayLike,
  Physics,
  Skeleton,
  Skin,
  Slot,
  SpinePlayer,
  TextureAtlas,
} from "@esotericsoftware/spine-player";
import type { SetupPose } from "~/lib/spine-tweak-bake";
import { DEFAULT_BONE, PHYSICS_FORCE_SCALE, type RigInfo, type SpineTweaks, type TweakBlendMode } from "~/lib/spine-tweaks";

type Spine = typeof SpineModule;

interface SavedSlot {
  attachment: Attachment | null;
  r: number;
  g: number;
  b: number;
  a: number;
  dark: Color | null;
  blend: BlendMode;
}

/**
 * Applies `SpineTweaks` to a running SpinePlayer. The runtime is only imported on the
 * client, so the module is passed in rather than imported here.
 *
 * - Colors, visibility and blend modes are swapped in just for the draw call and restored after,
 *   so animation timelines never see them.
 * - Part offsets are applied to the world vertices each attachment computes, so they work for
 *   regions, weighted meshes and deformed meshes alike.
 * - Bone sculpting edits the setup pose, which animations are keyed relative to.
 */
export class TweakController {
  tweaks: SpineTweaks;
  /** Returns true when the skin should not be drawn (skeleton-only view). */
  hideSkin: () => boolean = () => false;

  private applied: SpineTweaks;
  private readonly skeleton: Skeleton;
  private readonly baseSkin: Skin | null;
  /** Largest side of the rig's bounds, so offsets and forces scale with the rig. */
  readonly rigSize: number;
  private readonly boneSetup = new Map<BoneData, { rotation: number; scaleX: number; scaleY: number }>();
  private readonly colors = new Map<string, Color>();
  private readonly darkColors: Color[] = [];
  private readonly saved: SavedSlot[] = [];
  private constraintsTouched = false;
  private readonly vertices: number[] = [];

  constructor(
    private readonly spine: Spine,
    private readonly player: SpinePlayer,
    private readonly atlasUrl: string,
    initial: SpineTweaks,
  ) {
    const skeleton = player.skeleton;
    if (!skeleton) throw new Error("TweakController needs a loaded skeleton");
    this.skeleton = skeleton;
    this.baseSkin = skeleton.skin;

    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    skeleton.getBounds(offset, size, []);
    const extent = Math.max(size.x, size.y);
    this.rigSize = Number.isFinite(extent) && extent > 0 ? extent : 100;

    this.patchAttachments();
    this.wrapDraw();

    // Start from the rig's own state so the first sync applies everything that differs.
    this.applied = { ...initial, skins: null, flipX: false, scaleX: 1, scaleY: 1, pixelated: false, layer: null, bones: {}, kick: initial.kick };
    this.tweaks = this.applied;
    this.sync(initial);
  }

  info(): RigInfo {
    const data = this.skeleton.data;
    const drawn = new Set<number>();
    for (const skin of data.skins) {
      for (const entry of skin.getAttachments()) {
        if (this.isDrawable(entry.attachment)) drawn.add(entry.slotIndex);
      }
    }
    return {
      skins: data.skins.map((s) => s.name),
      baseSkin: this.baseSkin?.name ?? null,
      parts: data.slots.filter((s) => drawn.has(s.index)).map((s) => s.name),
      bones: data.bones.map((b) => b.name),
      animations: data.animations.map((a) => a.name),
      physics: this.skeleton.physicsConstraints.length,
      ik: this.skeleton.ikConstraints.length,
      transform: this.skeleton.transformConstraints.length,
    };
  }

  /**
   * The setup pose the bake works from: bone sculpting is already in the bone data, and the
   * flip and scale are applied like the runtime applies them.
   */
  setupPose(tweaks: SpineTweaks): SetupPose {
    const skeleton = new this.spine.Skeleton(this.skeleton.data);
    skeleton.setSkin(this.skeleton.skin);
    skeleton.scaleX = (tweaks.flipX ? -1 : 1) * tweaks.scaleX;
    skeleton.scaleY = tweaks.scaleY;
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform(this.spine.Physics.none);
    return {
      rigSize: this.rigSize,
      bones: skeleton.bones.map((b) => ({ name: b.data.name, a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY })),
    };
  }

  /** Applies whatever changed since the last sync. */
  sync(next: SpineTweaks) {
    const prev = this.applied;
    const state = this.player.animationState;
    this.tweaks = next;
    if (!state) return;

    if (!sameList(prev.skins, next.skins)) this.applySkins(next.skins);

    if (prev.flipX !== next.flipX || prev.scaleX !== next.scaleX || prev.scaleY !== next.scaleY) {
      this.skeleton.scaleX = (next.flipX ? -1 : 1) * next.scaleX;
      this.skeleton.scaleY = next.scaleY;
      this.refit();
    }

    state.data.defaultMix = next.mix;
    if (prev.pixelated !== next.pixelated) this.applyFilters(next.pixelated);

    if (prev.layer !== next.layer) {
      if (next.layer && this.skeleton.data.findAnimation(next.layer)) {
        state.setAnimation(1, next.layer, true).alpha = next.layerAlpha;
      } else {
        state.setEmptyAnimation(1, next.mix);
      }
    } else if (prev.layerAlpha !== next.layerAlpha) {
      const layer = state.getCurrent(1);
      if (layer) layer.alpha = next.layerAlpha;
    }

    if (prev.bones !== next.bones) this.applyBones(next.bones);
    if (prev.kick !== next.kick) this.shake(next.kick);

    this.onAnimationChanged();
    this.applied = next;
  }

  /** Re-applies per-entry settings after the runtime switches animation on track 0. */
  onAnimationChanged() {
    const entry = this.player.animationState?.getCurrent(0);
    if (!entry) return;
    entry.reverse = this.tweaks.reverse;
    if (this.tweaks.scrub !== null && entry.animation) {
      entry.trackTime = this.tweaks.scrub * entry.animation.duration;
    }
  }

  /** Replaces the player's own world-transform update (called while playing). */
  pose(physics: Physics) {
    this.applyConstraints();
    this.skeleton.updateWorldTransform(physics);
  }

  /** Called every frame. While paused the player skips posing, so do it here to show edits and scrubbing. */
  frame() {
    const state = this.player.animationState;
    if (!this.player.paused || !state) return;
    state.apply(this.skeleton);
    this.pose(this.spine.Physics.pose);
  }

  /** The part drawn at a canvas point (CSS pixels), topmost first. */
  pick(x: number, y: number, width: number, height: number): string | null {
    const camera = this.player.sceneRenderer?.camera;
    if (!camera) return null;
    const p = camera.screenToWorld(new this.spine.Vector3(x, y, 0), width, height);
    const order = this.skeleton.drawOrder;
    for (let i = order.length - 1; i >= 0; i--) {
      const slot = order[i];
      if (!slot.bone.active || slot.color.a === 0 || this.tweaks.parts[slot.data.name]?.hidden) continue;
      const shape = this.shape(slot);
      if (shape && shape.triangles.some((t) => inTriangle(p.x, p.y, shape.vertices, t))) return slot.data.name;
    }
    return null;
  }

  /** World-space outline of a part's current attachment, as [x0, y0, x1, y1, ...]. */
  outline(part: string): number[] | null {
    const slot = this.skeleton.findSlot(part);
    if (!slot) return null;
    return this.shape(slot)?.hull ?? null;
  }

  private shape(slot: Slot): { vertices: number[]; triangles: [number, number, number][]; hull: number[] } | null {
    const att = slot.attachment;
    const v = this.vertices;
    if (att instanceof this.spine.RegionAttachment) {
      v.length = 8;
      att.computeWorldVertices(slot, v, 0, 2);
      return { vertices: v, triangles: [[0, 1, 2], [2, 3, 0]], hull: v.slice() };
    }
    if (att instanceof this.spine.MeshAttachment) {
      v.length = att.worldVerticesLength;
      att.computeWorldVertices(slot, 0, att.worldVerticesLength, v, 0, 2);
      const triangles: [number, number, number][] = [];
      for (let i = 0; i < att.triangles.length; i += 3) {
        triangles.push([att.triangles[i], att.triangles[i + 1], att.triangles[i + 2]]);
      }
      return { vertices: v, triangles, hull: v.slice(0, att.hullLength) };
    }
    return null;
  }

  private isDrawable(att: Attachment) {
    return att instanceof this.spine.RegionAttachment || att instanceof this.spine.MeshAttachment;
  }

  /** Wraps each drawable attachment so part offsets apply to its world vertices. */
  private patchAttachments() {
    const done = new Set<Attachment>();
    const offsetPart = this.offsetPart.bind(this);
    for (const skin of this.skeleton.data.skins) {
      for (const { attachment: att } of skin.getAttachments()) {
        if (done.has(att)) continue;
        done.add(att);
        if (att instanceof this.spine.RegionAttachment) {
          const compute = att.computeWorldVertices.bind(att);
          att.computeWorldVertices = (slot, out, offset, stride) => {
            compute(slot, out, offset, stride);
            offsetPart(slot, out, offset, stride, 4);
          };
        } else if (att instanceof this.spine.MeshAttachment) {
          const compute = att.computeWorldVertices.bind(att);
          att.computeWorldVertices = (slot, start, count, out, offset, stride) => {
            compute(slot, start, count, out, offset, stride);
            offsetPart(slot, out, offset, stride, count >> 1);
          };
        }
      }
    }
  }

  /** Moves, scales and rotates a part around its centre. The offset follows the part's bone. */
  private offsetPart(slot: Slot, out: NumberArrayLike, offset: number, stride: number, count: number) {
    const part = this.tweaks.parts[slot.data.name];
    if (!part || (part.dx === 0 && part.dy === 0 && part.scale === 1 && part.rotation === 0) || count === 0) return;

    let cx = 0;
    let cy = 0;
    for (let i = 0, j = offset; i < count; i++, j += stride) {
      cx += out[j];
      cy += out[j + 1];
    }
    cx /= count;
    cy /= count;

    const bone = slot.bone;
    const det = bone.a * bone.d - bone.b * bone.c;
    const unit = Math.sqrt(Math.abs(det)) || 1;
    const ux = (part.dx / 100) * this.rigSize;
    const uy = (part.dy / 100) * this.rigSize;
    const ox = (bone.a * ux + bone.b * uy) / unit;
    const oy = (bone.c * ux + bone.d * uy) / unit;
    const angle = ((part.rotation * Math.PI) / 180) * (det < 0 ? -1 : 1);
    const cos = Math.cos(angle) * part.scale;
    const sin = Math.sin(angle) * part.scale;

    for (let i = 0, j = offset; i < count; i++, j += stride) {
      const x = out[j] - cx;
      const y = out[j + 1] - cy;
      out[j] = cx + ox + x * cos - y * sin;
      out[j + 1] = cy + oy + x * sin + y * cos;
    }
  }

  /** Swaps in colors, visibility and blend modes for the draw call only. */
  private wrapDraw() {
    const renderer = this.player.sceneRenderer;
    if (!renderer) return;
    const draw = renderer.drawSkeleton.bind(renderer);
    renderer.drawSkeleton = (...args) => {
      if (this.hideSkin()) return;
      this.withOverrides(args[0], () => draw(...args));
    };
  }

  private withOverrides(skeleton: Skeleton, draw: () => void) {
    const t = this.tweaks;
    const color = skeleton.color;
    const { r, g, b, a } = color;
    const tint = this.color(t.tint);
    color.set(r * tint.r, g * tint.g, b * tint.b, a * t.alpha);

    const globalBlend = blendMode(this.spine, t.blend);
    const parts = t.parts;
    if (!t.shadow && globalBlend === null && Object.keys(parts).length === 0) {
      draw();
      color.set(r, g, b, a);
      return;
    }

    const slots = skeleton.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const part = parts[slot.data.name];
      const save = (this.saved[i] ??= { attachment: null, r: 0, g: 0, b: 0, a: 0, dark: null, blend: 0 });
      save.attachment = slot.attachment;
      save.r = slot.color.r;
      save.g = slot.color.g;
      save.b = slot.color.b;
      save.a = slot.color.a;
      save.dark = slot.darkColor;
      save.blend = slot.data.blendMode;

      if (part?.hidden) slot.attachment = null;
      if (part?.color) {
        const c = this.color(part.color);
        slot.color.set(save.r * c.r, save.g * c.g, save.b * c.b, save.a);
      }
      const shadow = part?.shadow ?? t.shadow;
      if (shadow) slot.darkColor = (this.darkColors[i] ??= new this.spine.Color()).setFromColor(this.color(shadow));
      const blend = part && part.blend !== "rig" ? blendMode(this.spine, part.blend) : globalBlend;
      if (blend !== null) slot.data.blendMode = blend;
    }

    draw();

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const save = this.saved[i];
      slot.attachment = save.attachment;
      slot.color.set(save.r, save.g, save.b, save.a);
      slot.darkColor = save.dark;
      slot.data.blendMode = save.blend;
    }
    color.set(r, g, b, a);
  }

  private color(hex: string): Color {
    let c = this.colors.get(hex);
    if (!c) {
      c = new this.spine.Color().setFromString(hex);
      this.colors.set(hex, c);
    }
    return c;
  }

  private applySkins(names: string[] | null) {
    const data = this.skeleton.data;
    const skins = (names ?? []).map((n) => data.findSkin(n)).filter((s): s is Skin => s !== null);
    let skin = this.baseSkin;
    if (skins.length === 1) skin = skins[0];
    else if (skins.length > 1) {
      skin = new this.spine.Skin("remix-tweaks");
      for (const s of skins) skin.addSkin(s);
    }
    this.skeleton.setSkin(skin);
    this.skeleton.setSlotsToSetupPose();
    this.player.animationState?.apply(this.skeleton);
  }

  /** Re-frames the camera for the current animation, e.g. after a flip moves the rig. */
  private refit() {
    const animation = this.player.animationState?.getCurrent(0)?.animation;
    if (animation) this.player.setViewport(animation);
  }

  private applyFilters(pixelated: boolean) {
    const atlas = this.player.assetManager?.require(this.atlasUrl) as TextureAtlas | undefined;
    const { TextureFilter } = this.spine;
    for (const page of atlas?.pages ?? []) {
      if (pixelated) page.texture?.setFilters(TextureFilter.Nearest, TextureFilter.Nearest);
      else page.texture?.setFilters(page.minFilter, page.magFilter);
    }
  }

  private applyBones(tweaks: SpineTweaks["bones"]) {
    for (const bone of this.skeleton.bones) {
      const tweak = tweaks[bone.data.name];
      let setup = this.boneSetup.get(bone.data);
      if (!tweak && !setup) continue;
      if (!setup) {
        setup = { rotation: bone.data.rotation, scaleX: bone.data.scaleX, scaleY: bone.data.scaleY };
        this.boneSetup.set(bone.data, setup);
      }
      const t = tweak ?? DEFAULT_BONE;
      bone.data.rotation = setup.rotation + t.rotation;
      bone.data.scaleX = setup.scaleX * t.scaleX;
      bone.data.scaleY = setup.scaleY * t.scaleY;
      // Bones the animation doesn't key keep their current pose, so set it too.
      bone.rotation = bone.data.rotation;
      bone.scaleX = bone.data.scaleX;
      bone.scaleY = bone.data.scaleY;
    }
  }

  /** Overrides constraint values each frame while any are tweaked, then resets them once. */
  private applyConstraints() {
    const t = this.tweaks;
    const custom =
      t.physicsMix !== 1 ||
      t.wind !== 0 ||
      t.gravity !== 0 ||
      t.stiffness !== 1 ||
      t.ikMix !== 1 ||
      t.ikFlip ||
      t.transformMix !== 1;
    if (!custom && !this.constraintsTouched) return;
    this.constraintsTouched = custom;

    const force = this.rigSize * PHYSICS_FORCE_SCALE;
    for (const pc of this.skeleton.physicsConstraints) {
      pc.mix = pc.data.mix * t.physicsMix;
      pc.wind = pc.data.wind + t.wind * force;
      pc.gravity = pc.data.gravity + t.gravity * force;
      pc.strength = pc.data.strength * t.stiffness;
    }
    for (const ik of this.skeleton.ikConstraints) {
      ik.mix = ik.data.mix * t.ikMix;
      ik.bendDirection = ik.data.bendDirection * (t.ikFlip ? -1 : 1);
    }
    const m = t.transformMix;
    for (const tc of this.skeleton.transformConstraints) {
      tc.mixRotate = tc.data.mixRotate * m;
      tc.mixX = tc.data.mixX * m;
      tc.mixY = tc.data.mixY * m;
      tc.mixScaleX = tc.data.mixScaleX * m;
      tc.mixScaleY = tc.data.mixScaleY * m;
      tc.mixShearY = tc.data.mixShearY * m;
    }
  }

  /** Jolts the skeleton sideways so physics constraints swing. */
  private shake(kick: number) {
    const side = kick % 2 === 0 ? -1 : 1;
    this.skeleton.physicsTranslate(side * this.rigSize * 0.15, this.rigSize * 0.05);
  }
}

function blendMode(spine: Spine, mode: TweakBlendMode): BlendMode | null {
  switch (mode) {
    case "normal":
      return spine.BlendMode.Normal;
    case "additive":
      return spine.BlendMode.Additive;
    case "multiply":
      return spine.BlendMode.Multiply;
    case "screen":
      return spine.BlendMode.Screen;
    default:
      return null;
  }
}

function sameList(a: string[] | null, b: string[] | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function inTriangle(px: number, py: number, v: number[], [i, j, k]: [number, number, number]) {
  const ax = v[i * 2], ay = v[i * 2 + 1];
  const bx = v[j * 2], by = v[j * 2 + 1];
  const cx = v[k * 2], cy = v[k * 2 + 1];
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
