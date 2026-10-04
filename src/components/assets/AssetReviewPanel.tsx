"use client";

// 資產審查面板（2026-09-24，能力建設／加法）：把「資產圖確認」這道線下必經流程做成可操作的介面。
//
// 依據（決策定稿 24 條，見 memory 2026-09-24-asset-confirmation-gate-absent-root-cause.md）：
//   3  逐張可改、批准動作整批一次
//   4  駁回＝填理由後**停下**（存下理由、不自動重生成、不擅自花錢）
//   6  用戶上傳自有素材＝**直接覆蓋原圖**（不並存、不做變體）
//   7  上傳後原樣使用（用戶的圖即權威）
//   9  導出＝CSV 清單 ＋ 圖片壓縮包（明確不做 PDF 審批單）
//   11 重生成**不過扣費確認卡**，直接扣；按鈕顯示單價（決策 16 同義）
//   2  全自動檔（preset/auto）下同一面板可看可改、**不阻塞流程**；協作檔才配合停點
//
// 輪子（禁止自造，逐條列來源）：
//   - 面板殼／彈層語彙：`src/components/assets/ProjectAssetLibraryPanel.tsx:211-242`（lg-sheet + 右側滑入 + 標題列）
//   - 縮圖＋點擊放大：`src/components/ReferenceImageUpload.tsx:171-186`（縮圖按鈕）＋ `src/components/ImageLightbox.tsx`（全屏燈箱）
//   - 上傳控件：`src/components/ReferenceImageUpload.tsx:153`（按鈕語彙；檔案→dataURL 由父層走 `embed-helpers.fileToDataUrl`）
//   - CSV 轉義／下載：`src/lib/history-export.ts` 的 `csvCell` / `triggerDownload`（本刀把它們導出化；**零自創轉義邏輯**）
//   - 圖片壓縮包：`src/lib/export-zip.ts:38` `exportShotsZip()` 直接用
//   - 單價：`src/lib/generation-model-catalog` 的 `modelPriceLabel`（與站內選模價籤同一把尺）
//
// 批准狀態欄位：形狀**由路 1 定義並凍結**，且已落地為 `src/lib/character-cards.ts` 的 `ApprovalState`
// ＋判定尺 `isAssetApproved` ＋寫入輪子 `setApproval`／`normalizeApprovalState`
// （分鏡側 storyboard-contract.ts 明文「禁止另建第二套」）。本檔**直接消費該真源**：
//   讀取 → `approvalStatusOf`（純投影）／門檻 → `isAssetApproved`／寫回 → 父層 `setApproval`。
// 寫回路徑由父層（`upsertCharacterCard`）負責，本檔不自行偽造持久化。

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

// ─────────────────────────────────────────── 凍結契約（只消費，不定義）

/**
 * 批准狀態的**型別真源在 `@/lib/character-cards`**（`ApprovalState`；分鏡側 storyboard-contract
 * 也是同一個 shape，該檔明文「禁止另建第二套」）。本檔直接 import 真源、只做讀取投影，
 * 判定一律走真源的 `isAssetApproved`（不重寫第二套門檻尺）。
 */
export type { ApprovalState } from "@/lib/character-cards";

/**
 * 顯示用讀取投影（**不是判定**）：把 `approval` 投影成三態標籤。
 * 缺省＝已批准（決策 23 存量相容）；讀不懂的值同樣落回「已批准」
 * （與真源 `normalizeApprovalState` 的 fail-open 方向一致：髒資料不該讓存量資產突然被當未批准）。
 * 「會不會擋流程」由 `reviewStopBehavior` 問真源 `isAssetApproved`，本函式不參與門檻判定。
 */
export function approvalStatusOf(record: { approval?: ApprovalState } | null | undefined): ApprovalState["status"] {
  const approval = record?.approval;
  if (!approval) return "approved";
  if (approval.status === "approved" || approval.status === "pending" || approval.status === "rejected") {
    return approval.status;
  }
  // 契約外的值（理論上到不了這裡：真源 `normalizeApprovalState` 在寫入/讀取端就把鍵丟掉）。
  // 萬一漏進來，**與門檻同向**顯示「待批准」——`isAssetApproved` 對認不得的值回 false（會擋），
  // 面板若顯示「已批准」就是對用戶說謊。這不是第二把尺：門檻仍然只由 `isAssetApproved` 決定。
  return "pending";
}

// ─────────────────────────────────────────── 檔位（決策 1/2）

/**
 * 檔位語義（決策 1/2）：**停點只在協作檔生效**；全自動檔（preset/auto）可看可改、不阻塞流程。
 * `stops` **直接問真源** `isAssetApproved`（拿一張顯式 `pending` 的卡試，該檔就是門檻尺本身）——
 * 面板不重寫第二套檔位判定；橫幅文案才在本地。
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

/** 審查摘要（面板頁首計數）。 */
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

// ─────────────────────────────────────────── 逐張操作（純函式，供測試與父層落地）

