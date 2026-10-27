import "@esotericsoftware/spine-player/dist/spine-player.css";
import type { SpinePlayer, SpinePlayerConfig } from "@esotericsoftware/spine-player";
import { useEffect, useRef, useState } from "react";
import { useInView } from "~/hooks/use-in-view";
import type { SpineAssetFiles } from "~/lib/types";
import { cn } from "~/lib/utils";

export type SpineRuntimeStatus = "idle" | "loading" | "ready" | "error";

interface SpineRuntimeProps {
  files: SpineAssetFiles;
  animation: string;
  loop: boolean;
  playing: boolean;
  speed: number;
  showBones: boolean;
  /** When true, only the skeleton / rig is drawn and the skin textures are hidden. */
  hideSkin?: boolean;
  /** Hex color for the bone rig lines (e.g. "#ef4444"). */
  boneColor?: string;
  /** When true, renders floating tags labeling each bone on the skeleton. */
  showLabels?: boolean;
  /** Hex color multiplied over the textures (mock remixes). */
  tint: string | null;
  onStatusChange?: (status: SpineRuntimeStatus) => void;
  className?: string;
}

type DebugFlags = NonNullable<SpinePlayerConfig["debug"]>;

function applyBoneLineColor(sdr: any, hex?: string) {
  if (!sdr?.boneLineColor || !hex) return;
  const clean = hex.replace("#", "");
  if (clean.length === 6) {
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    sdr.boneLineColor.set(r, g, b, 1);
  }
}

/**
 * Renders a real Spine skeleton with the official web player (WebGL).
 * The runtime is imported lazily on the client and only mounted while the
 * element is near the viewport, so grids don't exhaust WebGL contexts.
 */
