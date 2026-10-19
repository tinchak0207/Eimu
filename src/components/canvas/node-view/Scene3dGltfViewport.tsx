"use client";

// Scene3dGltfViewport —— 3D 场景卡「3D 预览」资产模式视口（2026-09-06 片P）。
//
// 轮子 = @/lib/director-engine/engine（DirectorMiniViewport.tsx 同款挂载形：
// 动态 import（three 不入 SSR 主 bundle）→ new DirectorEngine → ResizeObserver
// → engine.resize()；unmount → engine.dispose()）。与导演台视口的差异只有数据
// 源一件：本视口不拉 director state/plan（白模预演数据），改走片E资产模式
// engine.setGltfAsset(url) 显示 Blender 真资产；白模 mannequin 共存为引擎默认，
// 本组件不做任何元素可见性切换（P1 只读范围，无切换开关）。
//
// glb 通路：GLTFLoader 内建 fetch 带不了站内 Bearer 头（token 在 localStorage，
// 不在 cookie），故本组件先 fetch(blenderArtifactUrl, { headers: authHeaders() })
// 拉 bytes → blob URL → engine.setGltfAsset(blobUrl)。鉴权与 canvas client 同款
// （authHeaders：LOCAL_TEST_MODE 假头 / 真用户 Bearer+x-user-id）。
//
// 画布手势隔离：data-canvas-interactive 放行 + wheel stopPropagation，
// 与 DirectorMiniViewport 同款（防 InfiniteCanvas 容器级 wheel 缩放连动）。

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { authHeaders } from "@/lib/canvas/client";
import { cn } from "@/lib/utils";

/**
 * 拉 glb bytes → blob URL。两条来源：
 *   - 站内桥产物（导演卡）：走 `/api/blender-artifact?name=` 代读，**必带 authHeaders**
 *     （历史坑：裸 fetch 401 静默 → 视口永远空）。
 *   - 公网物件存储（本机导入卡，2026-09-27）：glb_path 本身是 http(s) URL，直连拉取。
 *     **不带 Authorization**——token 只送本站 origin，禁止外泄到第三方主机。
 */
async function fetchGltfAsBlobUrl(glbPath: string): Promise<string> {
  const headers = authHeaders();
  if (!headers) throw new Error("尚未登录，无法加载 3D 预览");
  const remote = /^https?:\/\//i.test(glbPath);
  const url = remote
    ? glbPath
    : `/api/blender-artifact?name=${encodeURIComponent(glbPath.split("/").filter(Boolean).pop() ?? "")}`;
  const resp = await fetch(url, remote ? { cache: "no-store" } : { cache: "no-store", headers });
  if (!resp.ok) {
    let detail = "";
    try {
      const json = (await resp.json()) as { error?: string; code?: string };
      detail = json?.error ? `（${json.error}）` : "";
    } catch {
      // 非 JSON 错误体（如 401 HTML）保持空 detail，不让 parse 异常盖掉状态码
    }
    throw new Error(`模型文件获取失败 ${resp.status}${detail}`);
  }
  const blob = await resp.blob();
  if (blob.size === 0) throw new Error("模型文件为空（0 字节）");
  return URL.createObjectURL(blob);
}

type GltfViewportPhase = "loading" | "ready" | "fallback";

export interface Scene3dGltfViewportProps {
  /** sceneCard.glb_path：站内桥产物路径（取纯档名走 /api/blender-artifact 代理）或 http(s) 公网 URL（直连）。 */
  glbPath: string;
  className?: string;
}

export function Scene3dGltfViewport({ glbPath, className }: Scene3dGltfViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<import("@/lib/director-engine/engine").DirectorEngine | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<GltfViewportPhase>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);

  const disposeEngine = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let loaded = false;

    void (async () => {
      try {
        // three.js 只在这里进动态 chunk（DirectorMiniViewport 同款）。
        const mod = await import("@/lib/director-engine/engine");
        if (disposed) return;
        const blobUrl = await fetchGltfAsBlobUrl(glbPath);
        if (disposed) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        blobUrlRef.current = blobUrl;
        const engine = new mod.DirectorEngine(container);
        engineRef.current = engine;
        engine.onGltfAssetError = (message, stage) => {
          // 片E 结构化错误 → 人话提示（含 glb 路径，方便定位是哪个资产）
          console.warn("[sgv] gltf asset error:", stage, message);
          if (!disposed) {
            setErrorText(`3D 资产加载失败：${message}（模型：${glbPath}）`);
            setPhase("fallback");
          }
        };
        observer = new ResizeObserver(() => engine.resize());
        observer.observe(container);
        const outcome = await engine.setGltfAsset(blobUrl);
        if (disposed) return;
        if (outcome?.ok) {
          loaded = true;
          setPhase("ready");
        } else if (!outcome) {
          // url=null（理论上不会发生：blobUrl 非空）防御分支
          setErrorText(`3D 资产加载失败：模型地址无效（模型：${glbPath}）`);
          setPhase("fallback");
        }
        // outcome 非 ok 时 setGltfAsset 内部已触发 onGltfAssetError → fallback
      } catch (err) {
        console.warn("[sgv] gltf preview failed:", String(err).slice(0, 300));
        if (!disposed) {
          setErrorText(err instanceof Error ? err.message : `3D 预览加载失败（模型：${glbPath}）`);
          setPhase("fallback");
        }
      }
    })();

    // wheel 隔离：InfiniteCanvas 容器级 wheel 缩放不连动（DirectorMiniViewport 同款）。
    const stopWheel = (event: WheelEvent) => event.stopPropagation();
    container.addEventListener("wheel", stopWheel);

    return () => {
      disposed = true;
      container.removeEventListener("wheel", stopWheel);
      observer?.disconnect();
      disposeEngine();
      // 卸载时清错误态；loaded 标记留给除错（避免 lint 未使用告警）
      void loaded;
      setPhase("loading");
      setErrorText(null);
    };
  }, [glbPath, disposeEngine]);

  const swallowPointer = (event: ReactPointerEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div
      data-canvas-interactive=""
      onPointerDown={swallowPointer}
      onPointerMove={swallowPointer}
      onPointerUp={swallowPointer}
      onPointerCancel={swallowPointer}
      onDoubleClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
      className={cn("relative touch-none select-none overflow-hidden rounded-[12px] bg-[#0b0f14]", className)}
    >
      {/* engine 挂载点：renderer canvas 由 DirectorEngine appendChild 进来 */}
      <div ref={containerRef} className="absolute inset-0" />

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <div className="animate-pulse h-full w-full bg-white/[0.06]" />
        </div>
      )}

      {phase === "fallback" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4">
          <span className="text-ios-caption1 text-white/45">3D 预览不可用</span>
          {errorText && <span className="text-ios-caption2 text-center leading-snug text-white/70">{errorText}</span>}
        </div>
      )}
    </div>
  );
}
