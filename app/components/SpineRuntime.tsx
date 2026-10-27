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
  tint,
  onStatusChange,
  className,
}: SpineRuntimeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SpinePlayer | null>(null);
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
  // Lets the (async) success callback see the latest props without re-creating the player.
  const latest = useRef({ animation, loop, playing, speed, tint, hideSkin, boneColor });
  const [status, setStatus] = useState<SpineRuntimeStatus>("idle");
  const inView = useInView(containerRef);

  useEffect(() => {
    latest.current = { animation, loop, playing, speed, tint, hideSkin, boneColor };
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

    import("@esotericsoftware/spine-player").then(({ SpinePlayer }) => {
      if (cancelled) return;
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
    />
  );
}