export function SpineRuntime({
  files,
  animation,
  loop,
  playing,
  speed,
  showBones,
  hideSkin = false,
  boneColor,
  showLabels = false,
  tint,
  onStatusChange,
  className,
}: SpineRuntimeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<SpinePlayer | null>(null);
  const tempVec = useRef<{ set: (x: number, y: number, z: number) => void; x: number; y: number } | null>(null);

  // The player reads config.debug every frame, so mutating this object toggles debug drawing.
  const debugRef = useRef<DebugFlags>({
    bones: false,
    regions: false,
    meshes: false,
    bounds: false,
    paths: false,
    clipping: false,
    points: false,
    hulls: false,
  });
  // Lets the (async) callbacks see the latest props without re-creating the player.
  const latest = useRef({ animation, loop, playing, speed, tint, hideSkin, boneColor, showLabels });
  const [status, setStatus] = useState<SpineRuntimeStatus>("idle");
  const inView = useInView(containerRef);

  useEffect(() => {
    latest.current = { animation, loop, playing, speed, tint, hideSkin, boneColor, showLabels };
  });

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Create / dispose the player.
  useEffect(() => {
    const container = containerRef.current;
    if (!inView || !container) return;
    let cancelled = false;
    setStatus("loading");

    import("@esotericsoftware/spine-player").then(({ SpinePlayer, Vector3 }) => {
      if (cancelled) return;
      tempVec.current = new Vector3();

      playerRef.current = new SpinePlayer(container, {
        skeleton: files.skeletonUrl,
        atlas: files.atlasUrl,
        skin: files.skin ?? undefined,
        premultipliedAlpha: files.premultipliedAlpha,
        animation: latest.current.animation,
        showControls: false,
        showLoading: false,
        interactive: false,
        alpha: true,
        backgroundColor: "#00000000",
        preserveDrawingBuffer: false,
        debug: debugRef.current,
        viewport: { padLeft: "8%", padRight: "8%", padTop: "8%", padBottom: "8%", transitionTime: 0.25 },
        draw: (player) => {
          const overlay = overlayCanvasRef.current;
          if (!overlay) return;
          const ctx = overlay.getContext("2d");
          if (!ctx) return;

          const glCanvas = player.canvas;
          if (!glCanvas) return;

          const dpr = window.devicePixelRatio || 1;
          const displayW = glCanvas.clientWidth;
          const displayH = glCanvas.clientHeight;
          if (displayW === 0 || displayH === 0) return;

          const physicalW = Math.round(displayW * dpr);
          const physicalH = Math.round(displayH * dpr);
          if (overlay.width !== physicalW || overlay.height !== physicalH) {
            overlay.width = physicalW;
            overlay.height = physicalH;
          }

          ctx.save();
          ctx.clearRect(0, 0, overlay.width, overlay.height);

          if (!latest.current.showLabels) {
            ctx.restore();
            return;
          }

          const camera = player.sceneRenderer?.camera;
          const skeleton = player.skeleton;
          const vec = tempVec.current;
          if (!camera || !skeleton || !vec) {
            ctx.restore();
            return;
          }

          ctx.scale(dpr, dpr);

          const currentBoneColor = latest.current.boneColor || "#ef4444";
          const bones = skeleton.bones;

          ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
          ctx.textBaseline = "middle";

          for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const name = bone.data.name;
            if (!name) continue;

            vec.set(skeleton.x + bone.worldX, skeleton.y + bone.worldY, 0);
            (camera as unknown as { worldToScreen: (v: unknown, w: number, h: number) => void }).worldToScreen(vec, displayW, displayH);

            const screenX = vec.x;
            const screenY = displayH - vec.y;

            // Only draw if bone origin is on canvas
            if (screenX < -20 || screenX > displayW + 20 || screenY < -20 || screenY > displayH + 20) {
              continue;
            }

            const textWidth = ctx.measureText(name).width;
            const badgeW = textWidth + 16;
            const badgeH = 15;
            const badgeX = screenX + 6;
            const badgeY = screenY - 7;

            // Joint anchor dot
            ctx.beginPath();
            ctx.arc(screenX, screenY, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = currentBoneColor;
            ctx.fill();

            // Connector line from joint to badge
            ctx.beginPath();
            ctx.moveTo(screenX, screenY);
            ctx.lineTo(badgeX, badgeY + badgeH / 2);
            ctx.strokeStyle = currentBoneColor + "99";
            ctx.lineWidth = 1;
            ctx.stroke();

            // Label pill background
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3.5);
            } else {
              ctx.rect(badgeX, badgeY, badgeW, badgeH);
            }
            ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
            ctx.lineWidth = 1;
            ctx.stroke();

            // Little dot inside badge
            ctx.beginPath();
            ctx.arc(badgeX + 6, badgeY + badgeH / 2, 2, 0, Math.PI * 2);
            ctx.fillStyle = currentBoneColor;
            ctx.fill();

            // Bone name text
            ctx.fillStyle = "#f8fafc";
            ctx.fillText(name, badgeX + 11, badgeY + badgeH / 2 + 0.5);
          }

          ctx.restore();
        },
        success: (player) => {
          if (cancelled) return;
          const { animation, loop, playing, speed, tint, hideSkin } = latest.current;
          if (player.skeleton?.data.findAnimation(animation)) player.setAnimation(animation, loop);
          player.speed = speed;
          if (hideSkin) {
            player.skeleton?.color.set(0, 0, 0, 0);
          } else if (tint) {
            player.skeleton?.color.setFromString(tint);
          }
          if (!playing) player.pause();

          // Configure skeleton debug renderer line color and width
          const sdr = (player as unknown as { sceneRenderer?: { skeletonDebugRenderer?: { boneWidth: number; boneLineColor: { set: (r: number, g: number, b: number, a: number) => void } } } }).sceneRenderer?.skeletonDebugRenderer;
          if (sdr) {
            sdr.boneWidth = 2.5;
            applyBoneLineColor(sdr, latest.current.boneColor);
          }

          // Intercept drawSkeleton to dynamically skip drawing skin textures/meshes when hideSkin is true
          const sr = (player as unknown as { sceneRenderer?: { drawSkeleton: (...args: unknown[]) => void; _origDrawSkeleton?: (...args: unknown[]) => void } }).sceneRenderer;
          if (sr && !sr._origDrawSkeleton) {
            sr._origDrawSkeleton = sr.drawSkeleton.bind(sr);
            sr.drawSkeleton = function (...args: unknown[]) {
              if (latest.current.hideSkin) {
                return;
              }
              return sr._origDrawSkeleton?.apply(this, args);
            };
          }

          setStatus("ready");
        },
        error: (_player, message) => {
          if (cancelled) return;
          console.warn(`[SpineRuntime] ${files.skeletonUrl}: ${message}`);
          setStatus("error");
        },
      });
    });

    return () => {
      cancelled = true;
      // Free the GPU context immediately rather than waiting for GC.
      const canvas = container.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      playerRef.current?.dispose();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      playerRef.current = null;
      setStatus("idle");
    };
  }, [inView, files.skeletonUrl, files.atlasUrl, files.skin, files.premultipliedAlpha]);

  // Sync playback props into the running player.
  useEffect(() => {
    const player = playerRef.current;
    if (status !== "ready" || !player?.skeleton?.data.findAnimation(animation)) return;
    player.setAnimation(animation, loop);
  }, [status, animation, loop]);

  useEffect(() => {
    const player = playerRef.current;
    if (status !== "ready" || !player) return;
    if (playing) player.play();
    else player.pause();
  }, [status, playing]);

  useEffect(() => {
    if (playerRef.current) playerRef.current.speed = speed;
  }, [status, speed]);

  useEffect(() => {
    debugRef.current.bones = showBones || hideSkin;
  }, [showBones, hideSkin]);

  useEffect(() => {
    const sdr = (playerRef.current as unknown as { sceneRenderer?: { skeletonDebugRenderer?: unknown } })?.sceneRenderer?.skeletonDebugRenderer;
    if (status === "ready" && sdr) {
      applyBoneLineColor(sdr, boneColor);
    }
  }, [status, boneColor]);

  useEffect(() => {
    const color = playerRef.current?.skeleton?.color;
    if (status !== "ready" || !color) return;
    if (hideSkin) {
      color.set(0, 0, 0, 0);
    } else if (tint) {
      color.setFromString(tint);
    } else {
      color.set(1, 1, 1, 1);
    }
  }, [status, tint, hideSkin]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 transition-opacity duration-300",
        // The player injects its own DOM here; make it fill the frame and drop its default background.
        "[&_.spine-player]:size-full [&_.spine-player]:bg-transparent!",
        status === "ready" ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <canvas
        ref={overlayCanvasRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-10 size-full transition-opacity duration-200",
          showLabels ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
