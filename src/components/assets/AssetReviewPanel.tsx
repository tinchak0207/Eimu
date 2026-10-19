"use client";

// 资产审查面板（2026-09-24，能力建设／加法）：把「资产图确认」这道线下必经流程做成可操作的介面。
//
// 依据（决策定稿 24 条，见 memory 2026-09-24-asset-confirmation-gate-absent-root-cause.md）：
//   3  逐张可改、批准动作整批一次
//   4  驳回＝填理由后**停下**（存下理由、不自动重生成、不擅自花钱）
//   6  用户上传自有素材＝**直接覆盖原图**（不并存、不做变体）
//   7  上传后原样使用（用户的图即权威）
//   9  导出＝CSV 清单 ＋ 图片压缩包（明确不做 PDF 审批单）
//   11 重生成**不过扣费确认卡**，直接扣；按钮显示单价（决策 16 同义）
//   2  全自动档（preset/auto）下同一面板可看可改、**不阻塞流程**；协作档才配合停点
//
// 轮子（禁止自造，逐条列来源）：
//   - 面板壳／弹层语汇：`src/components/assets/ProjectAssetLibraryPanel.tsx:211-242`（lg-sheet + 右侧滑入 + 标题列）
//   - 缩图＋点击放大：`src/components/ReferenceImageUpload.tsx:171-186`（缩图按钮）＋ `src/components/ImageLightbox.tsx`（全屏灯箱）
//   - 上传控件：`src/components/ReferenceImageUpload.tsx:153`（按钮语汇；档案→dataURL 由父层走 `embed-helpers.fileToDataUrl`）
//   - CSV 转义／下载：`src/lib/history-export.ts` 的 `csvCell` / `triggerDownload`（本刀把它们导出化；**零自创转义逻辑**）
//   - 图片压缩包：`src/lib/export-zip.ts:38` `exportShotsZip()` 直接用
//   - 单价：`src/lib/generation-model-catalog` 的 `modelPriceLabel`（与站内选模价签同一把尺）
//
// 批准状态栏位：形状**由路 1 定义并冻结**，且已落地为 `src/lib/character-cards.ts` 的 `ApprovalState`
// ＋判定尺 `isAssetApproved` ＋写入轮子 `setApproval`／`normalizeApprovalState`
// （分镜侧 storyboard-contract.ts 明文「禁止另建第二套」）。本档**直接消费该真源**：
//   读取 → `approvalStatusOf`（纯投影）／门槛 → `isAssetApproved`／写回 → 父层 `setApproval`。
// 写回路径由父层（`upsertCharacterCard`）负责，本档不自行伪造持久化。

