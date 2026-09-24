/**
 * CanvasEmbedOverlays —— CanvasEmbed 四個浮層 + 內嵌 <style>（自 CanvasEmbed.tsx L1563-1632/L1849-2068 機械搬遷）。
 * 本組件必須「無條件掛載」：<style> 的 .ce-embed-* 選擇器同時作用於組件殼的頂欄/根容器，
 * 浮層全關時仍渲染樣式塊，否則殼層樣式失效。
 */
import { useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { summarizeCreationFlow } from "@/lib/canvas/creation-flow-panel";
import { cn } from "@/lib/utils";
import { LineageDrawer } from "@/components/lineage/LineageDrawer";
import { cardToLineageView } from "@/lib/lineage-view";
import { CHARACTER_CARD_KIND_LABEL } from "@/lib/character-cards";
import { CreationFlowPanel } from "./CreationFlowPanel";
import { applyWizardRewind } from "@/lib/wizard-steps";
import { formatRelative, toDvh } from "./embed-helpers";
import type { ReviewPanelKind } from "@/components/assets/AssetReviewPanel";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";

interface CanvasEmbedOverlaysProps {
  /** embed 高度（.ce-embed-root 動態样式）。 */
  height: string;
  expanded: boolean;
  /** Wave C：agent 操作確認閘。 */
  pendingOps: UseCanvasChatReturn["pendingAgentOps"];
  agentAutoApprove: boolean;
  onToggleAgentAutoApprove: (checked: boolean) => void;
  onApproveAgentOps: () => void;
  /** P2：角色/場景卡面板。 */
  cardsOpen: boolean;
  /** G2（2026-09-16）：作品/劇集面板。 */
  creationFlowOpen: boolean;
  onCloseCreationFlow: () => void;
  /** 歷史畫布下拉。 */
  historyOpen: boolean;
  onCloseHistory: () => void;
  /** B2：節點清單（全屏態）。 */
  elementListOpen: boolean;
  /**
   * WS-審查（2026-09-24）：資產/分鏡審查面板的畫布工具列入口狀態。
   * 面板本體掛在 CanvasEmbed（宿主），這裡只放入口——第二個門（步驟條）由另一路實作，
   * 呼叫端可用 `openReviewPanel()`（`src/components/assets/AssetReviewPanel.tsx` 導出）派事件開這裡。
   */
  reviewPanel: ReviewPanelKind | null;
  /** 待批准＋已駁回的總數（入口徽章；0 ＝不顯示徽章）。 */
  reviewPendingCount: number;
  /** 互動檔位（決策 1/2/13）：只有 collaborate 可回跳/開審查；全自動檔步驟條只讀進度。 */
  interactionMode: AgentInteractionMode;
  /** 入口開關（同一顆門：已開＝收合，未開＝開該面）。主面＝資產審查。 */
  onToggleReview: (panel: ReviewPanelKind) => void;
  canvas: UseCanvasChatReturn;
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}

export function CanvasEmbedOverlays({
  height,
  expanded,
  pendingOps,
  agentAutoApprove,
  onToggleAgentAutoApprove,
  onApproveAgentOps,
  cardsOpen,
  creationFlowOpen,
  onCloseCreationFlow,
  historyOpen,
  onCloseHistory,
  elementListOpen,
  reviewPanel,
  reviewPendingCount,
  interactionMode,
  onToggleReview,
  canvas,
  viewportSizeRef,
  setSelectedIds,
}: CanvasEmbedOverlaysProps) {
  // REQ-D1：資產卡「溯源」抽屜——卡片面板每行一顆入口，單例抽屜掛在本浮層。
  const [lineageCardId, setLineageCardId] = useState<string | null>(null);
  const lineageCard = lineageCardId
    ? canvas.characterCards.find((card) => card.id === lineageCardId) ?? null
    : null;
  return (
    <>
      <style>{`
        .ce-embed-root { height: ${height}; }
        @supports (height: 1dvh) { .ce-embed-root { height: ${toDvh(height)}; } }

        @media (max-width: 767px) {
          .ce-embed-root.ce-compact { height: min(72dvh, 620px) !important; }
        }

        /* 材質（背景/陰影/模糊）改由 lg-float 供給；這裡只留尺寸與排版。 */
        .ce-embed-bar-btn {
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
          min-width: 2.75rem;
          min-height: 2.75rem;
          padding: 0 1rem;
          font-size: 0.875rem;
          line-height: 1.25rem;
          border: none;
          transition: background-color 0.2s ease, transform 0.15s ease;
        }
        .ce-embed-bar-btn:active { transform: scale(0.96); }

        .ce-embed-empty { font-size: 0.875rem; }

        @media (min-width: 768px) {
          .ce-embed-bar-btn {
            min-width: 0;
            min-height: 0;
            padding: 0.25rem 0.625rem;
            font-size: 0.75rem;
            line-height: 1.125rem;
          }
          .ce-embed-bar-btn:active { transform: none; }
          .ce-embed-empty { font-size: 0.8125rem; }
        }

        @media (prefers-reduced-motion: reduce) {
          .ce-embed-bar-btn { transition: none; }
          .ce-embed-topbar, .ce-embed-leftpop { transition: none; }
        }

        /* 工作站態避讓改由宿主完成：ImagePlayground 把整個 overlay 向右 dock
           （--ce-dock-left = 面板寬 + 12px），畫布全域隨之右移，頂欄與左側彈層
           不再各自加 --ce-chrome-left（避免雙重位移）。行動端面板在底部，
           宿主把 overlay 復位成全屏，這裡只保留頂欄右緣約束讓 chips 能換行。 */
        @media (max-width: 767px) {
          .ce-embed-topbar { right: 0.75rem; }
          /* 行動端 chips 收斂：一排放得下，不再炸成兩行大藥丸。 */
          .ce-embed-topbar .ce-embed-bar-btn {
            min-width: 0;
            min-height: 2.125rem;
            padding: 0 0.7rem;
            font-size: 0.75rem;
            line-height: 1rem;
          }
        }
      `}</style>

      {/* Wave C：agent 操作確認閘 */}
      {pendingOps && !agentAutoApprove && (
        <div className="pointer-events-auto absolute bottom-16 left-1/2 z-40 w-[min(92%,460px)] -translate-x-1/2 rounded-2xl lg-sheet p-3.5" data-canvas-interactive>
          <p className="text-[13.5px] font-semibold text-foreground">AI 助理想操作画布</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {pendingOps.label || `共 ${pendingOps.ops.length} 步操作`}
            {" · "}
            {pendingOps.ops.map((op) => op.type).join("、")}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onApproveAgentOps}
              className="flex-1 rounded-lg bg-primary px-3 py-2 text-ios-footnote font-medium text-primary-foreground hover:opacity-90"
            >
              允许
            </button>
            <button
              type="button"
              onClick={() => canvas.dismissAgentOps()}
              className="flex-1 rounded-lg bg-black/5 px-3 py-2 text-ios-footnote font-medium text-muted-foreground hover:bg-black/10"
            >
              拒绝
            </button>
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-foreground/45">
            <input
              type="checkbox"
              checked={agentAutoApprove}
              onChange={(e) => onToggleAgentAutoApprove(e.target.checked)}
            />
            本设备自动允许画布操作（可随时取消）
          </label>
        </div>
      )}
      {agentAutoApprove && pendingOps && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-ios-caption1 text-white">
          正在执行 AI 画布操作…
        </div>
      )}

      {/* WS-審查（2026-09-24）：畫布工具列入口——資產圖／分鏡確認的兩個面共用這一顆門
          （面板本體在宿主 CanvasEmbed；主入口是步驟條，由另一路實作）。
          位置選左下角：頂欄與左右彈層都被既有面板佔滿，左下是唯一不打架的空位。 */}
      <div
        data-canvas-interactive
        className="pointer-events-auto absolute z-20 flex items-center gap-1.5"
        style={{
          left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
          bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <button
          type="button"
          onClick={() => onToggleReview("asset")}
          aria-pressed={reviewPanel !== null}
          aria-label="资产与分镜审查"
          className="ce-embed-bar-btn lg-float cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
        >
          审查
          {reviewPendingCount > 0 ? ` · 待确认 ${reviewPendingCount}` : ""}
        </button>
      </div>

      {/* P2：角色/場景卡面板——卡列表、生效 badge、鎖定/解鎖、刪卡 */}
      {cardsOpen && (
        <div
          data-canvas-interactive
          className="ce-embed-leftpop lg-sheet pointer-events-auto absolute z-20 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-ios-2xl"
          style={{
            left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
            top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
            maxHeight: "min(64dvh, 420px)",
          }}
        >
          <div className="border-b px-3 py-2.5">
            <p className="text-[12.5px] font-semibold text-foreground">实体卡（角色 / 场景 / 风格 / 道具 / 音频）</p>
            <p className="mt-0.5 text-ios-caption2 leading-snug text-foreground/45">
              锁定后本画布所有生成自动携带（提示词前缀 + 参考图 + 负面词）
            </p>
          </div>
          {canvas.characterCards.length === 0 ? (
            <p className="px-3.5 py-3 text-ios-caption1 text-foreground/45">
              还没有卡 · 右键参考图节点「存为卡并锁定」
            </p>
          ) : (
            canvas.characterCards.map((card) => {
              const active = canvas.activeCardIds.includes(card.id);
              return (
                <div
                  key={card.id}
                  className="flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-foreground">
                      <span className="truncate">{card.name}</span>
                      <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                        {CHARACTER_CARD_KIND_LABEL[card.kind]}
                      </span>
                      {card.variantOf && (
                        <span className="shrink-0 rounded-full bg-[rgba(0,122,255,0.12)] px-1.5 py-0.5 text-ios-caption2 text-[#007AFF]">
                          變體
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-ios-caption2 text-foreground/45">
                      {active ? (
                        <span className="font-medium text-ios-green">生效中</span>
                      ) : (
                        "未锁定"
                      )}
                      {card.references.length > 0 ? ` · ${card.references.length} 张参考图` : ""}
                      {card.prompt ? " · 有描述" : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => canvas.toggleCharacterCard(card.id)}
                    className={
                      active
                        ? "shrink-0 cursor-pointer rounded-lg bg-ios-green/10 px-2 py-1 text-[11.5px] font-medium text-[#248A3D] hover:bg-ios-green/20"
                        : "shrink-0 cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-black/10"
                    }
                  >
                    {active ? "解锁" : "锁定"}
                  </button>
                  {/* REQ-D1 溯源入口：卡本体的血统抽屉（「存为卡片」登记的来源可查）。 */}
                  <button
                    type="button"
                    aria-label={`溯源卡 ${card.name}`}
                    onClick={() => setLineageCardId(card.id)}
                    className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-[11.5px] text-foreground/45 hover:bg-black/5 hover:text-[#007AFF]"
                  >
                    溯源
                  </button>
                  <button
                    type="button"
                    aria-label={`删除卡 ${card.name}`}
                    onClick={() => void canvas.removeCharacterCard(card.id)}
                    className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-[11.5px] text-foreground/45 hover:bg-black/5 hover:text-destructive"
                  >
                    删除
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {lineageCard && (
        <LineageDrawer
          host={cardToLineageView(lineageCard)}
          hostKindLabel="资产卡"
          onClose={() => setLineageCardId(null)}
        />
      )}

      {/* G2（2026-09-16）：作品/劇集面板——與角色卡同款左側彈層；資料全部取自
          hook 既有出口（projectType/currentStep/episodes/nodes），本層零新增狀態。
          2026-09-24 步驟條接線：面板內的 5 步條不再是一列 inert 進度點——
          「審查」走路 2 的畫布側同一顆門（`onToggleReview`，詞彙同源不經映射表），
          「回跳」走 `applyWizardRewind`（與對話區步驟條**同一份**實作，不在此重寫）。 */}
      {creationFlowOpen && (
        <CreationFlowPanel
          summary={summarizeCreationFlow({
            projectType: canvas.projectType,
            currentStep: canvas.currentStep,
            episodes: canvas.episodes,
            nodes: canvas.nodes,
          })}
          onClose={onCloseCreationFlow}
          onOpenReview={onToggleReview}
          onRewind={(plan) => {
            applyWizardRewind(plan, canvas);
          }}
          readOnly={interactionMode !== "collaborate"}
        />
      )}

      {/* 歷史畫布下拉 */}
      {historyOpen && (
        <div
          data-canvas-interactive
          role="listbox"
          aria-label="历史画布列表"
          className="ce-embed-leftpop lg-sheet pointer-events-auto absolute z-20 w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-ios-2xl"
          style={{
            left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
            top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
            maxHeight: "min(60dvh, 360px)",
          }}
        >
          {canvas.savedProjects.length === 0 ? (
            <p className="px-4 py-3 text-ios-caption1 text-foreground/45">还没有保存的画布</p>
          ) : (
            canvas.savedProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                onClick={() => {
                  void canvas.openSavedCanvas(p.id).then(() => onCloseHistory());
                }}
                className="flex min-h-[44px] w-full flex-col items-start justify-center gap-0.5 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-black/5"
              >
                <span className="w-full truncate text-ios-caption1 font-medium text-foreground">{p.title}</span>
                <span className="text-ios-footnote text-foreground/45">
                  {p.nodeCount} 个节点 · {formatRelative(p.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {/* B2：節點清單（全屏態）→ 點擊飛行聚焦 */}
      {elementListOpen && expanded && (
        <div
          data-canvas-interactive
          className="ce-embed-leftpop lg-sheet pointer-events-auto absolute z-20 w-60 overflow-y-auto rounded-ios-2xl"
          style={{
            left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
            top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
            maxHeight: "min(64dvh, 420px)",
          }}
        >
          {canvas.nodes.length === 0 ? (
            <p className="px-4 py-3 text-ios-caption1 text-foreground/45">画布还没有节点</p>
          ) : (
            canvas.nodes.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  const size = viewportSizeRef.current;
                  canvas.flyTo({ x: n.position.x + n.width / 2, y: n.position.y + n.height / 2 }, size.width, size.height);
                  setSelectedIds(new Set([n.id]));
                  canvas.selectNode(n.id);
                }}
                className="flex min-h-[38px] w-full items-center gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-black/5"
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    n.metadata?.status === "success"
                      ? "bg-ios-green"
                      : n.metadata?.status === "loading"
                        ? "bg-ios-blue"
                        : n.metadata?.status === "error"
                          ? "bg-destructive"
                          : "bg-black/20",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{n.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
