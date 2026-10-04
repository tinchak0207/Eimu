"use client";

// CanvasEngineeringPanel —— 語義縮放 LOD 3「工程透析」面板（2026-09-30 打磨版：X 光透析）。
//
// 視角轉換（宿主同步把卡片飛到視口左 1/3、進 focus 模式）：
//   - 面板以 FLIP 從卡片螢幕矩形展開到右側面板矩形（320ms，cubic-bezier(.2,.9,.2,1)）；
//   - 一條青色「光束」SVG 從卡片右緣連到面板左緣並常駐（跟隨卡片位置，飛行途中也跟）；
//   - Esc／關閉：反向 FLIP 收回卡片、光束收縮，再交宿主解除 focus。
// 內容＝「管線剖面」：左側垂直軌道串起 请求体 → 执行 → 结果 → LoRA → Critic（→ 版本/门禁）。
//
// 資料只有兩個來源，缺什麼就如實寫缺什麼，不編造：
//   - 本地 metadata：model/size/quality/kind/status、toolInput/toolOutput、taskVersions、gateConfirm、錯誤文字。
//   - 有 imageTaskId 時 lazy fetch `GET /api/generation-jobs/{id}`（任務真源）：
//     submittedConfig（含 LoRA 版本 id）、prompt、時間線、張數、產出、錯誤碼。404/失敗 →「任务记录不可用」。
// Critic 日志與 LoRA 权重目前沒有按節點落庫 → 固定顯示「未记录」。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScanLine, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorDetailsText, type CanvasNode } from "@/lib/canvas/types";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import { tokenizeJson, type JsonTokenKind } from "@/lib/canvas/json-tokens";
import { buildAuthHeaders } from "./embed/embed-helpers";

/** 卡片在螢幕上的矩形（client 座標）。 */
export interface EngineeringAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasEngineeringPanelProps {
  node: CanvasNode | null;
  onClose: () => void;
  /** 被透析卡片的即時螢幕矩形（每幀更新）；null＝不做 FLIP／光束。 */
  anchor?: EngineeringAnchorRect | null;
  reduceMotion?: boolean;
}

type JobState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ok"; job: GenerationTaskProjection }
  | { kind: "unavailable" };

const OPEN_MS = 320;
const CLOSE_MS = 240;
const OPEN_EASE = "cubic-bezier(0.2, 0.9, 0.2, 1)";

function formatTime(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function toMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function isImageUrl(url: string | null | undefined): url is string {
  return !!url && (url.startsWith("http") || url.startsWith("data:") || url.startsWith("blob:"));
}

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: "text-ios-blue",
  string: "text-[#B25E00]",
  number: "text-ios-purple",
  literal: "text-ios-purple",
  plain: "text-muted-foreground",
};

function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/[0.03] p-2.5 font-mono text-[12px] leading-relaxed ring-1 ring-black/[0.06]">
      {tokenizeJson(text).map((t, i) => (
        <span key={i} className={TOKEN_CLASS[t.kind]}>
          {t.text}
        </span>
      ))}
    </pre>
  );
}

/** 工具輸入輸出：能解析成 JSON 就高亮，否則原文。 */
function MaybeJson({ text }: { text: string }) {
  try {
    return <JsonView value={JSON.parse(text)} />;
  } catch {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/[0.03] p-2.5 font-mono text-[12px] leading-relaxed text-foreground/80 ring-1 ring-black/[0.06]">
        {text}
      </pre>
    );
  }
}

function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-1.5 py-1" aria-label="加载中">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="lod-skeleton h-2.5 rounded" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

const NOT_RECORDED = <span className="text-muted-foreground">未记录</span>;

function KV({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2 py-0.5 text-[12px]">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 break-all text-foreground", mono && "font-mono text-[12px]")}>{value}</span>
    </div>
  );
}

/** 管線剖面的一段：左側軌道節點（序號）＋標題＋來源標記；stagger 淡入上移。 */
function Segment({
  index,
  title,
  source,
  muted = false,
  children,
}: {
  index: number;
  title: string;
  source?: React.ReactNode;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="lod-rise relative pb-4 pl-9 last:pb-1" style={{ animationDelay: `${180 + index * 40}ms` }}>
      <span
        className={cn(
          "absolute left-0 top-0 flex h-[22px] w-[22px] items-center justify-center rounded-full border font-mono text-[11px] font-semibold",
          muted ? "border-black/10 bg-white text-muted-foreground" : "border-ios-blue/50 bg-white text-ios-blue",
        )}
      >
        {index + 1}
      </span>
      <div className="mb-1.5 flex items-baseline gap-2">
        <p className={cn("text-ios-caption1 font-semibold tracking-wide", muted ? "text-muted-foreground" : "text-foreground")}>{title}</p>
        {source && <span className="text-[11px] text-muted-foreground">{source}</span>}
      </div>
      {children}
    </section>
  );
}

