"use client";

// Scene3dGltfViewport —— 3D 場景卡「3D 预览」資產模式視口（2026-09-06 片P）。
//
// 輪子 = @/lib/director-engine/engine（DirectorMiniViewport.tsx 同款掛載形：
// 動態 import（three 不入 SSR 主 bundle）→ new DirectorEngine → ResizeObserver
// → engine.resize()；unmount → engine.dispose()）。與導演台視口的差異只有數據
// 源一件：本視口不拉 director state/plan（白模預演數據），改走片E資產模式
// engine.setGltfAsset(url) 顯示 Blender 真資產；白模 mannequin 共存為引擎默認，
// 本組件不做任何元素可見性切換（P1 只讀範圍，無切換開關）。
//
// glb 通路：GLTFLoader 內建 fetch 帶不了站內 Bearer 頭（token 在 localStorage，
// 不在 cookie），故本組件先 fetch(blenderArtifactUrl, { headers: authHeaders() })
// 拉 bytes → blob URL → engine.setGltfAsset(blobUrl)。鑑權與 canvas client 同款
// （authHeaders：LOCAL_TEST_MODE 假頭 / 真用戶 Bearer+x-user-id）。
//
// 畫布手勢隔離：data-canvas-interactive 放行 + wheel stopPropagation，
// 與 DirectorMiniViewport 同款（防 InfiniteCanvas 容器級 wheel 縮放連動）。

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { authHeaders } from "@/lib/canvas/client";
import { cn } from "@/lib/utils";

/** 鑑權拉取 .blender-work 產物（站內代理分支：/api/blender-artifact?name=）。 */
async function fetchGltfAsBlobUrl(glbPath: string): Promise<string> {
  const name = glbPath.split("/").filter(Boolean).pop() ?? "";
  const headers = authHeaders();
  if (!headers) throw new Error("尚未登录，无法加载 3D 预览");
  const resp = await fetch(`/api/blender-artifact?name=${encodeURIComponent(name)}`, { cache: "no-store", headers });
  if (!resp.ok) {
    let detail = "";
    try {
      const json = (await resp.json()) as { error?: string; code?: string };
      detail = json?.error ? `（${json.error}）` : "";
    } catch {
      // 非 JSON 錯誤體（如 401 HTML）保持空 detail，不讓 parse 異常蓋掉狀態碼
    }
    throw new Error(`模型文件获取失败 ${resp.status}${detail}`);
  }
  const blob = await resp.blob();
  if (blob.size === 0) throw new Error("模型文件为空（0 字节）");
  return URL.createObjectURL(blob);
}

type GltfViewportPhase = "loading" | "ready" | "fallback";

export interface Scene3dGltfViewportProps {
  /** sceneCard.glb_path（站內路徑或 http URL；取純檔名走代理分支）。 */
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
        // three.js 只在這裡進動態 chunk（DirectorMiniViewport 同款）。
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
          // 片E 結構化錯誤 → 人話提示（含 glb 路徑，方便定位是哪個資產）
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
          // url=null（理論上不會發生：blobUrl 非空）防禦分支
          setErrorText(`3D 资产加载失败：模型地址无效（模型：${glbPath}）`);
          setPhase("fallback");
        }
        // outcome 非 ok 時 setGltfAsset 內部已觸發 onGltfAssetError → fallback
      } catch (err) {
        console.warn("[sgv] gltf preview failed:", String(err).slice(0, 300));
        if (!disposed) {
          setErrorText(err instanceof Error ? err.message : `3D 预览加载失败（模型：${glbPath}）`);
          setPhase("fallback");
        }
      }
    })();

    // wheel 隔離：InfiniteCanvas 容器級 wheel 縮放不連動（DirectorMiniViewport 同款）。
    const stopWheel = (event: WheelEvent) => event.stopPropagation();
    container.addEventListener("wheel", stopWheel);

    return () => {
      disposed = true;
      container.removeEventListener("wheel", stopWheel);
      observer?.disconnect();
      disposeEngine();
      // 卸載時清錯誤態；loaded 標記留給除錯（避免 lint 未使用告警）
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
      {/* engine 掛載點：renderer canvas 由 DirectorEngine appendChild 進來 */}
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
