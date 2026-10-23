"use client";

// DirectorMiniViewport —— 导演台迷你 3D 视口（spec §9 片B 新胶水，非轮子）。
//
// 轮子 = @/lib/director-engine/engine（kunpeng DirectorEngine 逐行移植，
// three.js 白模场景/灯光/OrbitControls 自带）。本档只做四件事：
//   1. 挂载：useEffect 内动态 import（three 不入 SSR 主 bundle）→ new DirectorEngine
//      → ResizeObserver → engine.resize()；unmount → engine.dispose()。
//   2. 数据：GET /api/agent/sessions/<sid>/director/state（子路径形，见 route.ts
//      GET_SUBPATHS）→ activePlan + elements → evaluateDirectorFrame(plan, elements, 0)
//      → engine.syncElements + applyCameraPose。revision prop 变化时重拉（后续变更
//      反映到已挂载视口）；播放中换数据不打断，idle 重摆 t=0。
//   3. 播放：▶ rAF 推进（t += dt * shot.timeScale，缺省 1；末尾 loop），每帧 evaluateDirectorFrame →
//      syncElements + applyCameraPose——照 vendor export.ts 轮子用法逐句对齐。
//      applyCameraPose 动的是场景内拍摄机 rig，不抢用户 OrbitControls 自由视角。
//   4. 降级：WebGL 初始化失败 → 显示 SVG 示意 + 「3D 视口不可用，显示示意图」。
//
// WebGL context 守卫：同屏 ≤2 个引擎，超出在模组级伫列排队，前者 dispose 后放行。
// 画布手势隔离：根节点带 data-canvas-interactive（use-node-gestures / InfiniteCanvas
// 的 pointer 守卫放行给 engine 自带 OrbitControls），wheel 在本层 stopPropagation
// 防止 InfiniteCanvas 容器级 wheel 缩放连动。

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Play, Pause, Sparkles, Camera } from "lucide-react";
import { cn } from "@/lib/utils";
import { svgToDataUrl } from "@/lib/svg-data-url";
import { authHeaders } from "@/lib/canvas/client";
import { uploadAgentAttachments } from "@/lib/agent-chat-client";
import { buildAssetUrl, mintUploadsTicket } from "@/lib/agent-uploads";
import { exportPlanPrevizKeyframes } from "@/lib/director-previz-export";
import { evaluateDirectorFrame, planDuration, resolveShotTimeScale, shotAtTime } from "@/lib/director-engine/playback";
import { describeShot } from "@/lib/director-engine/shotDescription";
import { motionTemplate } from "@/lib/director-engine/motionTemplates";
import { cameraTemplate } from "@/lib/director-engine/cameraTemplates";
import type {
  DirectorElement,
  DirectorPlan,
  DirectorSequenceShot,
  DirectorShotScale,
} from "@/lib/director-engine/types";

// ── WebGL context 伫列（同屏 ≤2）─────────────────────────────────────────────

const MAX_ACTIVE_CONTEXTS = 2;
let activeContexts = 0;
const contextWaiters: Array<() => void> = [];

function pumpContextQueue(): void {
  contextWaiters.shift()?.();
}

