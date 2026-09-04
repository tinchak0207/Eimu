"use client";

// DirectorMiniViewport —— 導演台迷你 3D 視口（spec §9 片B 新膠水，非輪子）。
//
// 輪子 = @/lib/director-engine/engine（kunpeng DirectorEngine 逐行移植，
// three.js 白模場景/燈光/OrbitControls 自帶）。本檔只做四件事：
//   1. 掛載：useEffect 內動態 import（three 不入 SSR 主 bundle）→ new DirectorEngine
//      → ResizeObserver → engine.resize()；unmount → engine.dispose()。
//   2. 數據：GET /api/agent/sessions/<sid>/director/state（子路徑形，見 route.ts
//      GET_SUBPATHS）→ activePlan + elements → evaluateDirectorFrame(plan, elements, 0)
//      → engine.syncElements + applyCameraPose。revision prop 變化時重拉（後續變更
//      反映到已掛載視口）；播放中換數據不打斷，idle 重擺 t=0。
//   3. 播放：▶ rAF 推進（t += dt，末尾 loop），每幀 evaluateDirectorFrame →
//      syncElements + applyCameraPose——照 vendor export.ts 輪子用法逐句對齊。
//      applyCameraPose 動的是場景內拍攝機 rig，不搶用戶 OrbitControls 自由視角。
//   4. 降級：WebGL 初始化失敗 → 顯示 SVG 示意 + 「3D 視口不可用，顯示示意圖」。
//
// WebGL context 守衛：同屏 ≤2 個引擎，超出在模組級佇列排隊，前者 dispose 後放行。
// 畫布手勢隔離：根節點帶 data-canvas-interactive（use-node-gestures / InfiniteCanvas
// 的 pointer 守衛放行給 engine 自帶 OrbitControls），wheel 在本層 stopPropagation
// 防止 InfiniteCanvas 容器級 wheel 縮放連動。

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Play, Pause, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { svgToDataUrl } from "@/lib/svg-data-url";
import { authHeaders } from "@/lib/canvas/client";
import { uploadAgentAttachments } from "@/lib/agent-chat-client";
import { buildAssetUrl, mintUploadsTicket } from "@/lib/agent-uploads";
import { evaluateDirectorFrame, planDuration, shotAtTime } from "@/lib/director-engine/playback";
import { describeShot } from "@/lib/director-engine/shotDescription";
import { motionTemplate } from "@/lib/director-engine/motionTemplates";
import { cameraTemplate } from "@/lib/director-engine/cameraTemplates";
import type {
  DirectorElement,
  DirectorPlan,
  DirectorSequenceShot,
  DirectorShotScale,
} from "@/lib/director-engine/types";

// ── WebGL context 佇列（同屏 ≤2）─────────────────────────────────────────────

const MAX_ACTIVE_CONTEXTS = 2;
let activeContexts = 0;
const contextWaiters: Array<() => void> = [];

function pumpContextQueue(): void {
  contextWaiters.shift()?.();
}

interface ContextSlot {
  /** resolve 於 slot 到手時（立即可得或前者 dispose 釋出）。 */
  promise: Promise<void>;
  /** 歸還 slot：等待中被取消則不佔額度；已到手則釋出並放行下一個。 */
  dispose(): void;
}

function acquireContextSlot(): ContextSlot {
  let state: "held" | "waiting" | "disposed" = activeContexts < MAX_ACTIVE_CONTEXTS ? "held" : "waiting";
  if (state === "held") activeContexts++;
  let grant!: () => void;
  const promise = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const waiter = () => {
    if (state !== "waiting") return;
    state = "held";
    activeContexts++;
    grant();
  };
  if (state === "waiting") contextWaiters.push(waiter);
  else grant(); // held：立即到手（不 resolve 的 held = 視口永久 loading，P0）
  return {
    promise,
    dispose() {
      if (state === "disposed") return;
      if (state === "waiting") {
        const index = contextWaiters.indexOf(waiter);
        if (index >= 0) contextWaiters.splice(index, 1);
        state = "disposed";
        return;
      }
      state = "disposed";
      activeContexts--;
      pumpContextQueue();
    },
  };
}

// ── C4 生成閉環：白模截圖 → 上傳 → 注入請求 ─────────────────────────────────

