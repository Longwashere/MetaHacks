import "@esotericsoftware/spine-player/dist/spine-player.css";
import type { SpinePlayer, SpinePlayerConfig, TextureAtlas } from "@esotericsoftware/spine-player";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useInView } from "~/hooks/use-in-view";
import { skelToJson } from "~/lib/spine-skel-json";
import { bakeTweaks } from "~/lib/spine-tweak-bake";
import { TweakController } from "~/lib/spine-tweak-controller";
import { DEFAULT_TWEAKS, type SpineTweakBinding } from "~/lib/spine-tweaks";
import type { SpineAssetFiles } from "~/lib/types";
import { cn } from "~/lib/utils";

/** "still": the player isn't running, and a frame captured earlier stands in for it. */
export type SpineRuntimeStatus = "idle" | "loading" | "ready" | "still" | "error";

/**
 * Browsers keep about 16 WebGL contexts per page and silently kill the oldest past that, leaving
 * a blank canvas. Players beyond this cap wait for a slot (showing their still, if they have one).
 * The cap uses the whole budget (4 rows of 4 cards); a player whose context is still killed falls
 * back to its still.
 */
const MAX_LIVE_PLAYERS = 16;
let livePlayers = 0;
const waitingPlayers: Array<() => void> = [];

/** True once this component holds one of the live player slots; asks for one while `wanted`. */
function useLiveSlot(wanted: boolean) {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let held = false;
    const grant = () => {
      held = true;
      livePlayers++;
      setGranted(true);
    };
    if (livePlayers < MAX_LIVE_PLAYERS) grant();
    else waitingPlayers.push(grant);
    return () => {
      if (held) {
        livePlayers--;
        waitingPlayers.shift()?.();
      } else {
        const i = waitingPlayers.indexOf(grant);
        if (i >= 0) waitingPlayers.splice(i, 1);
      }
      setGranted(false);
    };
  }, [wanted]);
  return granted;
}

/** A captured frame per rig (and tint), shown while its player isn't running. Lives for the session. */
const stills = new Map<string, string>();
/** Milliseconds after the player is ready before capturing, so the viewport transition has settled. */
const STILL_DELAY_MS = 500;

function stillKeyOf(files: SpineAssetFiles, tint: string | null) {
  return `${files.skeletonUrl}|${files.atlasUrl}|${tint ?? ""}`;
}

/** Animation time shared between two players so they pose in step (the compare slider). */
export interface SpineClock {
  trackTime: number;
  reverse: boolean;
  /** performance.now() when the leading player last wrote it. */
  at: number;
}