interface ContextSlot {
  /** resolve 于 slot 到手时（立即可得或前者 dispose 释出）。 */
  promise: Promise<void>;
  /** 归还 slot：等待中被取消则不占额度；已到手则释出并放行下一个。 */
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
  else grant(); // held：立即到手（不 resolve 的 held = 视口永久 loading，P0）
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

// ── C4 生成闭环：白模截图 → 上传 → 注入请求 ─────────────────────────────────

/** 导演台「生成真实画面」事件名；ImagePlayground 监听后转发给 agent 聊天注入。 */
export const DIRECTOR_RENDER_REQUEST_EVENT = "director-render-request";

// 白名单摘入：vendor kunpeng-vendor/src/lib/director/imageAnalysis.ts 的 shotScaleLabel
// 标签映射（纯字面量，逐字等价；imageAnalysis 本体含 VLM 依赖未移植，故只摘此表）。
const SHOT_SCALE_LABELS: Record<DirectorShotScale, string> = {
  'extreme-wide': '大全景', wide: '全景', medium: '中景', 'medium-close': '中近景', 'close-up': '特写', 'extreme-close-up': '大特写',
};

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/**
 * 组「导演台镜头渲染请求」注入文本（简体，给 agent 的指令）。
 * ref 引用形状现场结论：上传链是 gateway 附件 path（无 mediaId），因此照
 * AgentComposer.buildAttachmentBlock 的 [ATTACHMENTS_BLOCK] 惯例带 path 行；
 * image_edit 工具（VPS .opencode/tools/image_edit.ts）的 image_url 参数要的是
 * 「可 fetch 的 URL」（resolveMediaId 内部 fetch → /uploads 换 mediaId），所以
 * 另给铸票后的网关公网直连 URL（TTL 1h，本轮立即生效）。
 * vendor finalRender.ts 的模板段逐字保留，仅「画面描述」槽位交由 agent 撰写。
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

// ── 数据与 SVG 降级 ──────────────────────────────────────────────────────────

interface DirectorStatePayload {
  ok?: boolean;
  project?: {
    elements?: DirectorElement[];
    plans?: DirectorPlan[];
    activePlanId?: string | null;
  };
}

/** gateway state → activePlan + elements（activePlanId 优先，退回首个 plan）。 */
async function loadDirectorState(sessionId: string): Promise<{ plan: DirectorPlan | null; elements: DirectorElement[] }> {
  // 鉴权头必带（authHeaders 惯例）：裸 fetch 在 LOCAL_TEST_MODE 与真用户两态都会 401，
  // 代理静默拒绝 → 视口永远只渲染空网格（2026-09-03 视觉重放实锤）
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

/** 降级示意图源：相容 data URL（聊天卡）与 raw <svg> 字串（画布 metadata）。 */
function toImgSrc(svg: string | null | undefined): string | null {
  if (!svg) return null;
  if (svg.startsWith("data:")) return svg;
  return svgToDataUrl(svg);
}

type ViewportPhase = "loading" | "ready" | "fallback";

export interface DirectorMiniViewportProps {
  sessionId: string;
  className?: string;
  /** 导演工程 revision（gateway doc.revision 透传）：变化时重拉 state 换场景数据。 */
  revision?: number;
  /** WebGL 降级时的示意图（raw SVG 或 data URL）。 */
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
  // C4 生成闭环：「生成真实画面」按钮状态机。requested 为锁存态（agent 轮次在跑，
  // 重复点会堆第二笔计费请求）；失败回 idle 并在视口内如实报错。
  const [renderPhase, setRenderPhase] = useState<"idle" | "uploading" | "requested">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);
  // S4：预演关键帧导出（首/中/尾 → upload → shot.previz.keyframes）
  const [previzPhase, setPrevizPhase] = useState<"idle" | "working" | "done">("idle");
  const [previzMsg, setPrevizMsg] = useState<string | null>(null);

  // 播放帧套用：与 vendor export.ts 逐句对齐（evaluate → syncElements → applyCameraPose）。
  // 有 glTF mixer 时顺带按 action→clip 映射 seek；无 mixer 回退程序化关节。
  const applyFrameAt = useCallback((timeSec: number) => {
    const engine = engineRef.current;
    const plan = planRef.current;
    if (!engine || !plan) return;
    const frame = evaluateDirectorFrame(plan, elementsRef.current, timeSec, {
      hasMixer: () => engine.hasGltfMixer,
      driveMixer: (req) => {
        engine.playClip(req.clipName, {
          timeSec: req.timeSec,
          loop: req.loop,
          clampWhenFinished: !req.loop,
        });
      },
    });
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
      // S3：按当前 shot.timeScale 推进内容时钟（缺省 1；0.35≈升格）。
      const scale = resolveShotTimeScale(shotAtTime(plan, timeRef.current));
      timeRef.current = duration > 0 ? (timeRef.current + dt * scale) % duration : 0;
      applyFrameAt(timeRef.current);
      engineRef.current?.updateMixer(dt);
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

  // C4 生成闭环主流程：capture（轮子，vendor finalRender.ts 同款 captureShot(aspect, 1920)）
  // → 压缩（跟随 ReferenceImageUpload 同一 browser-image-compression 惯例，守 4.5MB 代理上限）
  // → gateway 附件上传（uploadAgentAttachments，站内 /attachments 代理）→ 铸票拼公网 URL
  // → 组注入文本 → window 派发 director-render-request（ImagePlayground 转 agent 注入）。
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
        // 压缩不可用就用原 PNG 直传（白模场景一般远小于上限），不阻断主流程
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

  const exportPrevizKeyframes = useCallback(async () => {
    const engine = engineRef.current;
    const plan = planRef.current;
    if (!engine || !plan || plan.shots.length === 0 || previzPhase === "working") return;
    setPrevizMsg(null);
    setPrevizPhase("working");
    try {
      // 默认只导当前镜（首/中/尾 3 张），与网关「至少各一帧」文案对齐。
      const shot = shotAtTime(plan, timeRef.current);
      const result = await exportPlanPrevizKeyframes(engine, plan, elementsRef.current, sessionId, {
        shotIds: [shot.id],
        times: [0, 0.5, 1],
        width: 1280,
      });
      if (result.uploadError) {
        setPrevizPhase("idle");
        setPrevizMsg(`预演关键帧已截取但未写回：${result.uploadError}`);
        return;
      }
      const n = result.uploaded.length;
      setPrevizPhase("done");
      setPrevizMsg(`已写回 ${shot.name} 的 previz.keyframes（${n} 张）`);
    } catch (err) {
      setPrevizPhase("idle");
      setPrevizMsg(err instanceof Error ? err.message : String(err).slice(0, 200));
    }
  }, [sessionId, previzPhase]);

  // 错误行 6 秒自清（点击可立即关）；只清提示，不动按钮状态。
  useEffect(() => {
    if (!renderError) return;
    const timer = window.setTimeout(() => setRenderError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [renderError]);

  useEffect(() => {
    if (!previzMsg) return;
    const timer = window.setTimeout(() => setPrevizMsg(null), 6000);
    return () => window.clearTimeout(timer);
  }, [previzMsg]);

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
        // three.js 只在这里进动态 chunk，禁入 SSR 主 bundle。
        const mod = await import("@/lib/director-engine/engine");
        if (disposed) return;
        const engine = new mod.DirectorEngine(container);
        engineRef.current = engine;
        observer = new ResizeObserver(() => engine.resize());
        observer.observe(container);
        setPhase("ready");
        // 数据 effect 可能先到（与本 effect 竞速）：引擎就绪即补摆当前帧，
        // 避免数据先到、applyFrameAt 撞 null engine 落空成空白场景。
        if (planRef.current && !playingRef.current) {
          timeRef.current = 0;
          applyFrameAt(0);
        }
      } catch (err) {
        // WebGL 初始化失败才降级；数据失败不伪装成 WebGL 故障。
        console.warn("[dmv] engine init failed:", String(err).slice(0, 300));
        if (!disposed) {
          stopPlayback();
          setPhase("fallback");
        }
        return;
      }
    })();

    // wheel 隔离：InfiniteCanvas 在容器级挂原生 wheel 缩放（passive:false 无目标守卫），
    // 在此层拦截冒泡；不 preventDefault——OrbitControls 自己的 wheel 处理不受影响。
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

  // 数据载入/刷新（revision 驱动，修「挂载后不反映后续变更」缺口）：gateway 每次变更
  // 随 canvas metadata 带 revision，变化 → 重拉 state 换 planRef/elementsRef。
  // 播放中不打断（tick 每帧读 refs，新数据自然接入）；idle 时回 t=0 重摆场景。
  // 引擎伫列 slot 不重复 acquire——这里只换数据，不重建 engine。
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
        // 数据载入失败：保留既有场景（初次载入则为空白白模，可自由环视），播放钮维持原状。
      }
    })();
    return () => {
      disposed = true;
    };
  }, [sessionId, revision, applyFrameAt]);

  const fallbackSrc = toImgSrc(topViewSvg) ?? toImgSrc(cameraViewSvg);

  // 画布节点手势放行：pointer 事件不拦截（data-canvas-interactive 已让
  // use-node-gestures / InfiniteCanvas 早期 return），仅挡双击选中文字。
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
            <span className="text-ios-caption1 text-white/45">3D 视口不可用</span>
          )}
          <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-2 py-0.5 text-ios-caption1 text-white/70">
            3D 视口不可用，显示示意图
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
          <button
            type="button"
            onClick={exportPrevizKeyframes}
            disabled={!dataReady || previzPhase === "working"}
            aria-label="导出预演关键帧"
            title="截取本镜首/中/尾并写回 shot.previz.keyframes（供视频 reference_images）"
            className={cn(
              "absolute bottom-2 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[12px] font-medium text-white/90",
              "backdrop-blur-sm transition-colors duration-200 hover:bg-black/60",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
            )}
          >
            <Camera className={cn("h-3.5 w-3.5", previzPhase === "working" && "animate-pulse")} aria-hidden="true" />
            {previzPhase === "idle" ? "导出预演关键帧" : previzPhase === "working" ? "截帧上传中…" : "关键帧已写回"}
          </button>
          {/* C4 生成闭环入口：右下角，样式对齐左下「预演」钮。 */}
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

      {previzMsg && (
        <button
          type="button"
          onClick={() => setPrevizMsg(null)}
          className="absolute bottom-12 left-1/2 max-w-[88%] -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[12px] leading-snug text-white backdrop-blur-sm"
        >
          {previzMsg}
        </button>
      )}
    </div>
  );
}
