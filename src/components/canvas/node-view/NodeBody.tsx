"use client";

// node-view/NodeBody —— 節點正文渲染（原 CanvasNodeView renderBody + renderPlaceholder）。
// switch node.type：圖/視頻/音頻 → 媒體；文本/提示詞 → 雙擊直編；角色/場景卡/配置 → 長文捲動區。
// 圖片走「直鏈 → 同源代理 → 破圖」三段鏈路（imgError/useProxy 狀態隨正文走）。
// 手勢不在此檔：捲動區的 pointer 手勢由 use-node-gestures 提供、顯式 props 傳入
// （不引入 context，避免 memo 失效）。

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Image as ImageIcon, ArrowRight, CornerDownRight, Wrench, ShieldCheck, Lightbulb, Package, AlertTriangle, Clapperboard } from "lucide-react";
import { CanvasNodeType, errorDetailsText, type CanvasNode, type CanvasNodeGateConfirm, type CanvasNodeStatus } from "@/lib/canvas/types";
import { svgToDataUrl } from "@/lib/svg-data-url";
import { DirectorMiniViewport } from "@/components/director-mini/DirectorMiniViewport";
import { buildAuthHeaders } from "../embed/embed-helpers";
import { Scene3dCardBody } from "./Scene3dCardBody";
import { EntityText } from "@/components/entities/entity-chip";
import { StoryboardSceneBody, StoryboardShotBody } from "./StoryboardShotBody";
import type { StoryboardShotAudioMetadata } from "@/lib/canvas/storyboard-shots";
import { STATUS_LABEL } from "./constants";

function isUrl(value: string): boolean {
  return value.startsWith("http") || value.startsWith("data:");
}

/** B3：縮略圖降採樣——小尺寸顯示時走 next/image 優化器（僅 Blob 存儲域，
 *  next.config 已放行），省流量提幀率；其餘 URL 原樣。競品沒有這條。 */
function thumbUrl(url: string, displayWidth: number): string {
  if (!url.startsWith("https://") || displayWidth >= 300) return url;
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith(".public.blob.vercel-storage.com")) return url;
  } catch {
    return url;
  }
  const w = displayWidth < 150 ? 256 : 384;
  return `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=70`;
}

/** 直链加载失败后的同源代理兜底（上游 CDN 可能要登录/过期/CORS，代理 302 拉回）。 */
function proxySrc(url: string): string {
  return `/api/canvas/image-proxy?url=${encodeURIComponent(url)}`;
}

/** 破图占位：给出明确失败提示 + 重新加载入口（网络抖动/临时签名过期可一键恢复）。
 * 因为图片其实可能只是临时加载失败，绝不把它伪装成生成失败。 */
function renderBrokenImage(onRetry: () => void): React.ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3">
      <ImageIcon className="h-8 w-8 text-foreground/45" />
      <span className="text-ios-footnote font-medium text-muted-foreground">图片加载失败</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-ios-blue/10 px-3 py-1.5 text-ios-caption1 font-medium text-ios-blue transition-colors duration-150 hover:bg-ios-blue/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        重新加载
      </button>
    </div>
  );
}

function formatProgress(progress: number): string {
  const pct = progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
  return `${pct}%`;
}

/**
 * 門禁卡裁決（2026-09-24 協作確認閘）：網關在協作檔的三個停點把 pending confirm
 * 回寫到卡上（metadata.gateConfirm），這裡讓用戶在畫布上直接批准/退回——不必再回
 * 對話裡找確認卡。裁決走**既有**站點轉發 /api/agent/sessions/{id}/confirm
 *（與對話確認卡同一條網關鏈路：settleConfirm → 續跑），不另開通路、不新增後端。
 * 卡面狀態真值＝metadata.gateConfirm.status（網關回寫）；本地只在送出期間鎖按鈕，
 * 成功後維持鎖定、等網關回寫翻面——前端不搶先宣稱「已批准」（同 AgentConfirmCard
 * 的鎖定語義：沒收到 confirm.resolved 前不算數）。
 */