/** 導演台「生成真实画面」事件名；ImagePlayground 監聽後轉發給 agent 聊天注入。 */
export const DIRECTOR_RENDER_REQUEST_EVENT = "director-render-request";

// 白名單摘入：vendor kunpeng-vendor/src/lib/director/imageAnalysis.ts 的 shotScaleLabel
// 標籤映射（純字面量，逐字等價；imageAnalysis 本體含 VLM 依賴未移植，故只摘此表）。
const SHOT_SCALE_LABELS: Record<DirectorShotScale, string> = {
  'extreme-wide': '大全景', wide: '全景', medium: '中景', 'medium-close': '中近景', 'close-up': '特写', 'extreme-close-up': '大特写',
};

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/**
 * 組「导演台镜头渲染请求」注入文本（簡體，給 agent 的指令）。
 * ref 引用形狀現場結論：上傳鏈是 gateway 附件 path（無 mediaId），因此照
 * AgentComposer.buildAttachmentBlock 的 [ATTACHMENTS_BLOCK] 慣例帶 path 行；
 * image_edit 工具（VPS .opencode/tools/image_edit.ts）的 image_url 參數要的是
 * 「可 fetch 的 URL」（resolveMediaId 內部 fetch → /uploads 換 mediaId），所以
 * 另給鑄票後的网关公網直連 URL（TTL 1h，本輪立即生效）。
 * vendor finalRender.ts 的模板段逐字保留，僅「画面描述」槽位交由 agent 撰寫。
 */
function buildDirectorRenderText(input: {
  plan: DirectorPlan;
  shot: DirectorSequenceShot;
  shotNo: number;
  total: number;
  referenceUrl: string;
  attachmentPath: string;
  attachmentMime: string;
  attachmentSize: number;
  composition: string;
  actorNames: Map<string, string>;
}): string {
  const { plan, shot, shotNo, total, referenceUrl, attachmentPath, attachmentMime, attachmentSize, composition, actorNames } = input;
  const mime = attachmentMime || "application/octet-stream";
  const size = Number.isFinite(attachmentSize) ? String(attachmentSize) : "?";
  // 附件行格式照抄 AgentComposer.tsx buildAttachmentBlock/attachmentLine：`1. {path} | {mime} | {size}`
  const attachmentBlock = `\n[ATTACHMENTS_BLOCK]\n[附件]\n1. ${attachmentPath} | ${mime} | ${size}\n[/ATTACHMENTS_BLOCK]`;

  const actionLines = [...shot.actions]
    .sort((a, b) => a.startSec - b.startSec)
    .map((action) => {
      const name = actorNames.get(action.elementId) ?? "角色";
      const moving = Math.hypot(action.to.x - action.from.x, action.to.z - action.from.z) > 0.05;
      const path = moving ? `，从 (${action.from.x.toFixed(1)}, ${action.from.z.toFixed(1)}) 走到 (${action.to.x.toFixed(1)}, ${action.to.z.toFixed(1)})` : "";
      return `- 「${name}」${motionTemplate(action.action).label}（第 ${action.startSec.toFixed(1)}s 起，持续 ${action.durationSec.toFixed(1)}s${path}）`;
    });

  const contextLines = [
    `所属方案：${plan.name}`,
    "机位与构图（白模预演实况）：",
    composition,
    actionLines.length > 0 ? ["走位与动作：", ...actionLines].join("\n") : "走位与动作：无（静态镜头）",
    shot.notes ? `导演备注：${shot.notes}` : "",
  ].filter(Boolean).join("\n");

  return [
    "[导演台镜头渲染请求]",
    `白模参考图（参考图一，image_edit 的 image_url 直接传此地址）：${referenceUrl}`,
    attachmentBlock,
    "",
    `镜头 ${shotNo}/${total}：${shot.name} · 运镜 ${cameraTemplate(shot.cameraMove).label} · 景别 ${SHOT_SCALE_LABELS[shot.shotScale ?? "medium"]} · 预演画幅 ${shot.aspect}（白模截图即此比例）`,
    contextLines,
    "请立即用 image_edit 生成此镜头的真实电影画面（把上面的白模参考图 URL 作为 image_url 传入）。prompt 模板如下，其中「{画面描述}」槽位由你根据上述走位/动作/氛围撰写一句具体的画面内容（人物、动作、环境、光线）填入，模板其余文字一字不改：",
    "「以参考图一的白模预演为唯一构图、人物站位、摄影机角度和景别依据，将白模渲染为正式电影分镜画面。白模只提供空间调度，不保留灰模材质。{画面描述}严格保持人物数量、左右关系、朝向、遮挡和画面边界，不得增加无关人物或改变机位。画面无字幕、无说明文字、无白模、无网格。」",
    "生成前正常走计费确认。",
  ].join("\n");
}