import { useCallback, useMemo, useRef, useState } from "react";
import { Check, Download, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { CHARACTER_CARD_KIND_LABEL, isAssetApproved } from "@/lib/character-cards";
import type { ApprovalState, CharacterCard } from "@/lib/character-cards";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import { modelPriceLabel } from "@/lib/generation-model-catalog";
import { exportShotsZip } from "@/lib/export-zip";
import { IMAGE_FETCH_TIMEOUT_MS, imageHelpers } from "@/lib/image-helpers";
import { csvCell, triggerDownload } from "@/lib/history-export";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────── 冻结契约（只消费，不定义）

/**
 * 批准状态的**型别真源在 `@/lib/character-cards`**（`ApprovalState`；分镜侧 storyboard-contract
 * 也是同一个 shape，该档明文「禁止另建第二套」）。本档直接 import 真源、只做读取投影，
 * 判定一律走真源的 `isAssetApproved`（不重写第二套门槛尺）。
 */
export type { ApprovalState } from "@/lib/character-cards";

/**
 * 显示用读取投影（**不是判定**）：把 `approval` 投影成三态标签。
 * 缺省＝已批准（决策 23 存量相容）；读不懂的值同样落回「已批准」
 * （与真源 `normalizeApprovalState` 的 fail-open 方向一致：脏资料不该让存量资产突然被当未批准）。
 * 「会不会挡流程」由 `reviewStopBehavior` 问真源 `isAssetApproved`，本函式不参与门槛判定。
 */
export function approvalStatusOf(record: { approval?: ApprovalState } | null | undefined): ApprovalState["status"] {
  const approval = record?.approval;
  if (!approval) return "approved";
  if (approval.status === "approved" || approval.status === "pending" || approval.status === "rejected") {
    return approval.status;
  }
  // 契约外的值（理论上到不了这里：真源 `normalizeApprovalState` 在写入/读取端就把键丢掉）。
  // 万一漏进来，**与门槛同向**显示「待批准」——`isAssetApproved` 对认不得的值回 false（会挡），
  // 面板若显示「已批准」就是对用户说谎。这不是第二把尺：门槛仍然只由 `isAssetApproved` 决定。
  return "pending";
}

// ─────────────────────────────────────────── 档位（决策 1/2）

/**
 * 档位语义（决策 1/2）：**停点只在协作档生效**；全自动档（preset/auto）可看可改、不阻塞流程。
 * `stops` **直接问真源** `isAssetApproved`（拿一张显式 `pending` 的卡试，该档就是门槛尺本身）——
 * 面板不重写第二套档位判定；横幅文案才在本地。
 */
export function reviewStopBehavior(mode: AgentInteractionMode): { stops: boolean; note: string } {
  const wouldBlock = !isAssetApproved({ status: "pending" }, mode);
  return wouldBlock
    ? {
        stops: true,
        note: "协作档：资产图是流程停点——未批准的资产会挡住后续分镜／视频，确认后可继续。",
      }
    : {
        stops: false,
        note: "全自动档：资产图可看可改，不阻塞流程（换掉的图只影响后续镜头）。",
      };
}

/** 审查摘要（面板页首计数）。 */
export function reviewSummary(records: readonly { approval?: ApprovalState }[]): {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
} {
  const out = { total: records.length, approved: 0, pending: 0, rejected: 0 };
  for (const record of records) out[approvalStatusOf(record)] += 1;
  return out;
}

// ─────────────────────────────────────────── 逐张操作（纯函式，供测试与父层落地）

/**
 * 覆盖原图（决策 6/7）：既有 index → 换掉该格（不并存、不做变体、不动其他栏位）；
 * index ≥ 长度 → 补位（资产图还没生出来时，用户自带素材是唯一的路）。
 * 只换 url：role/name 逐字保留（原样使用，不动既有 DNA 签名）。
 */
export function applyReplaceReference(card: CharacterCard, referenceIndex: number, url: string): CharacterCard {
  const references = [...card.references];
  if (referenceIndex >= 0 && referenceIndex < references.length) {
    references[referenceIndex] = { ...references[referenceIndex], url };
  } else {
    references.push({ url, role: "general", name: card.name });
  }
  return { ...card, references, updatedAt: new Date().toISOString() };
}

/**
 * 重生成请求 payload（决策 11：直接扣费、不过确认卡）。
 *   - prompt＝卡自己的锁定片段（不编造新提示词）
 *   - 参考图＝该卡**其余**参考图（不含正在重生成的那张：拿坏图当参考会把错误传染下去）
 *   - 卡注入走 `cards: []`（＝不注入）——卡的片段与参考图已在本 payload 显式给定，
 *     再注入一次会让同一张图同时当「要被换掉的目标」与「参考」。
 */
export function buildAssetRegeneratePayload(
  card: CharacterCard,
  referenceIndex: number,
  modelId: string = DEFAULT_IMAGE_MODEL_ID,
): Record<string, unknown> {
  return {
    prompt: card.prompt,
    model: modelId,
    count: 1,
    ...(card.negativePrompt ? { negative_prompt: card.negativePrompt } : {}),
    reference_images: card.references
      .filter((_, index) => index !== referenceIndex)
      .map(({ url, role, name }) => ({ url, role, name })),
  };
}

// ─────────────────────────────────────────── 导出（决策 9）

/** 汇出日期戳（本地日）。 */
function stamp(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

const ASSET_CSV_HEADER = ["资产名", "类型", "审核状态", "驳回理由", "参考图数量", "参考图链接", "描述"] as const;

/**
 * 资产清单 CSV 字串（纯函式，可直测）：只提供 header/rows 白名单，
 * 转义走轮子 `csvCell`、行尾 CRLF、前置 BOM（Excel 读 UTF-8 中文必需）——与站内既有 CSV 逐字同构。
 */
export function buildAssetReviewCsv(records: readonly CharacterCard[]): string {
  const rows = records.map((card) =>
    [
      csvCell(card.name),
      csvCell(CHARACTER_CARD_KIND_LABEL[card.kind]),
      csvCell(approvalStatusOf(card)),
      csvCell(card.approval?.reason),
      csvCell(card.references.length),
      csvCell(card.references.map((ref) => ref.url).join(" ")),
      csvCell(card.prompt),
    ].join(","),
  );
  return `\ufeff${[ASSET_CSV_HEADER.join(","), ...rows].join("\r\n")}`;
}

/** 下载资产清单 CSV（空清单＝不产生档案，与 `exportHistoryCsv` 同款守卫）。 */
export function exportAssetReviewCsv(records: readonly CharacterCard[], at: Date = new Date()): void {
  if (!records.length) return;
  triggerDownload(buildAssetReviewCsv(records), `资产清单-${stamp(at)}.csv`, "text/csv;charset=utf-8");
}

/** 图片压缩包清单（纯函式）：逐张参考图一项，名称 = `卡名-序号`（副档名/去重由 `exportShotsZip` 负责）。 */
export function assetZipPlan(records: readonly CharacterCard[]): { fileName: string; url: string }[] {
  return records.flatMap((card) =>
    card.references.map((ref, index) => ({ fileName: `${card.name}-${index + 1}`, url: ref.url })),
  );
}

/** 取图成 blob；失败回 null（取不到的图跳过并计数，不让整包失败——与 `exportHistoryZip` 同语义）。
 *
 * 2026-10-04（禁造轮子＋永久 pending 族）：不再自拼 `fetch(url)`（缺 ?dl=1/no-store
 * 的 CORS 修复、无 timeout，上游半开连线会永久 pending），改用单一真源
 * `imageHelpers.fetchImageResponse`。失败／逾时仍吞成 null → skipped，UI 行为不变。
 */
async function referenceBlob(url: string, timeoutMs: number): Promise<Blob | null> {
  try {
    const response = await imageHelpers.fetchImageResponse(url, timeoutMs);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** 导出图片压缩包：直接用轮子 `exportShotsZip()`（打包/去重/副档名白名单一律不在本档重写）。 */
export async function exportAssetReviewZip(
  records: readonly CharacterCard[],
  at: Date = new Date(),
  // 仅由测试注入缩短值（模拟逾时）；生产走 fetchImageResponse 的预设上限。
  fetchTimeoutMs: number = IMAGE_FETCH_TIMEOUT_MS,
): Promise<{ exported: number; skipped: number }> {
  const plan = assetZipPlan(records);
  if (!plan.length) return { exported: 0, skipped: 0 };
  const fetched = await Promise.all(
    plan.map(async (item) => {
      const blob = await referenceBlob(item.url, fetchTimeoutMs);
      return blob ? { name: item.fileName, blob } : null;
    }),
  );
  const items = fetched.filter((item): item is { name: string; blob: Blob } => item !== null);
  const skipped = plan.length - items.length;
  if (!items.length) return { exported: 0, skipped };
  await exportShotsZip(items, `资产图-${stamp(at)}.zip`);
  return { exported: items.length, skipped };
}

// ─────────────────────────────────────────── 外部开启介面（画布工具列以外的第二入口用）

/** 审查面（两面板共用同一颗画布入口）。 */
export type ReviewPanelKind = "asset" | "shot";

/** 开启事件名（`window` 上的 CustomEvent；CanvasEmbed 挂监听）。 */
export const REVIEW_PANEL_OPEN_EVENT = "canvas-open-review-panel";

export interface ReviewPanelOpenDetail {
  panel: ReviewPanelKind;
  /** 可选：开面板时要聚焦的资产／镜次 id。 */
  focusId?: string;
}

/**
 * 外部开启介面（给路 4 的步骤条／任何不在 CanvasEmbed 内的呼叫端）：
 * 派发 CustomEvent，由 CanvasEmbed 的面板宿主接收并开启对应审查面。
 * 回传 `true`＝事件已派发（**不代表面板已开**——没有宿主挂载时无人接收，这是诚实回报）。
 */
export function openReviewPanel(options: { panel?: ReviewPanelKind; focusId?: string } = {}): boolean {
  if (typeof window === "undefined") return false;
  const detail: ReviewPanelOpenDetail = {
    panel: options.panel ?? "asset",
    ...(options.focusId ? { focusId: options.focusId } : {}),
  };
  window.dispatchEvent(new CustomEvent<ReviewPanelOpenDetail>(REVIEW_PANEL_OPEN_EVENT, { detail }));
  return true;
}

// ─────────────────────────────────────────── 面板

export interface AssetReviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** 待审查的资产（卡实体；references ＝ 逐张参考图）。 */
  cards: readonly CharacterCard[];
  /** 本画布锁定生效中的卡 id（仅显示徽章，不放行任何写入）。 */
  activeCardIds?: readonly string[];
  /** 当前互动档位（决策 1/2：只有 collaborate 是停点）。 */
  interactionMode: AgentInteractionMode;
  /** 重生成单价／请求用的模型。 */
  modelId?: string;
  /**
   * 逐张重生成（决策 11：直接扣费、不过确认卡）。父层负责落地 `applyReplaceReference`；
   * 回传 null＝失败或无图（面板不谎报成功）。
   */
  onRegenerate: (cardId: string, referenceIndex: number) => Promise<{ url: string; costCoins?: number } | null>;
  /** 用户上传自有素材＝直接覆盖原图（决策 6）；父层负责压缩与写回。 */
  onReplace: (cardId: string, referenceIndex: number, file: File) => Promise<boolean>;
  /** 驳回（决策 4）：带理由；**不触发重生成**。 */
  onReject: (cardId: string, reason: string) => Promise<void> | void;
  /** 整批一键批准（决策 3）。 */
  onApproveAll: (cardIds: readonly string[]) => Promise<void> | void;
  /** 切到分镜审查（同一颗画布入口底下的另一面；缺省＝不显示该按钮）。 */
  onSwitchToShots?: () => void;
}

export function AssetReviewPanel({
  open,
  onClose,
  cards,
  activeCardIds = [],
  interactionMode,
  modelId = DEFAULT_IMAGE_MODEL_ID,
  onRegenerate,
  onReplace,
  onReject,
  onApproveAll,
  onSwitchToShots,
}: AssetReviewPanelProps) {
  /** 灯箱：{ src, alt }；null＝关闭。 */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  /** 逐张忙碌（`${cardId}#${index}`）：重生成／上传共用一格。 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 驳回输入：正在填理由的卡 id（决策 4：先填理由，再停下）。 */
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** 上传目标（隐藏 input 用；file 选好后才知道是哪张卡的哪一格）。 */
  const uploadTargetRef = useRef<{ cardId: string; index: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => reviewSummary(cards), [cards]);
  const behavior = reviewStopBehavior(interactionMode);
  const unitPrice = useMemo(() => modelPriceLabel(modelId), [modelId]);

  const handleRegenerate = useCallback(
    async (cardId: string, index: number) => {
      const key = `${cardId}#${index}`;
      setBusyKey(key);
      setNotice(null);
      try {
        const result = await onRegenerate(cardId, index);
        setNotice(
          result
            ? `已重新生成 1 张（${result.costCoins !== undefined ? `${result.costCoins} 币` : "计费以上游回执为准"}）`
            : "重新生成失败，原图未改动",
        );
      } finally {
        setBusyKey(null);
      }
    },
    [onRegenerate],
  );

  const handlePickFile = useCallback((cardId: string, index: number) => {
    uploadTargetRef.current = { cardId, index };
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (file: File | undefined) => {
      const target = uploadTargetRef.current;
      uploadTargetRef.current = null;
      if (!file || !target) return;
      const key = `${target.cardId}#${target.index}`;
      setBusyKey(key);
      setNotice(null);
      try {
        const ok = await onReplace(target.cardId, target.index, file);
        setNotice(ok ? "已用你上传的图覆盖原图（原样使用，不改生成参数）" : "上传失败，原图未改动");
      } finally {
        setBusyKey(null);
      }
    },
    [onReplace],
  );

  const handleConfirmReject = useCallback(
    async (cardId: string) => {
      const reason = rejectReason.trim();
      if (!reason) {
        setNotice("驳回需要填理由（会原样存档，供后续改图）");
        return;
      }
      await onReject(cardId, reason);
      setRejectingId(null);
      setRejectReason("");
      setNotice("已驳回并停下：不会自动重生成，等你说明怎么改");
    },
    [onReject, rejectReason],
  );

  const handleApproveAll = useCallback(async () => {
    await onApproveAll(cards.map((card) => card.id));
    setNotice(`已整批批准 ${cards.length} 张资产`);
  }, [onApproveAll, cards]);

  const handleExportZip = useCallback(async () => {
    setNotice(null);
    const result = await exportAssetReviewZip(cards);
    setNotice(
      result.exported === 0
        ? "没有可取到的图（压缩包未生成）"
        : `已导出 ${result.exported} 张图片${result.skipped > 0 ? `，跳过 ${result.skipped} 张取不到的` : ""}`,
    );
  }, [cards]);

  if (!open) return null;

  return (
    <div
      data-canvas-interactive
      role="dialog"
      aria-label="资产审查"
      className="lg-sheet pointer-events-auto fixed z-[86] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-ios-2xl"
      style={{
        right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
        top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
        maxHeight: "min(74dvh, 600px)",
      }}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-ios-caption1 font-semibold text-foreground">资产审查</p>
          <p className="mt-0.5 text-ios-caption2 leading-snug text-foreground/45">
            逐张看、逐张改；批准动作整批一次
          </p>
        </div>
        {onSwitchToShots && (
          <button
            type="button"
            onClick={onSwitchToShots}
            className="shrink-0 cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-ios-caption2 font-medium text-muted-foreground hover:bg-black/10"
          >
            分镜审查
          </button>
        )}
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="shrink-0 cursor-pointer rounded-lg p-1 text-foreground/45 hover:bg-black/5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 档位横幅（决策 1/2）：全自动档只是说明，不新增任何阻塞 */}
      <p
        className={cn(
          "border-b px-3 py-1.5 text-ios-footnote leading-snug",
          behavior.stops ? "bg-[rgba(255,149,0,0.10)] text-[#B25E00]" : "bg-black/[0.03] text-foreground/45",
        )}
      >
        {behavior.note}
      </p>

      <p className="border-b px-3 py-1.5 text-ios-caption2 text-foreground/45">
        共 {summary.total} 张资产 · 已批准 {summary.approved} · 待批准 {summary.pending} · 已驳回 {summary.rejected}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {cards.length === 0 ? (
          <p className="px-3.5 py-4 text-ios-caption1 text-foreground/45">
            还没有资产图。等生成出角色／场景图，或右键节点「存为卡并锁定」。
          </p>
        ) : (
          cards.map((card) => {
            const status = approvalStatusOf(card);
            const active = activeCardIds.includes(card.id);
            return (
              <div key={card.id} className="border-b px-3 py-2.5 last:border-b-0">
                <p className="flex items-center gap-1.5 truncate text-ios-caption1 font-medium text-foreground">
                  <span className="truncate">{card.name}</span>
                  <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                    {CHARACTER_CARD_KIND_LABEL[card.kind]}
                  </span>
                  {active && (
                    <span className="shrink-0 rounded-full bg-ios-green/10 px-1.5 py-0.5 text-ios-caption2 text-[#248A3D]">
                      生效中
                    </span>
                  )}
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-ios-caption2",
                      status === "approved"
                        ? "bg-ios-green/10 text-[#248A3D]"
                        : status === "rejected"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-[rgba(255,149,0,0.12)] text-[#B25E00]",
                    )}
                  >
                    {status === "approved" ? "已批准" : status === "rejected" ? "已驳回" : "待批准"}
                  </span>
                </p>
                {card.prompt && (
                  <p className="mt-0.5 line-clamp-2 text-ios-caption2 leading-snug text-foreground/45">{card.prompt}</p>
                )}

                {/* 缩图墙（GM 视角：逐张可看，不是只有「N 张参考图」） */}
                {card.references.length === 0 ? (
                  <p className="mt-1.5 text-ios-caption2 text-foreground/45">这张资产还没有图</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {card.references.map((ref, index) => {
                      const busy = busyKey === `${card.id}#${index}`;
                      return (
                        <div key={`${card.id}-${index}`} className="w-[76px]">
                          <button
                            type="button"
                            onClick={() => setLightbox({ src: ref.url, alt: `${card.name} 参考图 ${index + 1}` })}
                            title={`预览 ${card.name} 参考图 ${index + 1}`}
                            className="block h-[76px] w-[76px] cursor-zoom-in overflow-hidden rounded-ios-md bg-black/5"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={ref.url} alt={`${card.name} 参考图 ${index + 1}`} className="h-full w-full object-cover" />
                          </button>
                          <div className="mt-1 flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRegenerate(card.id, index)}
                              className={cn(
                                "flex items-center justify-center gap-1 rounded-lg bg-[rgba(0,122,255,0.10)] px-1.5 py-1 text-[11px] font-medium text-[#007AFF] hover:bg-[rgba(0,122,255,0.18)]",
                                busy ? "cursor-wait opacity-60" : "cursor-pointer",
                              )}
                              title={`重新生成这一张（直接扣费，不过确认卡）· 单价 ${unitPrice}`}
                            >
                              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              重生成 · {unitPrice}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handlePickFile(card.id, index)}
                              className={cn(
                                "flex items-center justify-center gap-1 rounded-lg bg-black/5 px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-black/10",
                                busy ? "cursor-wait opacity-60" : "cursor-pointer",
                              )}
                              title="上传自有素材：直接覆盖这一张（原样使用）"
                            >
                              <Upload className="h-3 w-3" />
                              替换
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 空图资产的补位上传（唯一的「新增」语义：图还没有，用户自带即权威） */}
                {card.references.length === 0 && (
                  <button
                    type="button"
                    disabled={busyKey === `${card.id}#0`}
                    onClick={() => handlePickFile(card.id, 0)}
                    className="mt-1.5 flex cursor-pointer items-center gap-1 rounded-lg bg-black/5 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-black/10"
                  >
                    <ImagePlus className="h-3 w-3" />
                    上传自有素材
                  </button>
                )}

                {/* 驳回（决策 4）：填理由 → 停下，不自动重生成 */}
                {status === "rejected" && card.approval?.reason && (
                  <p className="mt-1.5 text-ios-caption2 leading-snug text-destructive/80">
                    已驳回，等你说明怎么改：{card.approval.reason}
                  </p>
                )}
                {rejectingId === card.id ? (
                  <div className="mt-1.5">
                    <textarea
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      rows={2}
                      placeholder="哪里不对？想怎么改？（会存档，不会自动重生成）"
                      className="w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-ios-caption1 text-foreground outline-none placeholder:text-foreground/35 focus:border-[rgba(0,122,255,0.45)]"
                    />
                    <div className="mt-1 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleConfirmReject(card.id)}
                        className="cursor-pointer rounded-lg bg-[rgba(255,59,48,0.12)] px-2 py-1 text-[11px] font-medium text-destructive hover:bg-[rgba(255,59,48,0.2)]"
                      >
                        确认驳回
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRejectingId(null);
                          setRejectReason("");
                        }}
                        className="cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-black/10"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRejectingId(card.id);
                      setRejectReason(card.approval?.reason ?? "");
                    }}
                    className="mt-1.5 cursor-pointer rounded-lg px-1.5 py-1 text-[11px] font-medium text-foreground/45 hover:bg-black/5 hover:text-destructive"
                  >
                    驳回…
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {notice && (
        <p role="status" className="border-t px-3 py-1.5 text-ios-caption2 text-foreground/55">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
        <button
          type="button"
          onClick={() => void handleApproveAll()}
          disabled={cards.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-[#007AFF] px-2.5 py-1.5 text-ios-caption1 font-medium text-white",
            cards.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-[#0066D6]",
          )}
        >
          <Check className="h-3 w-3" />
          整批批准
        </button>
        <button
          type="button"
          onClick={() => exportAssetReviewCsv(cards)}
          disabled={cards.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-ios-caption1 font-medium text-muted-foreground",
            cards.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-black/10",
          )}
        >
          <Download className="h-3 w-3" />
          导出 CSV
        </button>
        <button
          type="button"
          onClick={() => void handleExportZip()}
          disabled={cards.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-ios-caption1 font-medium text-muted-foreground",
            cards.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-black/10",
          )}
        >
          <Download className="h-3 w-3" />
          导出图片包
        </button>
      </div>

      {/* 上传 input：单例隐藏，选档前先记住（卡，格） */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void handleFileChange(file);
        }}
      />

      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  );
}