/** 執行 mini Gantt：排队（created→started）＋运行（started→finished）兩段色條。 */
function ExecutionGantt({ job }: { job: GenerationTaskProjection }) {
  const created = toMs(job.createdAt);
  const started = toMs(job.startedAt);
  const finished = toMs(job.finishedAt);
  if (created === undefined) return <p className="text-[12px] text-muted-foreground">无时间线</p>;
  const queue = started !== undefined ? Math.max(0, started - created) : undefined;
  const run = started !== undefined && finished !== undefined ? Math.max(0, finished - started) : undefined;
  const total = (queue ?? 0) + (run ?? 0);
  const pct = (v: number | undefined) => (v === undefined || total <= 0 ? 0 : Math.max(4, (v / total) * 100));
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-black/[0.05]">
        {queue !== undefined && <div className="h-full bg-ios-orange/70" style={{ width: `${pct(queue)}%` }} />}
        {run !== undefined ? (
          <div className="h-full bg-ios-blue" style={{ width: `${pct(run)}%` }} />
        ) : started !== undefined ? (
          <div className="lod-skeleton h-full flex-1" />
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-ios-orange" />
          排队 {queue !== undefined ? formatDuration(queue) : "—"}
        </span>
        <span>
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-ios-blue" />
          运行 {run !== undefined ? formatDuration(run) : started !== undefined ? "进行中" : "—"}
        </span>
        <span className="text-muted-foreground">
          {formatTime(job.createdAt)} → {formatTime(job.finishedAt) ?? "…"}
        </span>
      </div>
    </div>
  );
}

function statusTone(status: string | undefined): string {
  switch (status) {
    case "succeeded":
    case "success":
      return "bg-ios-green/10 text-[#248A3D] ring-ios-green/25";
    case "failed":
    case "error":
    case "refunded":
    case "cancelled":
      return "bg-ios-red/10 text-ios-red ring-ios-red/25";
    case "running":
    case "loading":
    case "queued":
      return "bg-ios-blue/10 text-ios-blue ring-ios-blue/20";
    default:
      return "bg-black/[0.04] text-muted-foreground ring-black/[0.06]";
  }
}

export function CanvasEngineeringPanel({ node, onClose, anchor = null, reduceMotion = false }: CanvasEngineeringPanelProps) {
  const taskId = node?.metadata?.imageTaskId;
  const [job, setJob] = useState<JobState>({ kind: "none" });
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const [panelRect, setPanelRect] = useState<DOMRect | null>(null);
  const [beamOn, setBeamOn] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    if (!taskId) {
      setJob({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    setJob({ kind: "loading" });
    fetch(`/api/generation-jobs/${encodeURIComponent(taskId)}`, {
      headers: buildAuthHeaders() ?? {},
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as GenerationTaskProjection;
        if (!body || typeof body.taskId !== "string") throw new Error("invalid");
        setJob({ kind: "ok", job: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setJob({ kind: "unavailable" });
      });
    return () => controller.abort();
  }, [taskId]);

  /** 目前面板 → 某螢幕矩形的 FLIP 變換（origin 左上）。 */
  const transformTo = (rect: EngineeringAnchorRect, panel: DOMRect) =>
    `translate(${rect.left - panel.left}px, ${rect.top - panel.top}px) scale(${Math.max(0.05, rect.width / panel.width)}, ${Math.max(0.05, rect.height / panel.height)})`;

  // 開場 FLIP：先量終態矩形（光束終點），再把面板瞬移到卡片矩形，下一幀放手讓它彈開。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const final = el.getBoundingClientRect();
    setPanelRect(final);
    const from = anchorRef.current;
    if (reduceMotion || !from) {
      setBeamOn(true);
      return;
    }
    el.style.transition = "none";
    el.style.transformOrigin = "0 0";
    el.style.transform = transformTo(from, final);
    el.style.opacity = "0.35";
    void el.offsetWidth;
    const raf = requestAnimationFrame(() => {
      el.style.transition = `transform ${OPEN_MS}ms ${OPEN_EASE}, opacity 200ms ease-out`;
      el.style.transform = "";
      el.style.opacity = "1";
      setBeamOn(true);
    });
    return () => cancelAnimationFrame(raf);
    // 只在掛載時做一次（宿主以節點 id 作 key，換節點＝重新掛載＝重新展開）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (panelRef.current && !closingRef.current) setPanelRect(panelRef.current.getBoundingClientRect());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 收場：反向 FLIP 收回卡片、光束收縮，動畫結束才交宿主（解除 focus）。
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setBeamOn(false);
    const el = panelRef.current;
    const to = anchorRef.current;
    if (reduceMotion || !el || !to) {
      onClose();
      return;
    }
    const current = el.getBoundingClientRect();
    el.style.transformOrigin = "0 0";
    el.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${CLOSE_MS}ms ease-in`;
    el.style.transform = transformTo(to, current);
    el.style.opacity = "0";
    window.setTimeout(onClose, CLOSE_MS);
  }, [onClose, reduceMotion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (!node) return null;
  const m = node.metadata ?? {};
  const errorText = errorDetailsText(m.errorDetails);
  const versions = m.taskVersions?.items ?? [];
  const okJob = job.kind === "ok" ? job.job : null;
  const loraIds = okJob ? (okJob.submittedConfig as { loraModelVersionIds?: unknown }).loraModelVersionIds : undefined;
  const loraList = Array.isArray(loraIds) ? loraIds.map(String) : [];
  const localRequest = Object.fromEntries(
    Object.entries({
      model: m.model,
      size: m.size,
      quality: m.quality,
      kind: m.kind,
      count: m.count,
      prompt: m.prompt,
      negativePrompt: m.negativePrompt,
    }).filter(([, v]) => v !== undefined && v !== ""),
  );
  const serverRequest = okJob ? { model: okJob.modelId, kind: okJob.kind, prompt: okJob.prompt, ...okJob.submittedConfig } : null;
  const resultUrls = okJob ? okJob.results.map((r) => r.url).filter(isImageUrl).slice(0, 4) : isImageUrl(m.content) ? [m.content] : [];
  const status = okJob?.status ?? m.status ?? "idle";

  // 段落（序號連續；版本/门禁有才出）。
  const segments: { title: string; source?: React.ReactNode; muted?: boolean; body: React.ReactNode }[] = [];
  segments.push({
    title: "请求体",
    source: okJob ? "服务端任务记录" : job.kind === "loading" ? "读取中…" : job.kind === "unavailable" ? "任务记录不可用 · 本地参数" : "本地参数",
    body: (
      <>
        {job.kind === "loading" ? (
          <Skeleton lines={6} />
        ) : Object.keys(serverRequest ?? localRequest).length > 0 ? (
          <JsonView value={serverRequest ?? localRequest} />
        ) : (
          <p className="text-[12px] text-muted-foreground">无请求参数</p>
        )}
        {m.toolInput && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-muted-foreground">工具输入{m.toolId ? ` · ${m.toolId}` : ""}</p>
            <MaybeJson text={m.toolInput} />
          </div>
        )}
      </>
    ),
  });
  segments.push({
    title: "执行",
    source: (
      <span className={cn("rounded-full px-1.5 py-0.5 font-mono text-[11px] ring-1", statusTone(status))}>{status}</span>
    ),
    body: (
      <>
        {job.kind === "loading" ? (
          <Skeleton lines={2} />
        ) : okJob ? (
          <ExecutionGantt job={okJob} />
        ) : (
          <KV label="开始" value={formatTime(m.startedAt) ?? NOT_RECORDED} />
        )}
        {taskId && <KV label="任务 ID" value={taskId} mono />}
        {okJob?.retryOfTaskId && <KV label="重试自" value={okJob.retryOfTaskId} mono />}
        {(okJob?.errorCode || okJob?.errorMessage || errorText) && (
          <p className="mt-1 rounded-lg bg-ios-red/[0.06] px-2 py-1 text-[13px] text-ios-red ring-1 ring-ios-red/20">
            {[okJob?.errorCode, okJob?.errorMessage ?? errorText].filter(Boolean).join(" · ")}
          </p>
        )}
      </>
    ),
  });
  segments.push({
    title: "结果",
    source: okJob ? `${okJob.completedCount}/${okJob.requestedCount}` : undefined,
    body: (
      <>
        {resultUrls.length > 0 ? (
          <div className="grid grid-cols-4 gap-1.5">
            {resultUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={`${url}-${i}`} src={url} alt="" className="aspect-square w-full rounded-md object-cover ring-1 ring-black/[0.06]" />
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">暂无产出</p>
        )}
        {m.toolOutput && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-muted-foreground">工具输出</p>
            <MaybeJson text={m.toolOutput} />
          </div>
        )}
      </>
    ),
  });
  segments.push({
    title: "LoRA",
    body: (
      <>
        <KV
          label="版本"
          value={
            job.kind === "loading" ? (
              "…"
            ) : loraList.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {loraList.map((id) => (
                  <span key={id} className="rounded bg-ios-purple/10 px-1.5 py-0.5 font-mono text-[12px] text-ios-purple ring-1 ring-ios-purple/20">
                    {id}
                  </span>
                ))}
              </span>
            ) : okJob ? (
              "无"
            ) : (
              NOT_RECORDED
            )
          }
        />
        <KV label="权重" value={NOT_RECORDED} />
      </>
    ),
  });
  segments.push({ title: "Critic", muted: true, body: <KV label="日志" value={NOT_RECORDED} /> });
  if (versions.length > 0) {
    segments.push({
      title: `版本（${versions.length}）`,
      body: versions.map((v) => (
        <div key={v.version} className="flex items-center gap-2 py-0.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">{formatTime(v.version) ?? v.version}</span>
          {v.status && <span className="text-muted-foreground">{v.status}</span>}
          {v.tags.length > 0 && <span className="text-muted-foreground">{v.tags.join(",")}</span>}
          {m.taskVersions?.selectedVersion === v.version && (
            <span className="rounded-full bg-ios-blue/10 px-1.5 py-0.5 text-[11px] font-medium text-ios-blue">选中</span>
          )}
        </div>
      )),
    });
  }
  if (m.gateConfirm) {
    segments.push({
      title: "门禁",
      body: (
        <>
          <KV label="裁决" value={m.gateConfirm.status} />
          <KV label="请求 ID" value={m.gateConfirm.request_id} mono />
        </>
      ),
    });
  }

  // 光束：卡片右緣中點 → 面板左緣（y 夾在面板內）。
  const beam = (() => {
    if (!anchor || !panelRect) return null;
    const sx = anchor.left + anchor.width;
    const sy = anchor.top + anchor.height / 2;
    const ex = panelRect.left;
    const ey = Math.min(panelRect.bottom - 28, Math.max(panelRect.top + 28, sy));
    if (ex - sx < 16) return null;
    const dx = (ex - sx) * 0.5;
    return { d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`, sx, sy, ex, ey };
  })();

  return (
    <>
      {beam && (
        <svg className="pointer-events-none fixed inset-0 z-[85] h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="lod-beam-grad" x1={beam.sx} y1={beam.sy} x2={beam.ex} y2={beam.ey} gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="rgba(0,122,255,0.9)" />
              <stop offset="100%" stopColor="rgba(0,122,255,0.35)" />
            </linearGradient>
          </defs>
          <path
            d={beam.d}
            fill="none"
            stroke="url(#lod-beam-grad)"
            strokeWidth={1}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={beamOn ? 0 : 1}
            style={{ transition: reduceMotion ? undefined : `stroke-dashoffset 420ms ${OPEN_EASE} 60ms` }}
          />
          <circle cx={beam.sx} cy={beam.sy} r={beamOn ? 4 : 0} fill="#007AFF" style={{ transition: "r 200ms" }} />
          <circle cx={beam.ex} cy={beam.ey} r={beamOn ? 3.5 : 0} fill="#007AFF" style={{ transition: "r 200ms 300ms" }} />
        </svg>
      )}
      <div
        ref={panelRef}
        data-canvas-interactive
        role="dialog"
        aria-label="工程透析"
        className="pointer-events-auto fixed z-[86] flex w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[20px] lg-sheet text-foreground"
        style={{
          right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
          top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
          maxHeight: "min(80dvh, 720px)",
        }}
      >
        {/* 頭部：圖示＋標題（lg-sheet 語彙） */}
        <div
          className="relative flex items-start gap-2.5 border-b border-black/[0.06] px-4 py-3"
        >
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ios-blue/10 text-ios-blue ring-1 ring-ios-blue/20">
            <ScanLine className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold tracking-wide text-foreground">工程透析</p>
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{node.title}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={requestClose}
            className="shrink-0 cursor-pointer rounded-lg p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 管線剖面：左側垂直軌道 */}
        <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <div
            className="pointer-events-none absolute bottom-6 left-[26px] top-6 w-px bg-gradient-to-b from-ios-blue/35 via-ios-blue/10 to-transparent"
            aria-hidden="true"
          />
          {segments.map((seg, i) => (
            <Segment key={seg.title} index={i} title={seg.title} source={seg.source} muted={seg.muted}>
              {seg.body}
            </Segment>
          ))}
        </div>
      </div>
    </>
  );
}

export default CanvasEngineeringPanel;
