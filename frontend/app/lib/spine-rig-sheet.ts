import type { SpineAssetFiles } from "~/lib/types";

// A labelled picture of a rig for Muse to look at before animating it: the rest pose with every
// bone named (IK targets orange, constraint-driven bones grey) beside four frames of the rig's own
// attack. Without it, Muse guessed the weapon from bone names (it swung the orc's shoulder pad)
// and struck behind the character's back. Browser only; loaded on demand like the Spine runtime.

const SIZE = 700;

export async function captureRigSheet(files: SpineAssetFiles, skeletonJson: object): Promise<string> {
  const spine = await import("@esotericsoftware/spine-player");
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = new spine.ManagedWebGLRenderingContext(canvas, { preserveDrawingBuffer: true, alpha: false });
  const renderer = new spine.SceneRenderer(canvas, context, true);
  const assets = new spine.AssetManager(context);
  try {
    assets.loadTextureAtlas(files.atlasUrl);
    await assets.loadAll();
    const atlas = assets.require(files.atlasUrl);
    const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonJson);
    const sk = new spine.Skeleton(data);
    if (files.skin) sk.setSkinByName(files.skin);

    const ref =
      data.animations.find((a) => /attack|slash|swing|strike/i.test(a.name)) ?? data.animations.find((a) => !/idle/i.test(a.name)) ?? data.animations[0] ?? null;
    const ikTargets = new Set(data.ikConstraints.map((c) => c.target.name));
    const driven = new Set([...data.ikConstraints, ...data.transformConstraints, ...data.pathConstraints].flatMap((c) => c.bones.map((b) => b.name)));

    const pose = (anim: InstanceType<typeof spine.Animation> | null, t: number) => {
      sk.setToSetupPose();
      if (anim) anim.apply(sk, 0, t, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      sk.updateWorldTransform(spine.Physics.pose);
    };
    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    /** Points the camera at the union of the poses' bounds; returns world → screen for labels. */
    const frame = (poses: [InstanceType<typeof spine.Animation> | null, number][]) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [anim, t] of poses) {
        pose(anim, t);
        sk.getBounds(offset, size, []);
        if (!Number.isFinite(offset.x)) continue;
        x0 = Math.min(x0, offset.x);
        y0 = Math.min(y0, offset.y);
        x1 = Math.max(x1, offset.x + size.x);
        y1 = Math.max(y1, offset.y + size.y);
      }
      const camera = renderer.camera;
      camera.position.x = (x0 + x1) / 2;
      camera.position.y = (y0 + y1) / 2;
      camera.zoom = Math.max((x1 - x0) / (SIZE * 0.8), (y1 - y0) / (SIZE * 0.8)) || 1;
      return {
        sx: (x: number) => SIZE / 2 + (x - camera.position.x) / camera.zoom,
        sy: (y: number) => SIZE / 2 - (y - camera.position.y) / camera.zoom,
      };
    };
    const render = () => {
      const gl = context.gl;
      gl.clearColor(0.93, 0.93, 0.93, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.begin();
      renderer.drawSkeleton(sk, files.premultipliedAlpha);
      renderer.end();
    };

    const out = document.createElement("canvas");
    out.width = SIZE * 2;
    out.height = SIZE;
    const o = out.getContext("2d");
    if (!o) throw new Error("No 2D canvas.");
    o.fillStyle = "#fff";
    o.fillRect(0, 0, out.width, out.height);

    // Left: the rest pose, every bone drawn and named.
    const m = frame([[null, 0]]);
    pose(null, 0);
    render();
    o.drawImage(canvas, 0, 0);
    const placed: [number, number][] = [];
    for (const b of sk.bones) {
      const len = b.data.length;
      const x = m.sx(b.worldX + b.a * len * 0.5);
      let y = m.sy(b.worldY + b.c * len * 0.5);
      o.strokeStyle = "rgba(0,0,0,0.35)";
      o.lineWidth = 1.5;
      o.beginPath();
      o.moveTo(m.sx(b.worldX), m.sy(b.worldY));
      o.lineTo(m.sx(b.worldX + b.a * len), m.sy(b.worldY + b.c * len));
      o.stroke();
      for (let k = 0; k < 6 && placed.some(([px, py]) => Math.abs(px - x) < 60 && Math.abs(py - y) < 11); k++) y += 11;
      placed.push([x, y]);
      const color = ikTargets.has(b.data.name) ? "#c25e00" : driven.has(b.data.name) ? "#888" : "#0b3a8c";
      o.font = "bold 11px sans-serif";
      o.lineWidth = 3;
      o.strokeStyle = "rgba(255,255,255,0.9)";
      o.strokeText(b.data.name, x + 3, y);
      o.fillStyle = color;
      o.fillText(b.data.name, x + 3, y);
      o.beginPath();
      o.arc(m.sx(b.worldX), m.sy(b.worldY), 2.5, 0, Math.PI * 2);
      o.fill();
    }
    o.fillStyle = "#000";
    o.font = "bold 16px sans-serif";
    o.fillText("REST POSE: bone names (orange = IK target, grey = driven by a constraint)", 10, 22);
    o.font = "13px sans-serif";
    o.fillText("screen axes: +x right, +y up", 10, 40);

    // Right: four frames of the rig's own attack, so the facing and the weapon hand are clear.
    if (ref) {
      const times = [0, 0.3, 0.55, 0.8].map((f) => f * ref.duration);
      frame(times.map((t) => [ref, t]));
      times.forEach((t, i) => {
        pose(ref, t);
        render();
        const px = SIZE + (i % 2) * (SIZE / 2);
        const py = Math.floor(i / 2) * (SIZE / 2);
        o.drawImage(canvas, px, py, SIZE / 2, SIZE / 2);
        o.strokeStyle = "#ccc";
        o.lineWidth = 1;
        o.strokeRect(px, py, SIZE / 2, SIZE / 2);
        o.fillStyle = "#000";
        o.font = "bold 13px sans-serif";
        o.fillText(`its own '${ref.name}' at ${t.toFixed(2)}s`, px + 8, py + 18);
      });
    }
    return out.toDataURL("image/jpeg", 0.85);
  } finally {
    assets.dispose();
    renderer.dispose();
    context.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