/**
 * 覆蓋原圖（決策 6/7）：既有 index → 換掉該格（不並存、不做變體、不動其他欄位）；
 * index ≥ 長度 → 補位（資產圖還沒生出來時，用戶自帶素材是唯一的路）。
 * 只換 url：role/name 逐字保留（原樣使用，不動既有 DNA 簽名）。
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
 * 重生成請求 payload（決策 11：直接扣費、不過確認卡）。
 *   - prompt＝卡自己的鎖定片段（不編造新提示詞）
 *   - 參考圖＝該卡**其餘**參考圖（不含正在重生成的那張：拿壞圖當參考會把錯誤傳染下去）
 *   - 卡注入走 `cards: []`（＝不注入）——卡的片段與參考圖已在本 payload 顯式給定，
 *     再注入一次會讓同一張圖同時當「要被換掉的目標」與「參考」。
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

// ─────────────────────────────────────────── 導出（決策 9）

/** 匯出日期戳（本地日）。 */
function stamp(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

const ASSET_CSV_HEADER = ["资产名", "类型", "审核状态", "驳回理由", "参考图数量", "参考图链接", "描述"] as const;

/**
 * 資產清單 CSV 字串（純函式，可直測）：只提供 header/rows 白名單，
 * 轉義走輪子 `csvCell`、行尾 CRLF、前置 BOM（Excel 讀 UTF-8 中文必需）——與站內既有 CSV 逐字同構。
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

/** 下載資產清單 CSV（空清單＝不產生檔案，與 `exportHistoryCsv` 同款守衛）。 */
export function exportAssetReviewCsv(records: readonly CharacterCard[], at: Date = new Date()): void {
  if (!records.length) return;
  triggerDownload(buildAssetReviewCsv(records), `资产清单-${stamp(at)}.csv`, "text/csv;charset=utf-8");
}

/** 圖片壓縮包清單（純函式）：逐張參考圖一項，名稱 = `卡名-序號`（副檔名/去重由 `exportShotsZip` 負責）。 */
export function assetZipPlan(records: readonly CharacterCard[]): { fileName: string; url: string }[] {
  return records.flatMap((card) =>
    card.references.map((ref, index) => ({ fileName: `${card.name}-${index + 1}`, url: ref.url })),
  );
}

/** 取圖成 blob；失敗回 null（取不到的圖跳過並計數，不讓整包失敗——與 `exportHistoryZip` 同語義）。
 *
 * 2026-10-04（禁造輪子＋永久 pending 族）：不再自拼 `fetch(url)`（缺 ?dl=1/no-store
 * 的 CORS 修復、無 timeout，上游半開連線會永久 pending），改用單一真源
 * `imageHelpers.fetchImageResponse`。失敗／逾時仍吞成 null → skipped，UI 行為不變。
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

/** 導出圖片壓縮包：直接用輪子 `exportShotsZip()`（打包/去重/副檔名白名單一律不在本檔重寫）。 */
export async function exportAssetReviewZip(
  records: readonly CharacterCard[],
  at: Date = new Date(),
  // 僅由測試注入縮短值（模擬逾時）；生產走 fetchImageResponse 的預設上限。
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

// ─────────────────────────────────────────── 外部開啟介面（畫布工具列以外的第二入口用）

/** 審查面（兩面板共用同一顆畫布入口）。 */
export type ReviewPanelKind = "asset" | "shot";

/** 開啟事件名（`window` 上的 CustomEvent；CanvasEmbed 掛監聽）。 */
export const REVIEW_PANEL_OPEN_EVENT = "canvas-open-review-panel";

export interface ReviewPanelOpenDetail {
  panel: ReviewPanelKind;
  /** 可選：開面板時要聚焦的資產／鏡次 id。 */
  focusId?: string;
}

/**
 * 外部開啟介面（給路 4 的步驟條／任何不在 CanvasEmbed 內的呼叫端）：
 * 派發 CustomEvent，由 CanvasEmbed 的面板宿主接收並開啟對應審查面。
 * 回傳 `true`＝事件已派發（**不代表面板已開**——沒有宿主掛載時無人接收，這是誠實回報）。
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
  /** 待審查的資產（卡實體；references ＝ 逐張參考圖）。 */
  cards: readonly CharacterCard[];
  /** 本畫布鎖定生效中的卡 id（僅顯示徽章，不放行任何寫入）。 */
  activeCardIds?: readonly string[];
  /** 當前互動檔位（決策 1/2：只有 collaborate 是停點）。 */
  interactionMode: AgentInteractionMode;
  /** 重生成單價／請求用的模型。 */
  modelId?: string;
  /**
   * 逐張重生成（決策 11：直接扣費、不過確認卡）。父層負責落地 `applyReplaceReference`；
   * 回傳 null＝失敗或無圖（面板不謊報成功）。
   */
  onRegenerate: (cardId: string, referenceIndex: number) => Promise<{ url: string; costCoins?: number } | null>;
  /** 用戶上傳自有素材＝直接覆蓋原圖（決策 6）；父層負責壓縮與寫回。 */
  onReplace: (cardId: string, referenceIndex: number, file: File) => Promise<boolean>;
  /** 駁回（決策 4）：帶理由；**不觸發重生成**。 */
  onReject: (cardId: string, reason: string) => Promise<void> | void;
  /** 整批一鍵批准（決策 3）。 */
  onApproveAll: (cardIds: readonly string[]) => Promise<void> | void;
  /** 切到分鏡審查（同一顆畫布入口底下的另一面；缺省＝不顯示該按鈕）。 */
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
  /** 燈箱：{ src, alt }；null＝關閉。 */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  /** 逐張忙碌（`${cardId}#${index}`）：重生成／上傳共用一格。 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 駁回輸入：正在填理由的卡 id（決策 4：先填理由，再停下）。 */
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** 上傳目標（隱藏 input 用；file 選好後才知道是哪張卡的哪一格）。 */
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

      {/* 檔位橫幅（決策 1/2）：全自動檔只是說明，不新增任何阻塞 */}
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

                {/* 縮圖牆（GM 視角：逐張可看，不是只有「N 张参考图」） */}
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

                {/* 空图资产的补位上传（唯一的「新增」語義：图还没有，用户自带即权威） */}
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

                {/* 駁回（決策 4）：填理由 → 停下，不自動重生成 */}
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

      {/* 上傳 input：單例隱藏，選檔前先記住（卡，格） */}
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