function GateConfirmActions({ confirm }: { confirm: CanvasNodeGateConfirm }) {
  const [busy, setBusy] = useState<false | "approve" | "reject">(false);
  const [error, setError] = useState("");

  const decide = useCallback(
    async (approved: boolean) => {
      setBusy(approved ? "approve" : "reject");
      setError("");
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(confirm.session_id)}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(buildAuthHeaders() ?? {}) },
          body: JSON.stringify({ request_id: confirm.request_id, approved }),
        });
        if (!res.ok) {
          // 失敗如實說，不假裝已裁決（已處理過的同一筆會回「已處理過」——也是真話）。
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          setError(typeof body?.error === "string" && body.error ? body.error : "提交失败，请到对话里确认");
          setBusy(false);
        }
      } catch {
        setError("提交失败，请到对话里确认");
        setBusy(false);
      }
    },
    [confirm.session_id, confirm.request_id],
  );

  if (confirm.status !== "pending") {
    return (
      <p className="break-words text-ios-caption1 leading-relaxed text-muted-foreground">
        {confirm.status === "approved" ? "已批准 · 系统已从断点续跑" : "已退回 · 请在对话里说明要改哪里"}
      </p>
    );
  }

  const locked = busy !== false;
  return (
    <div className="space-y-1.5">
      <p className="text-ios-caption2 leading-relaxed text-ios-orange">
        协作模式：这一步等你确认，确认后系统自动从断点续跑
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-canvas-interactive
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            void decide(true);
          }}
          className="rounded-full bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "approve" ? "已提交…" : "批准 · 继续"}
        </button>
        <button
          type="button"
          data-canvas-interactive
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            void decide(false);
          }}
          className="rounded-full bg-black/5 px-3 py-1 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "reject" ? "已提交…" : "退回 · 要改"}
        </button>
      </div>
      {error ? <p className="break-words text-ios-caption2 leading-relaxed text-destructive">{error}</p> : null}
    </div>
  );
}

