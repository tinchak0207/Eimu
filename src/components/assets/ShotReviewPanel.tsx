"use client";

// 分鏡審查面板（2026-09-24，能力建設／加法）：與資產審查面板**同構**（決策 24：不沿用文字確認卡）。
//
// 輪子來源（逐行 cp 自 `src/components/assets/AssetReviewPanel.tsx`，**白名單只差資料形狀與欄位**）：
//   面板殼／彈層語彙、狀態機（凍結 approval 契約消費）、檔位判據、摘要、導出骨架、
//   縮圖＋燈箱、導出 footer 的按鈕語彙——交互邏輯與生命週期 hooks 一行未改。
//   白名單差異（全部列在此，無其他差異）：
//     1. 資料源＝`ReviewShot`（由畫布分鏡節點投影，見 `reviewShotsFromNodes`），不是 CharacterCard
//     2. 逐張動作只有「批准／駁回」（決策 24 的逐鏡粒度）；重生成／替換／上傳屬步驟條與資產面
//     3. CSV 表頭／列白名單＝分鏡欄位（鏡號／場景／畫面描述／台詞／狀態／理由／圖片）
//     4. 外部開啟介面沿用 `AssetReviewPanel` 那份（同一顆畫布入口；不另立第二套事件名）
//   縮圖判定 `imageUrlOf` 直接用輪子 `src/components/canvas/embed/embed-helpers.ts`（不自造第二套 URL 判定）。
//
// 依據（決策定稿）：3 逐鏡可改、批准整批一次；4 駁回＝填理由後停下；9 導出 CSV＋圖片包；
// 2 全自動檔可看可改、不阻塞流程，協作檔才是停點。
//
// 批准狀態真源＝`src/lib/character-cards.ts`（`ApprovalState` / `isAssetApproved` / `normalizeApprovalState`，
// 分鏡側 storyboard-contract.ts 明文「禁止另建第二套」）——本檔只 import 消費，不重寫 shape 或門檻尺。

import { useCallback, useMemo, useState } from "react";
import { Check, Download, Loader2, X } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";
import { isAssetApproved, normalizeApprovalState } from "@/lib/character-cards";
import type { ApprovalState } from "@/lib/character-cards";
import { normalizeStoryboardShot } from "@/lib/storyboard-contract";
import type { CanvasConnection, CanvasNode } from "@/lib/canvas/types";
import { imageUrlOf } from "@/components/canvas/embed/embed-helpers";
import { exportShotsZip } from "@/lib/export-zip";
import { csvCell, triggerDownload } from "@/lib/history-export";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────── 凍結契約（只消費，不定義；與資產面同形）

/** 批准狀態真源＝`@/lib/character-cards`（`ApprovalState`）；本檔 import，不另建 shape。 */
export type { ApprovalState } from "@/lib/character-cards";

/**
 * 顯示用讀取投影（不是判定）：缺省＝已批准（決策 23）、讀不懂落回已批准（與真源同向）。
 * 門檻判定一律問真源 `isAssetApproved`（見 `reviewStopBehavior`）。
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

/**
 * 分鏡批准狀態的寫入值（純函式）：**清洗一律走真源** `normalizeApprovalState`
 * （唯一收口，本檔不重寫第二套三值域/長度規則）。`status` 不合法 → `null`（不寫半套狀態）。
 * 載體是節點 metadata 的那一個 `approval` 鍵（寫入由父層 `patchNodeMetadata` 執行）。
 */
export function shotApprovalFor(
  status: ApprovalState["status"],
  reason?: string,
  at: string = new Date().toISOString(),
): ApprovalState | null {
  return normalizeApprovalState({ status, decidedAt: at, reason });
}

// ─────────────────────────────────────────── 檔位（決策 1/2）

/**
 * 檔位語義（與資產面同一把尺）：停點只在協作檔生效。
 * `stops` 直接問真源 `isAssetApproved`（拿一張顯式 `pending` 的卡試），不重寫第二套判定。
 */
