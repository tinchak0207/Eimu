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
 * 拉 glb bytes → blob URL。三条来源：
 *   - 站内桥产物（导演卡）：走 `/api/blender-artifact?name=` 代读，**必带 authHeaders**
 *     （历史坑：裸 fetch 401 静默 → 视口永远空）。
 *   - 本站受保护端点（绝对 URL 但同源且路径在 /api/ 下，如赏阅把相对路径解析后传入）：
 *     与上一条同理，**必带 authHeaders**（头只送本站 origin）。
 *   - 公开资源（站外 http(s) URL，或同源非 /api/ 的静态文件，如 store 域 glb、/public 文件）：
 *     **既不要求登录也不发送登录头**——赏阅 `/view` 页对匿名访客开放；token 也绝不外泄到第三方主机。
 */
type GltfSource = { url: string; needsAuth: boolean };

function classifyGltfSource(glbPath: string): GltfSource {
  if (!/^https?:\/\//i.test(glbPath)) {
    return {
      url: `/api/blender-artifact?name=${encodeURIComponent(glbPath.split("/").filter(Boolean).pop() ?? "")}`,
      needsAuth: true,
    };
  }
  let sameOriginApi = false;
  try {
    const parsed = new URL(glbPath);
    sameOriginApi =
      typeof window !== "undefined" && parsed.origin === window.location.origin && /^\/api(\/|$)/.test(parsed.pathname);
  } catch {
    // URL 解析失败按公开资源处理（不带头），fetch 自会报错
  }
  return { url: glbPath, needsAuth: sameOriginApi };
}

async function fetchGltfAsBlobUrl(glbPath: string): Promise<string> {
  const source = classifyGltfSource(glbPath);
  let init: RequestInit = { cache: "no-store" };
  if (source.needsAuth) {
    const headers = authHeaders();
    if (!headers) throw new Error("尚未登录，无法加载 3D 预览");
    init = { cache: "no-store", headers };
  }
  let resp: Response;
  try {
    resp = await fetch(source.url, init);
  } catch {
    // 公开站外资源最常见的失败是对方未开放跨域（CORS）或网络不通；浏览器不给细分原因，如实说明可能性
    throw new Error(
      source.needsAuth
        ? "模型文件获取失败：网络不通，请重试"
        : "模型文件获取失败：网络不通，或该来源未开放跨域访问（CORS），请重试或下载后查看",
    );
  }
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

export type GltfViewportPhase = "loading" | "ready" | "fallback";

export interface Scene3dGltfViewportProps {
  /** sceneCard.glb_path：站内桥产物路径（取纯档名走 /api/blender-artifact 代理）或 http(s) 公网 URL（直连）。 */
  glbPath: string;
  className?: string;
  /** 可选（赏阅 3D 适配器用）：资产加载完成后交出引擎（读/设相机）；卸载或重载时回 null。向后兼容，不传＝无变化。 */
  onEngine?: (engine: import("@/lib/director-engine/engine").DirectorEngine | null) => void;
  /** 可选：加载阶段变化通知（赏阅据此显示可重试错误态）。 */
  onPhase?: (phase: GltfViewportPhase, errorText: string | null) => void;
}

export function Scene3dGltfViewport({ glbPath, className, onEngine, onPhase }: Scene3dGltfViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<import("@/lib/director-engine/engine").DirectorEngine | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<GltfViewportPhase>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const onEngineRef = useRef(onEngine);
  onEngineRef.current = onEngine;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  useEffect(() => {
    onPhaseRef.current?.(phase, errorText);
  }, [phase, errorText]);

  const disposeEngine = useCallback(() => {
    onEngineRef.current?.(null);
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
          onEngineRef.current?.(engine);
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