export interface NodeBodyProps {
  node: CanvasNode;
  /** 當前縮放：決定縮圖降採樣檔位 */
  scale: number;
  /** 批次收起態封面：主圖子節點的圖片 URL（宿主從 batchPrimaryImageId 解出） */
  batchPrimaryImageUrl?: string;
  batchExpanded?: boolean;
  /** A12：失敗節點就地重試（沿用保存的生成參數）。 */
  onRetry?: (nodeId: string) => void;
  /** A4：空圖片節點「生成图片」入口。 */
  onEditPrompt: (nodeId: string) => void;
  /** A11：文本節點就地編輯提交（雙擊正文觸發）。 */
  onUpdateText?: (nodeId: string, text: string) => void;
  /**
   * 影片節點動作（2026-09-28）：「截帧」= 取當前播放時刻一幀；「序列帧」= 等距中點抽一組。
   * 宿主負責呼叫 /api/canvas/video-frames 拿計畫、用既有 extractFramesAtTimes 抽像素、落成圖片節點。
   * atSec 由本元件從同一個 <video> 元素的 currentTime 讀出（播放位置只有這裡知道）。
   */
  onExtractVideoFrames?: (nodeId: string, action: "current" | "sequence", atSec?: number) => void;
  /** 取幀進行中：按鈕停用（防重複提交）。 */
  extractingVideoFrames?: boolean;
  /**
   * 分鏡音軌綁定的 metadata 寫入出口（宿主注入＝`use-canvas-chat` 的 `patchNodeMetadata`）。
   * `nodeId` 由本層綁定（同 `onUpdateText` 慣例）後轉給分鏡卡；省略＝分鏡卡不出綁定入口。
   */
  onPatchMetadata?: (nodeId: string, patch: StoryboardShotAudioMetadata) => void;
  /** 內容捲動手勢（use-node-gestures 的 scrollDrag 三件套，綁在正文捲動區上）。 */
  onScrollAreaPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function NodeBody({
  node,
  scale,
  batchPrimaryImageUrl,
  batchExpanded,
  onRetry,
  onEditPrompt,
  onUpdateText,
  onExtractVideoFrames,
  extractingVideoFrames = false,
  onPatchMetadata,
  onScrollAreaPointerDown,
  onScrollAreaPointerMove,
  onScrollAreaPointerEnd,
}: NodeBodyProps) {
  const [imgError, setImgError] = useState(false);
  /** 是否已试过同源代理兜底（直链失败后切代理；代理也失败才落 imgError）。 */
  const [useProxy, setUseProxy] = useState(false);
  // A11：就地編輯態（null = 未在編輯）
  const [editingText, setEditingText] = useState<string | null>(null);
  /** 影片節點：本體那個 <video> 的引用，只為讀 currentTime（「截帧」的取樣時刻）。 */
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 圖片 URL 變更時重置錯誤狀態，重新走「直鏈 → 代理 → 破圖」鏈路
  useEffect(() => {
    setImgError(false);
    setUseProxy(false);
  }, [node.metadata?.content]);

  /** 圖片加載失敗：先切到同源代理試一次，代理也失敗才宣告破圖。 */
  const handleImgError = useCallback(() => {
    setUseProxy((prev) => {
      if (!prev) return true; // 首次失敗 → 切代理
      setImgError(true); // 代理也失敗 → 破圖
      return prev;
    });
  }, []);

  /** 破圖後手動重試：清掉錯誤標記，重新從直鏈開始加載。 */
  const handleRetryImage = useCallback(() => {
    setImgError(false);
    setUseProxy(false);
  }, []);

  const status: CanvasNodeStatus = node.metadata?.status ?? "idle";
  const statusLabel = STATUS_LABEL[status];

  const renderPlaceholder = (statusValue: CanvasNodeStatus, metadata: CanvasNode["metadata"]) => {
    if (statusValue === "loading") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2 border-black/15 border-t-ios-blue motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-ios-subhead text-muted-foreground">生成中…</span>
          {typeof metadata?.progress === "number" && (
            <span className="text-ios-footnote tabular-nums text-foreground/45">{formatProgress(metadata.progress)}</span>
          )}
        </div>
      );
    }
    if (statusValue === "error") {
      // G-FE 合同：errorDetails 带 human_message（中文短句）时优先渲染，缺省回落原文。
      const errorText = errorDetailsText(metadata?.errorDetails);
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-3">
          <span className="text-ios-subhead font-medium text-destructive">失败</span>
          {errorText ? (
            <span className="max-sm:text-ios-footnote break-words text-center text-ios-caption1 leading-snug text-destructive">
              {errorText}
            </span>
          ) : null}
          {onRetry && (
            <button
              type="button"
              data-canvas-interactive
              onClick={(e) => {
                e.stopPropagation();
                onRetry(node.id);
              }}
              className="mt-1 flex items-center gap-1 rounded-full bg-destructive/10 px-3 py-1 text-ios-caption1 font-medium text-destructive hover:bg-destructive/15"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
        </div>
      );
    }
    // reference 節點空態：等待填入圖片（agent 建的空殼或數據異常）。
    if (node.type === CanvasNodeType.Reference && statusValue === "idle") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <ImageIcon className="h-7 w-7 text-foreground/45" aria-hidden="true" />
          <span className="text-ios-caption1 text-muted-foreground">参考图 · 等待填入图片</span>
        </div>
      );
    }
    // A4：空圖片節點是生成落地位——給一個顯眼入口，點開面板就地生成回填。
    if (node.type === CanvasNodeType.Image && statusValue === "idle") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <ImageIcon className="h-7 w-7 text-foreground/45" aria-hidden="true" />
          <button
            type="button"
            data-canvas-interactive
            onClick={(e) => {
              e.stopPropagation();
              onEditPrompt(node.id);
            }}
            className="rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-85"
          >
            生成图片
          </button>
          <span className="text-[11.5px] text-muted-foreground">结果将直接填入此节点</span>
        </div>
      );
    }
    // idle：骨架屏取代死白 —— 卡片一出生就有結構感，不是一塊「待处理」空白。
    return (
      <div className="flex flex-1 flex-col justify-center gap-2.5 p-4" aria-label={statusLabel}>
        <div className="h-3 w-3/4 animate-pulse rounded-full bg-black/5 motion-reduce:animate-none" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-black/5 [animation-delay:120ms] motion-reduce:animate-none" />
        <div className="h-3 w-2/3 animate-pulse rounded-full bg-black/5 [animation-delay:240ms] motion-reduce:animate-none" />
        <span className="mt-1 text-ios-caption1 text-muted-foreground">{statusLabel} · 等待 agent 填充</span>
      </div>
    );
  };

  const renderBody = () => {
    const metadata = node.metadata;
    // 批次收起態封面：主圖頂上，本體內容讓位（展開一鍵可回）。
    // 只在節點自己沒有圖片內容時接管，避免蓋掉圖生圖來源圖。
    const ownImage =
      (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && metadata?.content && isUrl(metadata.content);
    if (batchPrimaryImageUrl && batchExpanded === false && !ownImage) {
      if (imgError) {
        return renderBrokenImage(handleRetryImage);
      }
      return (
        // eslint-disable-next-line @next/next/no-img-element -- 節點批次主圖（blob:/data:/本站 proxy 來源），next/image 無法優化且會綁死節點拖曳縮放版面
        <img
          src={useProxy && batchPrimaryImageUrl.startsWith("http") ? proxySrc(batchPrimaryImageUrl) : batchPrimaryImageUrl}
          alt={`${node.title} 主图`}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover"
          onError={handleImgError}
        />
      );
    }
    // 分鏡實體（2026-09-16 G3 消費端）：`storyboardShot` 是欄位族專用標記（同 sceneCard/
    // director 的處置）。**位置在批次收起封面之後、type 分發之前**，兩個理由：
    //   ①資料形狀由 metadata 決定，不由節點型別決定——契約檔（storyboard-contract.ts:13）只說
    //     「子節點 = 一鏡」，未約束其 type；agent 經 canvas_apply_ops 寫入時 type 可以是
    //     text/image/group 任一，綁 type 分支必漏渲染。
    //   ②放在批次封面早退之後 → 既有批次節點（batchPrimaryImageUrl + 收起）行為零改動。
    // 快照壓縮與讀取白名單已在刀 2 同步，本處只補渲染端（禁動雙白名單）。
    if (metadata?.storyboardShot) {
      return (
        <StoryboardShotBody
          node={node}
          onPatchMetadata={onPatchMetadata ? (patch) => onPatchMetadata(node.id, patch) : undefined}
          onScrollAreaPointerDown={onScrollAreaPointerDown}
          onScrollAreaPointerMove={onScrollAreaPointerMove}
          onScrollAreaPointerEnd={onScrollAreaPointerEnd}
        />
      );
    }
    switch (node.type) {
      case CanvasNodeType.Image:
      case CanvasNodeType.Reference:
      case CanvasNodeType.Video: {
        const media = (() => {
          const content = metadata?.content;
          if (content && isUrl(content)) {
            if (node.type === CanvasNodeType.Video) {
              // 影片節點動作「截帧／序列帧」（2026-09-28）：按鈕貼在畫面左上（原生 controls 佔底部），
              // 樣式沿用既有節點內動作（reference 角色 select / 批次指示器同款黑底白字膠囊）。
              // 回呼未提供 = 不渲染（誠實原則：不長出必定失敗的按鈕）。
              return (
                <div className="relative h-full w-full">
                  <video
                    ref={videoRef}
                    src={content}
                    controls
                    className="h-full w-full object-cover"
                    data-canvas-interactive
                  />
                  {onExtractVideoFrames && (
                    <div
                      data-canvas-interactive
                      className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={extractingVideoFrames}
                        onClick={(e) => {
                          e.stopPropagation();
                          onExtractVideoFrames(node.id, "current", videoRef.current?.currentTime ?? 0);
                        }}
                        title="截取当前播放时刻的一帧，落到画布"
                        className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption2 font-medium text-white transition-colors hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Clapperboard className="h-3 w-3" aria-hidden="true" />
                        {extractingVideoFrames ? "取帧中…" : "截帧"}
                      </button>
                      <button
                        type="button"
                        disabled={extractingVideoFrames}
                        onClick={(e) => {
                          e.stopPropagation();
                          onExtractVideoFrames(node.id, "sequence");
                        }}
                        title="按视频长度等距抽一组帧，落到画布"
                        className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption2 font-medium text-white transition-colors hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Clapperboard className="h-3 w-3" aria-hidden="true" />
                        序列帧
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            if (imgError) {
              return renderBrokenImage(handleRetryImage);
            }
            const rawContent = content.startsWith("data:") ? content : thumbUrl(content, node.width * scale);
            return (
              // eslint-disable-next-line @next/next/no-img-element -- 節點內容圖（data:/縮圖/本站 proxy 來源），next/image 無法優化且會綁死節點拖曳縮放版面
              <img
                src={useProxy && content.startsWith("http") ? proxySrc(content) : rawContent}
                alt={node.title}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="h-full w-full object-cover"
                onError={handleImgError}
              />
            );
          }
          return renderPlaceholder(status, metadata);
        })();
        // 模板生成卡（agent-template-canvas 铺的流水线）：标题是 shortName，
        // 卡身顶部补完整步骤名，画布上任何缩放级别都不丢上下文。
        // 2026-08-27 美化：步骤序号用小圆徽章（与 carousel 卡面珠链呼应），
        // 非纯文字前缀。
        // Reference 早退（無步驟語義）；Image 與 Video 生成卡都鋪步驟名橫條
        // （2026-08-30 起視頻步生成卡為 Video 類型，同樣帶 stepName trace）。
        if (node.type === CanvasNodeType.Reference) return media;
        const trace = metadata as unknown as Record<string, unknown> | undefined;
        const stepName = trace?.stepName;
        if (typeof stepName !== "string" || stepName.length === 0) return media;
        const stepIndex = typeof trace?.stepIndex === "number" ? (trace.stepIndex as number) : Number.NaN;
        return (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-black/5 bg-black/[0.03] px-3 py-1.5 text-ios-caption1 font-medium text-foreground/60">
              {!Number.isNaN(stepIndex) && (
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ios-blue/[0.12] text-[10.5px] font-semibold leading-none text-ios-blue">
                  {stepIndex + 1}
                </span>
              )}
              <span className="min-w-0 truncate">{stepName}</span>
            </div>
            <div className="min-h-0 flex-1">{media}</div>
          </div>
        );
      }
      case CanvasNodeType.Audio: {
        const content = metadata?.content;
        if (content && isUrl(content)) {
          return (
            <div className="flex flex-1 items-center justify-center p-3">
              <audio src={content} controls className="w-full" data-canvas-interactive />
            </div>
          );
        }
        return renderPlaceholder(status, metadata);
      }
      case CanvasNodeType.CharacterCard:
      case CanvasNodeType.SceneCard: {
        const description = metadata?.description ?? metadata?.content ?? "";
        const features = metadata?.key_features ?? [];
        return (
          <div
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
            className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2 overflow-auto p-3"
          >
            {metadata?.locked && (
              <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-ios-caption2 font-medium text-muted-foreground">
                已锁定 · 结果不再重生成
              </span>
            )}
            {description.trim() ? (
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-muted-foreground"><EntityText text={description} /></p>
            ) : (
              <span className="text-ios-caption1 text-muted-foreground">（未填写描述）</span>
            )}
            {features.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {features.map((f) => (
                  <span key={f} className="rounded-full bg-ios-blue/10 px-2 py-0.5 text-[11.5px] text-ios-blue">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }
      case CanvasNodeType.Text:
      case CanvasNodeType.Prompt: {
        const text = metadata?.content ?? metadata?.prompt;
        const fontSize = typeof metadata?.fontSize === "number" ? metadata.fontSize : 14.5;
        // prompt 節點 = 提示詞備忘：雙擊直編（與文本節點同款交互），文案不同。
        // 流水線文本生成卡（2026-08-30）：空態不再是「未填寫」而是等 agent 回填。
        const metaRecord = metadata as Record<string, unknown> | undefined;
        const isPipelineGenCard = typeof metaRecord?.stepIndex === "number";
        const emptyHint =
          node.type === CanvasNodeType.Prompt
            ? "（未填写提示词，双击编辑）"
            : isPipelineGenCard && node.type === CanvasNodeType.Text
              ? "等待 agent 回填产出"
              : "（未填写内容，双击编辑）";
        // 後端骨架 text 節點（如「镜头 1 脚本」）也會帶產出合同：複用步驟頭卡膠囊樣式。
        const deliverableText = metadata?.deliverable?.trim();
        // A11：雙擊直編。textarea 蓋滿正文區，blur/Ctrl+Enter 提交、Esc 取消。
        if (editingText !== null) {
          return (
            <textarea
              data-canvas-interactive
              autoFocus
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  setEditingText(null);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  if (editingText !== (text ?? "")) onUpdateText?.(node.id, editingText);
                  setEditingText(null);
                }
              }}
              onBlur={() => {
                if (editingText !== (text ?? "")) onUpdateText?.(node.id, editingText);
                setEditingText(null);
              }}
              className="flex-1 resize-none whitespace-pre-wrap break-words border-0 bg-ios-blue/5 p-3 leading-relaxed text-foreground outline-none"
              style={{ fontSize }}
              aria-label="编辑文本内容"
            />
          );
        }
        // 流水線結構卡（agent-template-canvas 鋪的）：走 Liquid Glass 分層正文
        // （eyebrow 小标 + 正文 + 语义色胶囊 + Lucide 图标），不再纯文本堆行。
        // note（配方卡，後端 derived notes）：正文 = content 多行配方文本，
        // 無 toolId/IO 行——與 tool/gate 卡同族分層樣式。
        const pipelineCard = metadata?.pipelineCard;
        if (pipelineCard === "tool" || pipelineCard === "gate" || pipelineCard === "note") {
          return (
            <div
              onPointerDown={onScrollAreaPointerDown}
              onPointerMove={onScrollAreaPointerMove}
              onPointerUp={onScrollAreaPointerEnd}
              onPointerCancel={onScrollAreaPointerEnd}
              className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2.5 overflow-auto p-3"
            >
              {pipelineCard === "tool" ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Wrench className="h-3 w-3 shrink-0 text-ios-blue" aria-hidden="true" />
                    <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">工具</span>
                  </div>
                  <p className="break-all font-mono text-[13px] font-semibold leading-snug text-foreground">{metadata?.toolId}</p>
                  {metadata?.toolInput && (
                    <div className="flex items-start gap-1.5">
                      <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                      <p className="min-w-0 break-words text-[13px] leading-snug text-muted-foreground">{metadata.toolInput}</p>
                    </div>
                  )}
                  {metadata?.toolOutput && (
                    <div className="flex items-start gap-1.5">
                      <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-ios-green" aria-hidden="true" />
                      <p className="min-w-0 break-words text-[13px] leading-snug text-muted-foreground">{metadata.toolOutput}</p>
                    </div>
                  )}
                  {!metadata?.toolInput && !metadata?.toolOutput && (
                    <span className="inline-flex items-center rounded-full bg-black/5 px-2 py-0.5 text-[11.5px] font-medium leading-none text-muted-foreground">
                      平台原生工具
                    </span>
                  )}
                  {metadata?.unsupported && (
                    <div className="flex items-start gap-1.5 rounded-lg bg-[rgba(255,59,48,0.08)] px-2 py-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-ios-red" aria-hidden="true" />
                      <p className="min-w-0 break-words text-[13px] leading-snug text-ios-red">
                        harness 未接上游（{metadata.requiredCapability ?? metadata.toolId ?? "未知能力"}）——agent 须明说不可用，禁止用 prompt 冒充
                      </p>
                    </div>
                  )}
                </>
              ) : pipelineCard === "gate" ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="h-3 w-3 shrink-0 text-ios-orange" aria-hidden="true" />
                    <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">验收条件</span>
                  </div>
                  <p className="break-words text-[13px] leading-relaxed text-foreground"><EntityText text={text ?? ""} /></p>
                  {metadata?.gateConfirm && <GateConfirmActions confirm={metadata.gateConfirm} />}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <Lightbulb className="h-3 w-3 shrink-0 text-[#B96A00]" aria-hidden="true" />
                    <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">配方</span>
                  </div>
                  {text?.trim() ? (
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground"><EntityText text={text} /></p>
                  ) : (
                    <span className="text-ios-caption1 text-muted-foreground">（未填写配方）</span>
                  )}
                </>
              )}
            </div>
          );
        }
        return (
          <div
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
            onDoubleClick={(e) => {
              if (!onUpdateText) return;
              e.stopPropagation();
              setEditingText(text ?? "");
            }}
            title={onUpdateText ? "双击编辑文字" : undefined}
            className="canvas-node-scroll touch-pan-y overscroll-contain overflow-auto whitespace-pre-wrap break-words p-3 leading-relaxed text-foreground"
            style={{ fontSize }}
          >
            {deliverableText ? (
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(52,199,89,0.12)] px-2 py-0.5 text-[11.5px] font-medium leading-none text-[#248A3D]">
                  <Package className="h-3 w-3" aria-hidden="true" />
                  产出
                </span>
                <p className="mt-1.5 break-words text-[13px] leading-relaxed text-foreground">{deliverableText}</p>
                {text?.trim() ? (
                  <p className="mt-1.5 whitespace-pre-wrap break-words"><EntityText text={text} /></p>
                ) : (
                  <span className="mt-1.5 block text-ios-caption1 text-muted-foreground">{emptyHint}</span>
                )}
              </>
            ) : text?.trim() ? (
              <EntityText text={text} />
            ) : (
              <span className="text-ios-caption1 text-muted-foreground">{emptyHint}</span>
            )}
          </div>
        );
      }
      case CanvasNodeType.Config: {
        const rows: { label: string; value: string }[] = [];
        if (metadata?.model) rows.push({ label: "模型", value: metadata.model });
        if (metadata?.size) rows.push({ label: "尺寸", value: metadata.size });
        if (metadata?.quality) rows.push({ label: "质量", value: metadata.quality });
        if (typeof metadata?.count === "number") rows.push({ label: "数量", value: String(metadata.count) });
        if (metadata?.kind) rows.push({ label: "类型", value: metadata.kind });
        if (metadata?.source_image) rows.push({ label: "参考图", value: metadata.source_image });
        // content 文本（模板步骤头卡的「产出：」合同）与结构化行可并存；
        // 只有 content 也照常渲染——空配置才落骨架。
        const content = metadata?.content?.trim() ?? "";
        // 後端 workflow 骨架節點的產出合同/驗收門禁（SSE 放行，2026-09-20）：
        // 複用步驟頭卡的膠囊樣式（Package 綠膠囊 + 全文），門禁走灰小字行。
        const deliverableText = metadata?.deliverable?.trim();
        // gate 兩種形態（types.ts 註解）：string = 後端骨架門禁全文；boolean true =
        // workflow-dsl 的「需人工批准」旗標（compile.ts md.gate = true），顯示通用文案。
        const gateText =
          typeof metadata?.gate === "string" ? metadata.gate.trim() : metadata?.gate === true ? "此步骤需要人工批准后才继续" : undefined;
        // 流水線步驟頭卡（agent-template-canvas 鋪的）：Liquid Glass 分層正文
        // ——「产出」green tint 胶囊（Package 图标）+ deliverable 全文 + 输入来源行。
        // 後端骨架 Config 節點帶 metadata.deliverable/gate（2026-09-20 SSE 放行）時
        // 走同一分層（膠囊樣式逐行複用），不另造卡型。
        if (metadata?.pipelineCard === "step_head" || deliverableText || gateText) {
          const deliverable = deliverableText || (metadata?.content ?? "").replace(/^产出：/, "");
          return (
            <div
              onPointerDown={onScrollAreaPointerDown}
              onPointerMove={onScrollAreaPointerMove}
              onPointerUp={onScrollAreaPointerEnd}
              onPointerCancel={onScrollAreaPointerEnd}
              className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2.5 overflow-auto p-3"
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(52,199,89,0.12)] px-2 py-0.5 text-[11.5px] font-medium leading-none text-[#248A3D]">
                <Package className="h-3 w-3" aria-hidden="true" />
                产出
              </span>
              {deliverable ? (
                <p className="break-words text-[13px] leading-relaxed text-foreground">{deliverable}</p>
              ) : (
                <span className="text-ios-caption1 text-muted-foreground">（未定义产出合同）</span>
              )}
              {metadata?.inputFrom && (
                <div className="flex items-start gap-1.5">
                  <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                  <p className="min-w-0 break-words text-[13px] leading-snug text-muted-foreground">
                    <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">输入</span>
                    <span className="ml-1.5">{metadata.inputFrom}</span>
                  </p>
                </div>
              )}
              {gateText && (
                <p className="break-words text-ios-caption1 leading-relaxed text-muted-foreground">
                  <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">门禁</span>
                  <span className="ml-1.5">{gateText}</span>
                </p>
              )}
            </div>
          );
        }
        if (rows.length === 0 && !content) {
          // 配置未到齊 = 讀取中的骨架，不是死掉的「（未配置）」。
          return renderPlaceholder(status, metadata);
        }
        return (
          <div
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
            className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-1.5 overflow-auto p-3"
          >
            {rows.map((row) => (
              // 值緊貼標籤左對齊（2026-09-27）：右對齊時節點半截出視口，值被裁掉像空欄位。
              <div key={row.label} className="flex items-baseline gap-3">
                <span className="w-12 shrink-0 text-[12.5px] font-medium text-muted-foreground">{row.label}</span>
                <span className="min-w-0 max-sm:text-ios-subhead truncate font-mono text-ios-footnote text-foreground">
                  {row.value}
                </span>
              </div>
            ))}
            {content && (
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-foreground"><EntityText text={content} /></p>
            )}
          </div>
        );
      }
      case CanvasNodeType.Director: {
        // 導演台節點（gateway director.done 攔截同步）：主區為 three.js 即時 3D 白模
        // 視口（片B，WebGL 失敗降級 SVG 示意）；缺 directorSessionId 的舊節點保底走
        // 原 SVG img 形狀。徽章區/方案名現狀保留。長文捲動手勢與角色/場景卡同款
        //（canvas-node-scroll + scrollDrag 三件套；viewport 自帶 data-canvas-interactive 隔離）。
        const topView = svgToDataUrl(metadata?.topViewSvg);
        const cameraView = svgToDataUrl(metadata?.cameraViewSvg);
        const schematic = topView ?? cameraView;
        const planName = metadata?.planName ?? null;
        const directorSessionId = metadata?.directorSessionId;
        return (
          <div
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
            className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2 overflow-auto p-3"
          >
            <div className="flex items-center gap-1.5">
              <Clapperboard className="h-3 w-3 shrink-0 text-[#0E7FA8]" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">
                {planName ? planName : "导演台"}
              </span>
            </div>
            {directorSessionId ? (
              <DirectorMiniViewport
                sessionId={directorSessionId}
                revision={metadata?.revision}
                topViewSvg={topView}
                cameraViewSvg={cameraView}
                className="h-[200px]"
              />
            ) : topView && cameraView ? (
              <div className="grid grid-cols-2 gap-1.5">
                <div className="overflow-hidden rounded bg-[#0b0f14]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={topView}
                    alt="导演台俯视示意图"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="h-[110px] w-full object-contain"
                  />
                </div>
                <div className="overflow-hidden rounded bg-[#0b0f14]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={cameraView}
                    alt="导演台镜头框图"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="h-[110px] w-full object-contain"
                  />
                </div>
              </div>
            ) : schematic ? (
              <div className="overflow-hidden rounded-[12px] bg-[#0b0f14]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={schematic}
                  alt={topView ? "导演台俯视示意图" : "导演台镜头框图"}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="h-[130px] w-full object-contain"
                />
              </div>
            ) : (
              <div className="flex h-[92px] items-center justify-center rounded-[12px] bg-black/[0.04]">
                <span className="text-ios-caption1 text-muted-foreground">示意图未同步 · 让 agent 重新规划</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {typeof metadata?.shotCount === "number" && (
                <span className="rounded-full bg-[rgba(90,200,250,0.14)] px-2 py-0.5 text-[11.5px] font-medium leading-none text-[#0E7FA8]">
                  {metadata.shotCount} 镜头
                </span>
              )}
              {metadata?.healthOk === true ? (
                <span className="rounded-full bg-[rgba(52,199,89,0.12)] px-2 py-0.5 text-[11.5px] font-medium leading-none text-[#248A3D]">
                  分镜健康
                </span>
              ) : metadata?.healthOk === false ? (
                <span className="rounded-full bg-[rgba(255,149,0,0.14)] px-2 py-0.5 text-[11.5px] font-medium leading-none text-[#B96A00]">
                  待修正
                </span>
              ) : null}
            </div>
          </div>
        );
      }
      case CanvasNodeType.Scene3d: {
        // 3D 場景卡（Astra PRD P1-3）：主體=turntable 視頻+stills 網格+資產下載，
        // 全部封裝在 Scene3dCardBody（複製 Video 分支輪子），此處只做型別分發。
        return <Scene3dCardBody node={node} />;
      }
      case CanvasNodeType.Group: {
        // 分鏡場景外殼（G3，2026-09-16）：Group 節點帶 metadata.storyboardScene 時，
        // 正文顯示場景名 + 鏡數（真值在子節點的 storyboardShot，此處只是指針）；
        // 無此欄位的既有 Group 節點維持原虛線框佔位（行為零改動）。
        if (metadata?.storyboardScene) {
          return (
            <StoryboardSceneBody
              node={node}
              onScrollAreaPointerDown={onScrollAreaPointerDown}
              onScrollAreaPointerMove={onScrollAreaPointerMove}
              onScrollAreaPointerEnd={onScrollAreaPointerEnd}
            />
          );
        }
        return (
          <div className="m-3 flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-black/10">
            <span className="px-3 text-center text-ios-footnote font-medium text-muted-foreground">{node.title}</span>
          </div>
        );
      }
    }
  };

  return renderBody();
}
