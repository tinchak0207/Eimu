"use client";

// 赏阅 · 3D 适配器：复用画布的 Scene3dGltfViewport（DirectorEngine + OrbitControls），
// 只负责经 controllerRef 发布「此刻相机」与「飞到某视角」。标签/措辞/存取在壳与评审层。
//
// active=false 时卸载视口（引擎 dispose＝rAF 停、GPU 资源释放），并记住最后视角；再激活后加载完成时还原。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, RefreshCw } from "lucide-react";
import { Scene3dGltfViewport, type GltfViewportPhase } from "@/components/canvas/node-view/Scene3dGltfViewport";
import type { DirectorEngine } from "@/lib/director-engine/engine";
import type { Locator, ViewerController, ViewerSurfaceProps } from "@/lib/viewer/types";
import { cn } from "@/lib/utils";

type PoseLocator = Extract<Locator, { t: "pose" }>;

const r2 = (n: number) => Math.round(n * 100) / 100;

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function readPose(engine: DirectorEngine): PoseLocator {
  const p = engine.getCameraPose();
  return {
    t: "pose",
    pos: [r2(p.position.x), r2(p.position.y), r2(p.position.z)],
    target: [r2(p.target.x), r2(p.target.y), r2(p.target.z)],
    fov: r2(p.fov),
  };
}

function writePose(engine: DirectorEngine, pose: PoseLocator): void {
  engine.applyShot({
    id: "viewer-pose",
    name: "viewer-pose",
    position: { x: pose.pos[0], y: pose.pos[1], z: pose.pos[2] },
    target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
    fov: pose.fov ?? engine.getCameraPose().fov,
    aspect: "16:9",
    createdAt: Date.now(),
  });
}

/** 落点补偿帧数：OrbitControls 开着阻尼（0.08/帧），拖动后残余惯性会在 applyShot 之后继续推相机；
 *  0.92^120 ≈ 4.5e-5，约 2 秒内衰减到可忽略。引擎语义不改（导演台共用），在此逐帧重申目标视角。 */
const SETTLE_FRAMES = 120;

export default function Scene3dSurface({
  asset,
  density,
  annotations,
  controllerRef,
  onRequestMark,
  active,
}: ViewerSurfaceProps) {
  const full = density === "full";
  const engineRef = useRef<DirectorEngine | null>(null);
  const pendingPoseRef = useRef<PoseLocator | null>(null);
  const settleCancelRef = useRef<(() => void) | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [phase, setPhase] = useState<GltfViewportPhase>("loading");
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [markedFlash, setMarkedFlash] = useState(false);

  useEffect(() => setWebgl(hasWebGL()), []);

  const url = useMemo(() => (asset.url ? resolveUrl(asset.url) : null), [asset.url]);

  /** 飞到某视角：立即写入，并在阻尼惯性衰减期内逐帧重申；用户一旦拖动/滚轮/触控即停止，不抢控制权。 */
  const flyTo = useCallback((engine: DirectorEngine, pose: PoseLocator) => {
    settleCancelRef.current?.();
    writePose(engine, pose);
    let frames = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("wheel", stop, true);
      window.removeEventListener("keydown", stop, true);
      if (settleCancelRef.current === stop) settleCancelRef.current = null;
    };
    const tick = () => {
      if (engineRef.current !== engine) return stop();
      writePose(engine, pose);
      frames += 1;
      if (frames >= SETTLE_FRAMES) return stop();
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("wheel", stop, true);
    window.addEventListener("keydown", stop, true);
    settleCancelRef.current = stop;
    raf = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => settleCancelRef.current?.(), []);

  const handleEngine = useCallback((engine: DirectorEngine | null) => {
    if (engine) {
      engineRef.current = engine;
      const pending = pendingPoseRef.current;
      if (pending) {
        flyTo(engine, pending);
        pendingPoseRef.current = null;
      }
    } else {
      settleCancelRef.current?.();
      // 卸载/重载前记下视角，下次加载完成后还原
      if (engineRef.current) pendingPoseRef.current = readPose(engineRef.current);
      engineRef.current = null;
    }
  }, [flyTo]);

  useEffect(() => {
    const controller: ViewerController = {
      capture() {
        const engine = engineRef.current;
        if (engine) return { locator: readPose(engine) };
        return { locator: pendingPoseRef.current ?? { t: "whole" } };
      },
      reveal(locator) {
        if (locator.t !== "pose") return;
        const engine = engineRef.current;
        if (engine) flyTo(engine, locator);
        else pendingPoseRef.current = locator;
      },
    };
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, flyTo]);

  const retry = useCallback(() => {
    setPhase("loading");
    setReloadKey((k) => k + 1);
  }, []);

  const mark = useCallback(() => {
    onRequestMark();
    setMarkedFlash(true);
    window.setTimeout(() => setMarkedFlash(false), 900);
  }, [onRequestMark]);

  const poseMarks = annotations.filter((a): a is typeof a & { locator: PoseLocator } => a.locator.t === "pose");

  const failMessage = !url
    ? "该 3D 成品没有可用的模型地址"
    : webgl === false
      ? "当前浏览器或设备不支持 WebGL，无法显示 3D 预览"
      : null;

  return (
    <div
      className={cn("relative flex w-full flex-col bg-[#0b0f14] outline-none", full ? "h-full min-h-[320px]" : "aspect-video")}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "f" || e.key === "F") {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          mark();
        }
      }}
      aria-label={`3D 预览：${asset.title ?? "未命名"}，拖动旋转，滚轮缩放，按 F 标记当前视角`}
    >
      <div className="relative min-h-0 flex-1">
        {failMessage ? (
          <ErrorBox message={failMessage} onRetry={url && webgl !== false ? retry : undefined} />
        ) : webgl === null ? null : active && url ? (
          <>
            <Scene3dGltfViewport
              key={reloadKey}
              glbPath={url}
              className="absolute inset-0 !rounded-none"
              onEngine={handleEngine}
              onPhase={(p) => setPhase(p)}
            />
            {phase === "fallback" && (
              <div className="absolute inset-x-0 bottom-4 flex justify-center">
                <button
                  type="button"
                  onClick={retry}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white/15 px-5 text-[14px] text-white hover:bg-white/25"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  重新加载
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-white/50">已暂停</div>
        )}
      </div>

      {!failMessage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/30 px-3 py-1.5">
          <button
            type="button"
            onClick={mark}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-[14px] text-white transition-colors",
              markedFlash ? "bg-emerald-500/70" : "bg-white/15 hover:bg-white/25",
            )}
          >
            <Crosshair className="h-4 w-4" aria-hidden="true" />
            标记此视角
          </button>
          {full && (
            <button
              type="button"
              onClick={retry}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-full px-3 text-[13px] text-white/70 hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              重新加载
            </button>
          )}
          {full && poseMarks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-white/60">
              <span>已标记视角</span>
              {poseMarks.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    const engine = engineRef.current;
                    if (engine) flyTo(engine, a.locator);
                  }}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 px-3 text-white hover:bg-white/20"
                  aria-label={`飞到第 ${i + 1} 个已标记视角`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto hidden text-[13px] text-white/40 sm:inline">拖动旋转 · 滚轮缩放 · 右键平移</span>
        </div>
      )}
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="text-[14px] text-white/80">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white/15 px-5 text-[14px] text-white hover:bg-white/25"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          重试
        </button>
      )}
    </div>
  );
}