/** The leading player writes the clock every frame; the following one copies it. */
export interface SpineClockSync {
  clock: SpineClock;
  lead: boolean;
}

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
  /** Live rig edits from the tweak panel. */
  tweaks?: SpineTweakBinding;
  /**
   * Page image URLs by atlas page name, swapped into the running player without reloading it
   * (the live remix view). Pages not listed show the atlas's own images.
   */
  pageUrls?: Record<string, string>;
  sync?: SpineClockSync;
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
  tweaks,
  pageUrls,
  sync,
  onStatusChange,
  className,
}: SpineRuntimeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<SpinePlayer | null>(null);
  const controllerRef = useRef<TweakController | null>(null);
  const spineRef = useRef<typeof import("@esotericsoftware/spine-player") | null>(null);
  /** Page image URL each atlas page shows, and the one it's loading, by page name. Reset with the player. */
  const shownPages = useRef(new Map<string, string>());
  const loadingPages = useRef(new Map<string, string>());
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
  const latest = useRef({ animation, loop, playing, speed, tint, hideSkin, boneColor, showLabels, tweaks, pageUrls, sync });
  const [status, setStatus] = useState<SpineRuntimeStatus>("idle");
  // Visible only, no margin: slots are scarce, and stills cover cards scrolling in.
  const inView = useInView(containerRef, "0px");
  // The browser dropped this player's context; stay on the still until it scrolls out and back.
  const [lost, setLost] = useState(false);
  const live = useLiveSlot(inView && !lost);
  const still = stills.get(stillKeyOf(files, tint));
  const shownStatus = status !== "ready" && status !== "error" && still ? "still" : status;
  const readyAt = useRef(0);

  useEffect(() => {
    if (!inView) setLost(false);
  }, [inView]);

  useEffect(() => {
    latest.current = { animation, loop, playing, speed, tint, hideSkin, boneColor, showLabels, tweaks, pageUrls, sync };
  });

  useEffect(() => {
    onStatusChange?.(shownStatus);
  }, [shownStatus, onStatusChange]);

  // Create / dispose the player.
  useEffect(() => {
    const container = containerRef.current;
    if (!live || !container) return;
    let cancelled = false;
    setStatus("loading");

    import("@esotericsoftware/spine-player").then((spine) => {
      const { SpinePlayer, Vector3, Physics } = spine;
      if (cancelled) return;
      spineRef.current = spine;
      shownPages.current.clear();
      loadingPages.current.clear();
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
        updateWorldTransform: (player) => {
          if (controllerRef.current) controllerRef.current.pose(Physics.update);
          else player.skeleton?.updateWorldTransform(Physics.update);
        },
        frame: (player, delta) => {
          const sync = latest.current.sync;
          const state = player.animationState;
          const entry = state?.getCurrent(0);
          if (!sync || sync.lead || !state || !entry || !player.skeleton) return;
          const { clock } = sync;
          entry.reverse = clock.reverse;
          if (player.paused) {
            // Paused players skip posing, so pose at the leader's time here.
            entry.trackTime = clock.trackTime;
            state.apply(player.skeleton);
            player.skeleton.updateWorldTransform(Physics.pose);
          } else {
            // This frame's update adds delta. If the leader already ticked this frame its time
            // is current; otherwise it's about to add its own delta too.
            const fresh = performance.now() - clock.at < 4;
            entry.trackTime = Math.max(0, clock.trackTime - (fresh ? delta : 0));
          }
        },
        update: (player) => {
          controllerRef.current?.frame();
          const sync = latest.current.sync;
          const entry = player.animationState?.getCurrent(0);
          if (sync?.lead && entry) {
            sync.clock.trackTime = entry.trackTime;
            sync.clock.reverse = entry.reverse;
            sync.clock.at = performance.now();
          }
        },
        draw: (player) => {
          // The frame was just rendered, so the drawing buffer can be read without preserving it.
          // Capture only the plain look: no debug drawing, part edits or swapped pages.
          const { hideSkin, showLabels, tweaks, pageUrls, tint } = latest.current;
          const plain = !hideSkin && !showLabels && !tweaks && !pageUrls && !debugRef.current.bones;
          const key = stillKeyOf(files, tint);
          if (plain && readyAt.current && !stills.has(key) && performance.now() - readyAt.current > STILL_DELAY_MS) {
            try {
              stills.set(key, player.canvas!.toDataURL("image/webp", 0.85));
            } catch {
              // A tainted canvas can't be read; keep going without a still.
            }
          }

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

          const selectedPart = latest.current.tweaks?.selectedPart ?? null;
          if (!latest.current.showLabels && !selectedPart) {
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

          const outline = selectedPart ? controllerRef.current?.outline(selectedPart) : null;
          if (outline && outline.length >= 6) {
            ctx.beginPath();
            for (let i = 0; i < outline.length; i += 2) {
              vec.set(outline[i], outline[i + 1], 0);
              (camera as unknown as { worldToScreen: (v: unknown, w: number, h: number) => void }).worldToScreen(vec, displayW, displayH);
              if (i === 0) ctx.moveTo(vec.x, displayH - vec.y);
              else ctx.lineTo(vec.x, displayH - vec.y);
            }
            ctx.closePath();
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#f8fafc";
            ctx.stroke();
            ctx.lineDashOffset = 3.5;
            ctx.strokeStyle = "#0f172a";
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (!latest.current.showLabels) {
            ctx.restore();
            return;
          }

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
          if (!playing || latest.current.tweaks?.tweaks.scrub != null) player.pause();

          // Configure skeleton debug renderer line color and width
          const sdr = (player as unknown as { sceneRenderer?: { skeletonDebugRenderer?: { boneWidth: number; boneLineColor: { set: (r: number, g: number, b: number, a: number) => void } } } }).sceneRenderer?.skeletonDebugRenderer;
          if (sdr) {
            sdr.boneWidth = 2.5;
            applyBoneLineColor(sdr, latest.current.boneColor);
          }

          const controller = new TweakController(spine, player, files.atlasUrl, latest.current.tweaks?.tweaks ?? DEFAULT_TWEAKS);
          controller.hideSkin = () => latest.current.hideSkin;
          controllerRef.current = controller;
          latest.current.tweaks?.onRigInfo(controller.info());
          latest.current.tweaks?.onExporter?.({
            exportSkeleton: async (values) => {
              const res = await fetch(files.skeletonUrl);
              if (!res.ok) throw new Error(`Couldn't load the skeleton file (${res.status}).`);
              // Binary rigs are converted to JSON, which the bake edits; the remix then saves as JSON.
              const skeleton = files.skeletonUrl.toLowerCase().endsWith(".skel") ? skelToJson(await res.arrayBuffer()) : await res.json();
              return bakeTweaks(skeleton, values, controller.setupPose(values));
            },
          });

          readyAt.current = performance.now();
          setStatus("ready");
        },
        error: (_player, message) => {
          if (cancelled) return;
          console.warn(`[SpineRuntime] ${files.skeletonUrl}: ${message}`);
          setStatus("error");
        },
      });
      container.querySelector("canvas")?.addEventListener("webglcontextlost", () => {
        if (!cancelled) setLost(true);
      });
    });

    return () => {
      cancelled = true;
      readyAt.current = 0;
      // Free the GPU context immediately rather than waiting for GC.
      const canvas = container.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      playerRef.current?.dispose();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      playerRef.current = null;
      if (controllerRef.current) latest.current.tweaks?.onExporter?.(null);
      controllerRef.current = null;
      setStatus("idle");
    };
  }, [live, files.skeletonUrl, files.atlasUrl, files.skin, files.premultipliedAlpha]);

  // Swap page images in place. Every remix version keeps the atlas's regions, so only the
  // textures change; re-creating the player would flash and reset the animation.
  const pageKey = JSON.stringify(pageUrls ?? {});
  useEffect(() => {
    const player = playerRef.current;
    const spine = spineRef.current;
    if (status !== "ready" || !player?.assetManager || !spine) return;
    const urls: Record<string, string> = JSON.parse(pageKey);
    const atlas: TextureAtlas = player.assetManager.require(files.atlasUrl);
    const atlasDir = files.atlasUrl.slice(0, files.atlasUrl.lastIndexOf("/") + 1);
    for (const page of atlas.pages) {
      const url = urls[page.name] ?? atlasDir + page.name;
      const texture = page.texture;
      const current = loadingPages.current.get(page.name) ?? shownPages.current.get(page.name) ?? atlasDir + page.name;
      if (current === url || !(texture instanceof spine.GLTexture)) continue;
      loadingPages.current.set(page.name, url);
      const image = new Image();
      // Same CORS mode as the runtime's own loader, so cached responses are reused.
      image.crossOrigin = "anonymous";
      image.onload = () => {
        // A newer image for this page may have been asked for meanwhile, or the player replaced.
        if (playerRef.current !== player || loadingPages.current.get(page.name) !== url) return;
        loadingPages.current.delete(page.name);
        shownPages.current.set(page.name, url);
        // Texture keeps the image in a protected field, which update() uploads.
        (texture as unknown as { _image: HTMLImageElement })._image = image;
        texture.update(false);
        // Re-applies the page's filters and wraps, generating mipmaps when they ask for them.
        page.setTexture(texture);
      };
      image.onerror = () => {
        if (loadingPages.current.get(page.name) === url) loadingPages.current.delete(page.name);
      };
      image.src = url;
    }
  }, [status, pageKey, files.atlasUrl]);

  // Sync playback props into the running player.
  useEffect(() => {
    const player = playerRef.current;
    if (status !== "ready" || !player?.skeleton?.data.findAnimation(animation)) return;
    player.setAnimation(animation, loop);
    controllerRef.current?.onAnimationChanged();
  }, [status, animation, loop]);

  const holding = tweaks?.tweaks.scrub != null;
  useEffect(() => {
    const player = playerRef.current;
    if (status !== "ready" || !player) return;
    if (playing && !holding) player.play();
    else player.pause();
  }, [status, playing, holding]);

  const tweakValues = tweaks?.tweaks;
  useEffect(() => {
    const debug = tweakValues?.debug ?? DEFAULT_TWEAKS.debug;
    debugRef.current.meshes = debug.meshes;
    debugRef.current.regions = debug.regions;
    debugRef.current.bounds = debug.bounds;
    debugRef.current.clipping = debug.clipping;
    if (status === "ready" && tweakValues) controllerRef.current?.sync(tweakValues);
  }, [status, tweakValues]);

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

  const picking = Boolean(tweaks?.picking) && status === "ready";
  const pickAt = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const part = controllerRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height) ?? null;
    tweaks?.onPickPart(part);
  };

  return (
    // The pick layer is a pointer shortcut; the tweak panel's part list is the keyboard path.
    <div
      ref={containerRef}
      onClick={picking ? pickAt : undefined}
      className={cn(
        "absolute inset-0 transition-opacity duration-300",
        picking && "cursor-crosshair",
        // The player injects its own DOM here; make it fill the frame and drop its default background.
        "[&_.spine-player]:size-full [&_.spine-player]:bg-transparent!",
        shownStatus === "ready" || shownStatus === "still" ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {shownStatus === "still" && <img src={still} alt="" className="absolute inset-0 size-full object-contain" />}
      <canvas
        ref={overlayCanvasRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-10 size-full transition-opacity duration-200",
          showLabels || tweaks?.selectedPart ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
