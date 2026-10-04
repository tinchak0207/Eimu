"use client";

// 分镜审查面板（2026-09-24，能力建设／加法）：与资产审查面板**同构**（决策 24：不沿用文字确认卡）。
//
// 轮子来源（逐行 cp 自 `src/components/assets/AssetReviewPanel.tsx`，**白名单只差资料形状与栏位**）：
//   面板壳／弹层语汇、状态机（冻结 approval 契约消费）、档位判据、摘要、导出骨架、
//   缩图＋灯箱、导出 footer 的按钮语汇——交互逻辑与生命周期 hooks 一行未改。
//   白名单差异（全部列在此，无其他差异）：
//     1. 资料源＝`ReviewShot`（由画布分镜节点投影，见 `reviewShotsFromNodes`），不是 CharacterCard
//     2. 逐张动作只有「批准／驳回」（决策 24 的逐镜粒度）；重生成／替换／上传属步骤条与资产面
//     3. CSV 表头／列白名单＝分镜栏位（镜号／场景／画面描述／台词／状态／理由／图片）
//     4. 外部开启介面沿用 `AssetReviewPanel` 那份（同一颗画布入口；不另立第二套事件名）
//   缩图判定 `imageUrlOf` 直接用轮子 `src/components/canvas/embed/embed-helpers.ts`（不自造第二套 URL 判定）。
//
// 依据（决策定稿）：3 逐镜可改、批准整批一次；4 驳回＝填理由后停下；9 导出 CSV＋图片包；
// 2 全自动档可看可改、不阻塞流程，协作档才是停点。
//
// 批准状态真源＝`src/lib/character-cards.ts`（`ApprovalState` / `isAssetApproved` / `normalizeApprovalState`，
// 分镜侧 storyboard-contract.ts 明文「禁止另建第二套」）——本档只 import 消费，不重写 shape 或门槛尺。

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
import { IMAGE_FETCH_TIMEOUT_MS, imageHelpers } from "@/lib/image-helpers";
import { csvCell, triggerDownload } from "@/lib/history-export";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────── 冻结契约（只消费，不定义；与资产面同形）

/** 批准状态真源＝`@/lib/character-cards`（`ApprovalState`）；本档 import，不另建 shape。 */
export type { ApprovalState } from "@/lib/character-cards";

/**
 * 显示用读取投影（不是判定）：缺省＝已批准（决策 23）、读不懂落回已批准（与真源同向）。
 * 门槛判定一律问真源 `isAssetApproved`（见 `reviewStopBehavior`）。
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

/**
 * 分镜批准状态的写入值（纯函式）：**清洗一律走真源** `normalizeApprovalState`
 * （唯一收口，本档不重写第二套三值域/长度规则）。`status` 不合法 → `null`（不写半套状态）。
 * 载体是节点 metadata 的那一个 `approval` 键（写入由父层 `patchNodeMetadata` 执行）。
 */
export function shotApprovalFor(
  status: ApprovalState["status"],
  reason?: string,
  at: string = new Date().toISOString(),
): ApprovalState | null {
  return normalizeApprovalState({ status, decidedAt: at, reason });
}

// ─────────────────────────────────────────── 档位（决策 1/2）

/**
 * 档位语义（与资产面同一把尺）：停点只在协作档生效。
 * `stops` 直接问真源 `isAssetApproved`（拿一张显式 `pending` 的卡试），不重写第二套判定。
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

// ─────────────────────────────────────────── 分镜投影（画布节点 → 审查列）

/** 一镜的审查形状（唯读投影；写回由父层负责）。 */
export interface ReviewShot {
  /** 节点 id（唯一键；批准状态写回该节点 metadata）。 */
  id: string;
  /** 镜号（AID `storyboardShot.shotNumber`，本实体唯一键）。 */
  shotNumber: string;
  /** 场景名（外层场景 Group 节点；取不到＝空字串，UI 不编造）。 */
  sceneName: string;
  /** 画面描述（AID `visualDescription`）。 */
  visualDescription: string;
  /** 台词（AID `dialogue`）。 */
  dialogue: string;
  /** 该镜生成用提示词（节点 metadata.prompt；空＝尚未有生成参数）。 */
  prompt: string;
  /** 缩图：节点本体图片，或连入的第一颗图片节点；null＝这镜还没有图。 */
  imageUrl: string | null;
  approval?: ApprovalState;
}