export function reviewStopBehavior(mode: AgentInteractionMode): { stops: boolean; note: string } {
  const wouldBlock = !isAssetApproved({ status: "pending" }, mode);
  return wouldBlock
    ? {
        stops: true,
        note: "协作档：分镜是流程停点——未批准的分镜会挡住后续视频，确认后可继续。",
      }
    : {
        stops: false,
        note: "全自动档：分镜可看可改，不阻塞流程（改了的镜只影响后续生成）。",
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

// ─────────────────────────────────────────── 分鏡投影（畫布節點 → 審查列）

/** 一鏡的審查形狀（唯讀投影；寫回由父層負責）。 */
export interface ReviewShot {
  /** 節點 id（唯一鍵；批准狀態寫回該節點 metadata）。 */
  id: string;
  /** 鏡號（AID `storyboardShot.shotNumber`，本實體唯一鍵）。 */
  shotNumber: string;
  /** 場景名（外層場景 Group 節點；取不到＝空字串，UI 不編造）。 */
  sceneName: string;
  /** 畫面描述（AID `visualDescription`）。 */
  visualDescription: string;
  /** 台詞（AID `dialogue`）。 */
  dialogue: string;
  /** 該鏡生成用提示詞（節點 metadata.prompt；空＝尚未有生成參數）。 */
  prompt: string;
  /** 縮圖：節點本體圖片，或連入的第一顆圖片節點；null＝這鏡還沒有圖。 */
  imageUrl: string | null;
  approval?: ApprovalState;
}

/**
 * 畫布節點 → 分鏡審查列（純函式）。
 *   - 只認真的分鏡實體：`metadata.storyboardShot` 過 `normalizeStoryboardShot` 清洗後非 null
 *     （shotNumber 空即整包丟——與契約同一把尺，不自造第二套判準）
 *   - 縮圖：節點本體（`imageUrlOf` 輪子）→ 連入的圖片節點（倒序連線取首個有圖者）→ null
 *   - 場景名：由呼叫端以 `sceneNameOf` 解析（畫布側用 childToParent 找 Group 的 `storyboardScene`）；
 *     缺省＝空字串（不猜）
 */
export function reviewShotsFromNodes(
  nodes: readonly CanvasNode[],
  options: {
    connections?: readonly CanvasConnection[];
    sceneNameOf?: (nodeId: string) => string | undefined;
  } = {},
): ReviewShot[] {
  const connections = options.connections ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: ReviewShot[] = [];
  for (const node of nodes) {
    const shot = normalizeStoryboardShot(node.metadata?.storyboardShot);
    if (!shot) continue;
    // 批准狀態（路 1 的凍結欄位）掛在節點 metadata 上；型別寬化只為讀這一個鍵
    // （`CanvasNodeMetadata` 是 interface 無 index signature，路 1 落地後即為直讀）。
    const meta = (node.metadata ?? {}) as Record<string, unknown>;
    const approval = meta.approval as ApprovalState | undefined;
    const own = imageUrlOf(node);
    const linked = connections
      .filter((conn) => conn.toNodeId === node.id)
      .map((conn) => imageUrlOf(byId.get(conn.fromNodeId)))
      .find((url): url is string => !!url);
    out.push({
      id: node.id,
      shotNumber: shot.shotNumber,
      sceneName: options.sceneNameOf?.(node.id) ?? "",
      visualDescription: shot.visualDescription,
      dialogue: shot.dialogue,
      prompt: typeof node.metadata?.prompt === "string" ? node.metadata.prompt : "",
      imageUrl: own ?? linked ?? null,
      ...(approval ? { approval } : {}),
    });
  }
  return out;
}

// ─────────────────────────────────────────── 導出（決策 9）

/** 匯出日期戳（本地日）。 */
function stamp(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

const SHOT_CSV_HEADER = ["镜号", "场景", "审核状态", "驳回理由", "画面描述", "台词", "图片链接"] as const;

/** 分鏡清單 CSV 字串（純函式）：header/rows 走本面白名單，轉義與下載一律走輪子。 */
export function buildShotReviewCsv(shots: readonly ReviewShot[]): string {
  const rows = shots.map((shot) =>
    [
      csvCell(shot.shotNumber),
      csvCell(shot.sceneName),
      csvCell(approvalStatusOf(shot)),
      csvCell(shot.approval?.reason),
      csvCell(shot.visualDescription),
      csvCell(shot.dialogue),
      csvCell(shot.imageUrl ?? ""),
    ].join(","),
  );
  return `\ufeff${[SHOT_CSV_HEADER.join(","), ...rows].join("\r\n")}`;
}

/** 下載分鏡清單 CSV（空清單＝不產生檔案）。 */
export function exportShotReviewCsv(shots: readonly ReviewShot[], at: Date = new Date()): void {
  if (!shots.length) return;
  triggerDownload(buildShotReviewCsv(shots), `分镜清单-${stamp(at)}.csv`, "text/csv;charset=utf-8");
}

/** 圖片壓縮包清單（純函式）：一鏡一項，名稱＝`镜号-鏡號` 可讀；無圖的鏡次不進清單。 */
export function shotZipPlan(shots: readonly ReviewShot[]): { fileName: string; url: string }[] {
  return shots.flatMap((shot) =>
    shot.imageUrl ? [{ fileName: `镜${shot.shotNumber}`, url: shot.imageUrl }] : [],
  );
}

/** 取圖成 blob；失敗回 null（跳過並計數，同 `exportHistoryZip` 語義）。 */
async function shotBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** 導出分鏡圖片壓縮包：直接用輪子 `exportShotsZip()`。 */
export async function exportShotReviewZip(
  shots: readonly ReviewShot[],
  at: Date = new Date(),
): Promise<{ exported: number; skipped: number }> {
  const plan = shotZipPlan(shots);
  if (!plan.length) return { exported: 0, skipped: 0 };
  const fetched = await Promise.all(
    plan.map(async (item) => {
      const blob = await shotBlob(item.url);
      return blob ? { name: item.fileName, blob } : null;
    }),
  );
  const items = fetched.filter((item): item is { name: string; blob: Blob } => item !== null);
  const skipped = plan.length - items.length;
  if (!items.length) return { exported: 0, skipped };
  await exportShotsZip(items, `分镜图-${stamp(at)}.zip`);
  return { exported: items.length, skipped };
}

// ─────────────────────────────────────────── 面板

export interface ShotReviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** 待審查的分鏡（畫布投影；見 `reviewShotsFromNodes`）。 */
  shots: readonly ReviewShot[];
  /** 當前互動檔位（決策 1/2）。 */
  interactionMode: AgentInteractionMode;
  /** 駁回（決策 4）：帶理由；不觸發任何生成。 */
  onReject: (shotId: string, reason: string) => Promise<void> | void;
  /** 整批一鍵批准（決策 3）。 */
  onApproveAll: (shotIds: readonly string[]) => Promise<void> | void;
  /** 切回資產審查（同一顆畫布入口底下的另一面；缺省＝不顯示）。 */
  onSwitchToAssets?: () => void;
}

export function ShotReviewPanel({
  open,
  onClose,
  shots,
  interactionMode,
  onReject,
  onApproveAll,
  onSwitchToAssets,
}: ShotReviewPanelProps) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const summary = useMemo(() => reviewSummary(shots), [shots]);
  const behavior = reviewStopBehavior(interactionMode);

  const handleConfirmReject = useCallback(
    async (shotId: string) => {
      const reason = rejectReason.trim();
      if (!reason) {
        setNotice("驳回需要填理由（会原样存档，供后续改镜）");
        return;
      }
      setBusyId(shotId);
      try {
        await onReject(shotId, reason);
        setRejectingId(null);
        setRejectReason("");
        setNotice("已退回并停下：不会自动重生成，等你说明怎么改");
      } finally {
        setBusyId(null);
      }
    },
    [onReject, rejectReason],
  );

  const handleApproveAll = useCallback(async () => {
    await onApproveAll(shots.map((shot) => shot.id));
    setNotice(`已整批批准 ${shots.length} 个分镜`);
  }, [onApproveAll, shots]);

  const handleExportZip = useCallback(async () => {
    setNotice(null);
    const result = await exportShotReviewZip(shots);
    setNotice(
      result.exported === 0
        ? "没有可取到的图（压缩包未生成）"
        : `已导出 ${result.exported} 张分镜图${result.skipped > 0 ? `，跳过 ${result.skipped} 张取不到的` : ""}`,
    );
  }, [shots]);

  if (!open) return null;

  return (
    <div
      data-canvas-interactive
      role="dialog"
      aria-label="分镜审查"
      className="lg-sheet pointer-events-auto fixed z-[86] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-ios-2xl"
      style={{
        right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
        top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
        maxHeight: "min(74dvh, 600px)",
      }}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-foreground">分镜审查</p>
          <p className="mt-0.5 text-ios-caption2 leading-snug text-foreground/45">
            逐镜看、逐镜批；批准动作整批一次
          </p>
        </div>
        {onSwitchToAssets && (
          <button
            type="button"
            onClick={onSwitchToAssets}
            className="shrink-0 cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-ios-caption2 font-medium text-muted-foreground hover:bg-black/10"
          >
            资产审查
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
          "border-b px-3 py-1.5 text-ios-caption2 leading-snug",
          behavior.stops ? "bg-[rgba(255,149,0,0.10)] text-[#B25E00]" : "bg-black/[0.03] text-foreground/45",
        )}
      >
        {behavior.note}
      </p>

      <p className="border-b px-3 py-1.5 text-ios-caption2 text-foreground/45">
        共 {summary.total} 镜 · 已批准 {summary.approved} · 待批准 {summary.pending} · 已退回 {summary.rejected}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shots.length === 0 ? (
          <p className="px-3.5 py-4 text-ios-caption1 text-foreground/45">
            还没有分镜。等剧本拆分出了分镜，画面会挂在这里逐镜确认。
          </p>
        ) : (
          shots.map((shot) => {
            const status = approvalStatusOf(shot);
            return (
              <div key={shot.id} className="flex gap-2 border-b px-3 py-2.5 last:border-b-0">
                <div className="shrink-0">
                  {shot.imageUrl ? (
                    <button
                      type="button"
                      onClick={() => setLightbox({ src: shot.imageUrl!, alt: `镜 ${shot.shotNumber}` })}
                      title={`预览 镜 ${shot.shotNumber}`}
                      className="block h-[76px] w-[76px] cursor-zoom-in overflow-hidden rounded-ios-md bg-black/5"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={shot.imageUrl} alt={`镜 ${shot.shotNumber}`} className="h-full w-full object-cover" />
                    </button>
                  ) : (
                    <div className="flex h-[76px] w-[76px] items-center justify-center rounded-ios-md bg-black/5 text-ios-caption2 text-foreground/35">
                      还没有图
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-foreground">
                    <span className="shrink-0">镜 {shot.shotNumber}</span>
                    {shot.sceneName && (
                      <span className="truncate rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                        {shot.sceneName}
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
                      {status === "approved" ? "已批准" : status === "rejected" ? "已退回" : "待批准"}
                    </span>
                  </p>
                  {shot.visualDescription && (
                    <p className="mt-0.5 line-clamp-2 text-ios-caption2 leading-snug text-foreground/45">
                      {shot.visualDescription}
                    </p>
                  )}
                  {shot.dialogue && (
                    <p className="mt-0.5 line-clamp-2 text-ios-caption2 leading-snug text-foreground/60">
                      台词：{shot.dialogue}
                    </p>
                  )}

                  {status === "rejected" && shot.approval?.reason && (
                    <p className="mt-1 text-ios-caption2 leading-snug text-destructive/80">
                      已退回，等你说明怎么改：{shot.approval.reason}
                    </p>
                  )}
                  {rejectingId === shot.id ? (
                    <div className="mt-1.5">
                      <textarea
                        value={rejectReason}
                        onChange={(event) => setRejectReason(event.target.value)}
                        rows={2}
                        placeholder="这一镜哪里不对？想怎么改？（会存档，不会自动重生成）"
                        className="w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-[11.5px] text-foreground outline-none placeholder:text-foreground/35 focus:border-[rgba(0,122,255,0.45)]"
                      />
                      <div className="mt-1 flex gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === shot.id}
                          onClick={() => void handleConfirmReject(shot.id)}
                          className="cursor-pointer rounded-lg bg-[rgba(255,59,48,0.12)] px-2 py-1 text-[11px] font-medium text-destructive hover:bg-[rgba(255,59,48,0.2)]"
                        >
                          {busyId === shot.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "确认退回"}
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
                        setRejectingId(shot.id);
                        setRejectReason(shot.approval?.reason ?? "");
                      }}
                      className="mt-1 cursor-pointer rounded-lg px-1.5 py-1 text-[11px] font-medium text-foreground/45 hover:bg-black/5 hover:text-destructive"
                    >
                      退回…
                    </button>
                  )}
                </div>
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
          disabled={shots.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-[#007AFF] px-2.5 py-1.5 text-[11.5px] font-medium text-white",
            shots.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-[#0066D6]",
          )}
        >
          <Check className="h-3 w-3" />
          整批批准
        </button>
        <button
          type="button"
          onClick={() => exportShotReviewCsv(shots)}
          disabled={shots.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-[11.5px] font-medium text-muted-foreground",
            shots.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-black/10",
          )}
        >
          <Download className="h-3 w-3" />
          导出 CSV
        </button>
        <button
          type="button"
          onClick={() => void handleExportZip()}
          disabled={shots.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-[11.5px] font-medium text-muted-foreground",
            shots.length === 0 ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-black/10",
          )}
        >
          <Download className="h-3 w-3" />
          导出图片包
        </button>
      </div>

      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  );
}