// ── 數據與 SVG 降級 ──────────────────────────────────────────────────────────

interface DirectorStatePayload {
  ok?: boolean;
  project?: {
    elements?: DirectorElement[];
    plans?: DirectorPlan[];
    activePlanId?: string | null;
  };
}

/** gateway state → activePlan + elements（activePlanId 優先，退回首個 plan）。 */
async function loadDirectorState(sessionId: string): Promise<{ plan: DirectorPlan | null; elements: DirectorElement[] }> {
  // 鑑權頭必帶（authHeaders 慣例）：裸 fetch 在 LOCAL_TEST_MODE 與真用戶兩態都會 401，
  // 代理靜默拒絕 → 視口永遠只渲染空網格（2026-09-03 視覺重放實錘）
  const headers = authHeaders();
  if (!headers) throw new Error("not_authenticated");
  const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/director/state`, { cache: "no-store", headers });
  if (!resp.ok) throw new Error(`director state ${resp.status}`);
  const json = (await resp.json()) as DirectorStatePayload;
  const project = json?.project;
  if (!project) return { plan: null, elements: [] };
  const plans = Array.isArray(project.plans) ? project.plans : [];
  const plan = plans.find((item) => item.id === project.activePlanId) ?? plans[0] ?? null;
  return { plan, elements: Array.isArray(project.elements) ? project.elements : [] };
}

/** 降級示意圖源：相容 data URL（聊天卡）與 raw <svg> 字串（畫布 metadata）。 */
function toImgSrc(svg: string | null | undefined): string | null {
  if (!svg) return null;
  if (svg.startsWith("data:")) return svg;
  return svgToDataUrl(svg);
}

type ViewportPhase = "loading" | "ready" | "fallback";

export interface DirectorMiniViewportProps {
  sessionId: string;
  className?: string;
  /** 導演工程 revision（gateway doc.revision 透傳）：變化時重拉 state 換場景數據。 */
  revision?: number;
  /** WebGL 降級時的示意圖（raw SVG 或 data URL）。 */
  topViewSvg?: string | null;
  cameraViewSvg?: string | null;
}

export function DirectorMiniViewport({ sessionId, className, revision, topViewSvg, cameraViewSvg }: DirectorMiniViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<import("@/lib/director-engine/engine").DirectorEngine | null>(null);
  const planRef = useRef<DirectorPlan | null>(null);
  const elementsRef = useRef<DirectorElement[]>([]);
  const timeRef = useRef(0);
  const lastTsRef = useRef(0);
  const rafRef = useRef(0);
  const playingRef = useRef(false);
  const [phase, setPhase] = useState<ViewportPhase>("loading");
  const [playing, setPlaying] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  // C4 生成閉環：「生成真实画面」按鈕狀態機。requested 為鎖存態（agent 輪次在跑，
  // 重複點會堆第二筆計費請求）；失敗回 idle 並在視口內如實報錯。
  const [renderPhase, setRenderPhase] = useState<"idle" | "uploading" | "requested">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);

  // 播放幀套用：與 vendor export.ts 逐句對齊（evaluate → syncElements → applyCameraPose）。
  const applyFrameAt = useCallback((timeSec: number) => {
    const engine = engineRef.current;
    const plan = planRef.current;
    if (!engine || !plan) return;
    const frame = evaluateDirectorFrame(plan, elementsRef.current, timeSec);
    if (!frame) return;
    engine.syncElements(frame.elements);
    engine.applyCameraPose(frame.camera);
  }, []);

  const stopPlayback = useCallback(() => {
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
  }, []);

  const tick = useCallback(
    (ts: number) => {
      if (!playingRef.current) return;
      const plan = planRef.current;
      if (!engineRef.current || !plan) {
        stopPlayback();
        return;
      }
      const dt = lastTsRef.current ? (ts - lastTsRef.current) / 1000 : 0;
      lastTsRef.current = ts;
      const duration = planDuration(plan);
      timeRef.current = duration > 0 ? (timeRef.current + dt) % duration : 0;
      applyFrameAt(timeRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [applyFrameAt, stopPlayback],
  );

  const togglePlay = useCallback(() => {
    if (phase !== "ready" || !planRef.current) return;
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
    if (next) {
      lastTsRef.current = 0;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
  }, [phase, tick]);

  // C4 生成閉環主流程：capture（輪子，vendor finalRender.ts 同款 captureShot(aspect, 1920)）
  // → 壓縮（跟隨 ReferenceImageUpload 同一 browser-image-compression 慣例，守 4.5MB 代理上限）
  // → gateway 附件上傳（uploadAgentAttachments，站內 /attachments 代理）→ 鑄票拼公網 URL
  // → 組注入文本 → window 派發 director-render-request（ImagePlayground 轉 agent 注入）。
  const requestRealRender = useCallback(async () => {
    const engine = engineRef.current;
    const plan = planRef.current;
    if (!engine || !plan || plan.shots.length === 0 || renderPhase !== "idle") return;
    setRenderError(null);
    setRenderPhase("uploading");
    try {
      const shot = shotAtTime(plan, timeRef.current);
      const shotNo = Math.max(0, plan.shots.findIndex((item) => item.id === shot.id)) + 1;
      const dataUrl = engine.captureShot(shot.aspect, 1920);
      if (!dataUrl.startsWith("data:image/")) throw new Error("视口截图返回了意外的数据");
      let file = await dataUrlToFile(dataUrl, `director-white-${plan.id}-${shotNo}-${Date.now()}.png`);
      try {
        const { default: imageCompression } = await import("browser-image-compression");
        const compressed = await imageCompression(file, { maxSizeMB: 1.1, maxWidthOrHeight: 1920, useWebWorker: true });
        file = compressed instanceof File ? compressed : new File([compressed], file.name, { type: file.type || "image/png" });
      } catch {
        // 壓縮不可用就用原 PNG 直傳（白模場景一般遠小於上限），不阻斷主流程
      }
      const [attachment] = await uploadAgentAttachments(sessionId, [file]);
      if (!attachment?.path) throw new Error("上传响应缺少附件路径");
      const { ticket } = await mintUploadsTicket(sessionId);
      const referenceUrl = buildAssetUrl(sessionId, attachment.path, ticket);
      const actorNames = new Map(elementsRef.current.map((el) => [el.id, el.name]));
      const text = buildDirectorRenderText({
        plan,
        shot,
        shotNo,
        total: plan.shots.length,
        referenceUrl,
        attachmentPath: attachment.path,
        attachmentMime: attachment.mime || "image/png",
        attachmentSize: attachment.size,
        composition: describeShot(shot, engine.snapshotForDescription().elements),
        actorNames,
      });
      window.dispatchEvent(new CustomEvent(DIRECTOR_RENDER_REQUEST_EVENT, { detail: { text } }));
      setRenderPhase("requested");
    } catch (err) {
      setRenderPhase("idle");
      setRenderError(err instanceof Error ? err.message : String(err).slice(0, 200) || "未知错误");
    }
  }, [sessionId, renderPhase]);

  // 錯誤行 6 秒自清（點擊可立即關）；只清提示，不動按鈕狀態。
  useEffect(() => {
    if (!renderError) return;
    const timer = window.setTimeout(() => setRenderError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [renderError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    const slot = acquireContextSlot();

    void (async () => {
      await slot.promise;
      if (disposed) return;
      try {
        // three.js 只在這裡進動態 chunk，禁入 SSR 主 bundle。
        const mod = await import("@/lib/director-engine/engine");
        if (disposed) return;
        const engine = new mod.DirectorEngine(container);
        engineRef.current = engine;
        observer = new ResizeObserver(() => engine.resize());
        observer.observe(container);
        setPhase("ready");
        // 數據 effect 可能先到（與本 effect 競速）：引擎就緒即補擺當前幀，
        // 避免數據先到、applyFrameAt 撞 null engine 落空成空白場景。
        if (planRef.current && !playingRef.current) {
          timeRef.current = 0;
          applyFrameAt(0);
        }
      } catch (err) {
        // WebGL 初始化失敗才降級；數據失敗不偽裝成 WebGL 故障。
        console.warn("[dmv] engine init failed:", String(err).slice(0, 300));
        if (!disposed) {
          stopPlayback();
          setPhase("fallback");
        }
        return;
      }
    })();

    // wheel 隔離：InfiniteCanvas 在容器級掛原生 wheel 縮放（passive:false 無目標守衛），
    // 在此層攔截冒泡；不 preventDefault——OrbitControls 自己的 wheel 處理不受影響。
    const stopWheel = (event: WheelEvent) => event.stopPropagation();
    container.addEventListener("wheel", stopWheel);

    return () => {
      disposed = true;
      container.removeEventListener("wheel", stopWheel);
      observer?.disconnect();
      stopPlayback();
      engineRef.current?.dispose();
      engineRef.current = null;
      slot.dispose();
    };
  }, [sessionId, applyFrameAt, stopPlayback]);

  // 數據載入/刷新（revision 驅動，修「掛載後不反映後續變更」缺口）：gateway 每次變更
  // 隨 canvas metadata 帶 revision，變化 → 重拉 state 換 planRef/elementsRef。
  // 播放中不打斷（tick 每幀讀 refs，新數據自然接入）；idle 時回 t=0 重擺場景。
  // 引擎佇列 slot 不重複 acquire——這裡只換數據，不重建 engine。
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const { plan, elements } = await loadDirectorState(sessionId);
        if (disposed) return;
        planRef.current = plan;
        elementsRef.current = elements;
        if (plan) {
          if (!playingRef.current) {
            timeRef.current = 0;
            applyFrameAt(0);
          }
          setDataReady(true);
        }
      } catch {
        // 數據載入失敗：保留既有場景（初次載入則為空白白模，可自由環視），播放鈕維持原狀。
      }
    })();
    return () => {
      disposed = true;
    };
  }, [sessionId, revision, applyFrameAt]);

  const fallbackSrc = toImgSrc(topViewSvg) ?? toImgSrc(cameraViewSvg);

  // 畫布節點手勢放行：pointer 事件不攔截（data-canvas-interactive 已讓
  // use-node-gestures / InfiniteCanvas 早期 return），僅擋雙擊選中文字。
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          {fallbackSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fallbackSrc}
              alt="导演台示意图"
              loading="lazy"
              decoding="async"
              draggable={false}
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-ios-caption1 text-white/45">3D 視口不可用</span>
          )}
          <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-2 py-0.5 text-ios-caption1 text-white/70">
            3D 視口不可用，顯示示意圖
          </span>
        </div>
      )}

      {phase === "ready" && (
        <>
          <button
            type="button"
            onClick={togglePlay}
            disabled={!dataReady}
            aria-label={playing ? "暂停预演" : "播放预演"}
            className={cn(
              "absolute bottom-2 left-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[12px] font-medium text-white/90",
              "backdrop-blur-sm transition-colors duration-200 hover:bg-black/60",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
            )}
          >
            {playing ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
            {playing ? "暂停" : "预演"}
          </button>
          {/* C4 生成閉環入口：右下角，樣式對齊左下「预演」鈕。 */}
          <button
            type="button"
            onClick={requestRealRender}
            disabled={!dataReady || renderPhase !== "idle"}
            aria-label="生成真实画面"
            title={renderPhase === "requested" ? "已交给 AI 助理生成，结果会出现在画布" : "把当前镜头白模交给 AI 助理生成真实画面"}
            className={cn(
              "absolute bottom-2 right-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[12px] font-medium text-white/90",
              "backdrop-blur-sm transition-colors duration-200 hover:bg-black/60",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
            )}
          >
            <Sparkles className={cn("h-3.5 w-3.5", renderPhase === "uploading" && "animate-pulse")} aria-hidden="true" />
            {renderPhase === "idle" ? "生成真实画面" : renderPhase === "uploading" ? "正在上传白模…" : "已请求生成"}
          </button>
        </>
      )}

      {renderError && (
        <button
          type="button"
          onClick={() => setRenderError(null)}
          className="absolute bottom-12 left-1/2 max-w-[88%] -translate-x-1/2 rounded-full bg-[rgba(154,42,42,0.88)] px-3 py-1 text-[12px] leading-snug text-white backdrop-blur-sm"
        >
          生成请求失败：{renderError}
        </button>
      )}
    </div>
  );
}