/**
 * 画布节点 → 分镜审查列（纯函式）。
 *   - 只认真的分镜实体：`metadata.storyboardShot` 过 `normalizeStoryboardShot` 清洗后非 null
 *     （shotNumber 空即整包丢——与契约同一把尺，不自造第二套判准）
 *   - 缩图：节点本体（`imageUrlOf` 轮子）→ 连入的图片节点（倒序连线取首个有图者）→ null
 *   - 场景名：由呼叫端以 `sceneNameOf` 解析（画布侧用 childToParent 找 Group 的 `storyboardScene`）；
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
    // 批准状态（路 1 的冻结栏位）挂在节点 metadata 上；型别宽化只为读这一个键
    // （`CanvasNodeMetadata` 是 interface 无 index signature，路 1 落地后即为直读）。
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

// ─────────────────────────────────────────── 导出（决策 9）

/** 汇出日期戳（本地日）。 */
function stamp(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

const SHOT_CSV_HEADER = ["镜号", "场景", "审核状态", "驳回理由", "画面描述", "台词", "图片链接"] as const;

/** 分镜清单 CSV 字串（纯函式）：header/rows 走本面白名单，转义与下载一律走轮子。 */
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

/** 下载分镜清单 CSV（空清单＝不产生档案）。 */
export function exportShotReviewCsv(shots: readonly ReviewShot[], at: Date = new Date()): void {
  if (!shots.length) return;
  triggerDownload(buildShotReviewCsv(shots), `分镜清单-${stamp(at)}.csv`, "text/csv;charset=utf-8");
}

/** 图片压缩包清单（纯函式）：一镜一项，名称＝`镜号-镜号` 可读；无图的镜次不进清单。 */
export function shotZipPlan(shots: readonly ReviewShot[]): { fileName: string; url: string }[] {
  return shots.flatMap((shot) =>
    shot.imageUrl ? [{ fileName: `镜${shot.shotNumber}`, url: shot.imageUrl }] : [],
  );
}

/**
 * 取图成 blob；失败回 null（跳过并计数，同 `exportHistoryZip` 语义）。
 *
 * 2026-10-04（禁造轮子＋永久 pending 族）：不再自拼 `fetch(url)`——那条链缺
 * ?dl=1/no-store 的 CORS 修复、也没有 timeout，上游半开连线会让整包永久 pending。
 * 直接复用 `imageHelpers.fetchImageResponse`（单一真源：换缓存键＋no-store＋
 * AbortController 上限）。失败/逾时照旧吞成 null → 该张 skipped，不炸整包。
 */
async function shotBlob(url: string, timeoutMs: number): Promise<Blob | null> {
  try {
    const response = await imageHelpers.fetchImageResponse(url, timeoutMs);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** 导出分镜图片压缩包：直接用轮子 `exportShotsZip()`。 */
export async function exportShotReviewZip(
  shots: readonly ReviewShot[],
  at: Date = new Date(),
  // 仅由测试注入缩短值（模拟逾时）；生产走 fetchImageResponse 的默认上限。
  fetchTimeoutMs: number = IMAGE_FETCH_TIMEOUT_MS,
): Promise<{ exported: number; skipped: number }> {
  const plan = shotZipPlan(shots);
  if (!plan.length) return { exported: 0, skipped: 0 };
  const fetched = await Promise.all(
    plan.map(async (item) => {
      const blob = await shotBlob(item.url, fetchTimeoutMs);
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
  /** 待审查的分镜（画布投影；见 `reviewShotsFromNodes`）。 */
  shots: readonly ReviewShot[];
  /** 当前互动档位（决策 1/2）。 */
  interactionMode: AgentInteractionMode;
  /** 驳回（决策 4）：带理由；不触发任何生成。 */
  onReject: (shotId: string, reason: string) => Promise<void> | void;
  /** 整批一键批准（决策 3）。 */
  onApproveAll: (shotIds: readonly string[]) => Promise<void> | void;
  /** 切回资产审查（同一颗画布入口底下的另一面；缺省＝不显示）。 */
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
          <p className="text-ios-caption1 font-semibold text-foreground">分镜审查</p>
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
                  <p className="flex items-center gap-1.5 truncate text-ios-caption1 font-medium text-foreground">
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
                        className="w-full rounded-lg border border-black/10 bg-white/70 px-2 py-1.5 text-ios-caption1 text-foreground outline-none placeholder:text-foreground/35 focus:border-[rgba(0,122,255,0.45)]"
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
            "flex items-center gap-1 rounded-lg bg-[#007AFF] px-2.5 py-1.5 text-ios-caption1 font-medium text-white",
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
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-ios-caption1 font-medium text-muted-foreground",
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
            "flex items-center gap-1 rounded-lg bg-black/5 px-2.5 py-1.5 text-ios-caption1 font-medium text-muted-foreground",
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