/**
 * CanvasEmbedOverlays —— CanvasEmbed 四個浮層 + 內嵌 <style>（自 CanvasEmbed.tsx L1563-1632/L1849-2068 機械搬遷）。
 * 本組件必須「無條件掛載」：<style> 的 .ce-embed-* 選擇器同時作用於組件殼的頂欄/根容器，
 * 浮層全關時仍渲染樣式塊，否則殼層樣式失效。
 */
import { useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import {
  deriveNextStep,
  summarizeCreationFlow,
  type CreationFlowSnapshot,
  type CreationFlowSummary,
  type CreationNextStepId,
  type CreationNextSurface,
} from "@/lib/canvas/creation-flow-panel";
import { shotMediaReadiness } from "@/lib/canvas/storyboard-shots";
import type { CanvasNode } from "@/lib/canvas/types";
import { cn } from "@/lib/utils";
import { LineageDrawer } from "@/components/lineage/LineageDrawer";
import { cardToLineageView } from "@/lib/lineage-view";
import { CHARACTER_CARD_KIND_LABEL } from "@/lib/character-cards";
import { CreationFlowPanel, type VoiceoverFlowView } from "./CreationFlowPanel";
import { formatRelative, toDvh } from "./embed-helpers";
import type { ReviewPanelKind } from "@/components/assets/AssetReviewPanel";
import { openReviewPanel } from "@/components/assets/AssetReviewPanel";

interface CanvasEmbedOverlaysProps {
  /** embed 高度（.ce-embed-root 動態样式）。 */
  height: string;
  expanded: boolean;
  /** Wave C：agent 畫布操作自動化狀態提示（ops 一到由宿主自動執行）。 */
  pendingOps: UseCanvasChatReturn["pendingAgentOps"];
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
  /** 入口開關（同一顆門：已開＝收合，未開＝開該面）。主面＝資產審查。 */
  onToggleReview: (panel: ReviewPanelKind) => void;
  canvas: UseCanvasChatReturn;
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}

/**
 * 分鏡媒體現況計數（引導面板 snapshot 的分母／分子）。
 *
 * 真源＝凍結介面 `shotMediaReadiness`（`@/lib/canvas/storyboard-shots`，W5a 2026-09-30）：
 * 逐鏡投影**分鏡節點自己**的 metadata，本層不另立第二套判準、不往外撈連線鄰居。
 * 「哪些節點算一鏡」＝`metadata.storyboardShot` 非空，與 `countStoryboardProgress`
 * （面板「已落画布 N 镜」）同一把尺，分子分母不會漂移。
 */
function shotMediaCounts(nodes: readonly CanvasNode[]): {
  shots: number;
  withImage: number;
  withVideo: number;
  withAudio: number;
} {
  let shots = 0;
  let withImage = 0;
  let withVideo = 0;
  let withAudio = 0;
  for (const node of nodes) {
    if (!node.metadata?.storyboardShot) continue;
    shots += 1;
    const readiness = shotMediaReadiness((node.metadata ?? {}) as Record<string, unknown>);
    if (readiness.hasImage) withImage += 1;
    if (readiness.hasVideo) withVideo += 1;
    if (readiness.hasAudio) withAudio += 1;
  }
  return { shots, withImage, withVideo, withAudio };
}

/**
 * 引導面板的現況快照（`CreationFlowSnapshot`）：全部由**當前真實資料**推導，
 * 零持久化 onboarding 標記。推不出來的欄位一律不填（fail-closed：`deriveNextStep`
 * 回 `unknown`，不補假進度）。
 *
 * `hasCut`：本站無剪輯產物欄位、也無任何產生剪輯的路徑 ⇒ 成片恆不存在（站點能力事實，
 * 非猜測）。取保守值 `false`——永不冒充「已完成」；`deriveNextStep` 的 cut 分支正為此現況而寫。
 */
function creationFlowSnapshot(
  summary: CreationFlowSummary,
  nodes: readonly CanvasNode[],
): CreationFlowSnapshot {
  const media = shotMediaCounts(nodes);
  return {
    // 與面板「已設定」同一把尺（作品類型／當前步驟／已有劇集任一成立）。
    hasProject: Boolean(summary.projectTypeLabel || summary.currentStep || summary.episodeCount > 0),
    episodes: summary.episodeCount,
    shots: summary.storyboard.shots,
    shotsWithImage: media.withImage,
    shotsWithVideo: media.withVideo,
    shotsWithAudio: media.withAudio,
    hasCut: false,
  };
}

/**
 * 下一步主動作 → 既有入口（不另開通路）：
 *   · `agent`：聚焦畫布 AI 助理的對話輸入框（`AgentComposer` 的固定 id）。
 *     面板處於收合（rail）態時輸入框不在 DOM，此時聚焦落空——不假裝已開啟。
 *   · `canvas-generation`：開啟既有分鏡審查面。`openReviewPanel` 是專為「步驟條」這類
 *     CanvasEmbed 外呼叫端準備的既有外開介面（`AssetReviewPanel` 導出），不造第二個事件。
 */
function runNextStepAction(surface: CreationNextSurface): void {
  if (surface === "agent") {
    const input = document.getElementById("agent-composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
    return;
  }
  if (surface === "canvas-generation") openReviewPanel({ panel: "shot" });
}

/** 下一步主動作的路由結果（純函式，供呼叫端與測試斷言分派，不改既有 `runNextStepAction` 行為）。 */
export type NextActionRoute = "voiceover-quote" | "agent" | "review" | "none";

/**
 * 由（surface, id）決定主動作怎麼走。
 *
 * 唯一新增的路由是 `id === "shot-audio"` → `voiceover-quote`（補配音真的接上生成入口）；
 * 其餘逐條照舊：`agent` → AI 助理輸入框、`canvas-generation` → 分鏡審查面、`none` → 無動作。
 * `surface === "none"` 的面板本來就不渲染按鈕，這裡回 `none` 只是讓函式全值域誠實。
 */
export function nextActionRoute(surface: CreationNextSurface, id?: CreationNextStepId): NextActionRoute {
  if (surface === "none") return "none";
  if (id === "shot-audio") return "voiceover-quote";
  if (surface === "agent") return "agent";
  return "review";
}

/** 配音生成入口（姊妹路，`src/app/api/canvas/storyboard-voiceover/route.ts`）。 */
export const VOICEOVER_ENDPOINT = "/api/canvas/storyboard-voiceover";

/**
 * 配音請求結果（伺服器回應的**忠實投影**，本層不加工、不算幣）。
 * `quote` ＝ 乾跑報價（未扣費）、`applied` ＝ 真跑完成（`costCoins` 為實扣）、
 * `refused` ＝ 伺服器明確拒收（附原因）、`error` ＝ 傳輸／回應不完整。
 */
export type VoiceoverOutcome =
  | { status: "quote"; lineCount: number; totalChars: number; estimatedCoins: number }
  | { status: "applied"; lineCount: number; totalChars: number; costCoins: number }
  | { status: "refused"; reason: string }
  | { status: "error"; reason: string };

/** 非負有限數判據（伺服器回的幣數/字數；不合法＝不知道，不四捨五入、不補 0）。 */
function asServerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 拒收原因的人話（形狀未凍結：字串或物件；讀不出就回一句誠實的通用話，不假成功）。 */
function refusedReason(refused: unknown): string | null {
  if (refused == null || refused === false) return null;
  if (typeof refused === "string") return refused.trim() || "服务端拒绝（未附原因）";
  if (typeof refused === "object") {
    const bag = refused as { reason?: unknown; message?: unknown; code?: unknown };
    for (const value of [bag.reason, bag.message, bag.code]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "服务端拒绝（未附原因）";
}

/**
 * 呼叫配音姊妹路（`POST`）。
 *
 * `dryRun: true` ＝**只報價不生成**（付費硬閘的第一段）；`dryRun: false` ＝ 真跑，
 * 必須由使用者在看到報價後按確認鍵才會走到這裡。
 * `fetchImpl` 可注入（測試全程用假 fetch，禁任何真實付費呼叫）。
 */
export async function requestVoiceover(
  input: { projectId: string; dryRun: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceoverOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(VOICEOVER_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: input.projectId, dryRun: input.dryRun }),
    });
  } catch {
    return { status: "error", reason: "无法连接配音服务（网络错误）" };
  }
  if (!response.ok) {
    // 非 2xx 一律當失敗：不把錯誤回應當成功（HTTP 200 都 ≠ 可用，更何況非 200）。
    return { status: "error", reason: `配音服务返回 ${response.status}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "error", reason: "配音服务返回的不是 JSON" };
  }
  if (!payload || typeof payload !== "object") return { status: "error", reason: "配音服务返回空回应" };
  const data = payload as Record<string, unknown>;

  const refused = refusedReason(data.refused);
  if (refused) return { status: "refused", reason: refused };
  if (data.ok === false) return { status: "error", reason: "服务端回报失败（未附原因）" };

  const lineCount = Array.isArray(data.lines) ? data.lines.length : null;
  const totalChars = asServerNumber(data.totalChars);
  if (lineCount === null || totalChars === null) {
    return { status: "error", reason: "服务端未回报完整的行数/字数" };
  }
  if (input.dryRun) {
    const estimatedCoins = asServerNumber(data.estimatedCoins);
    if (estimatedCoins === null) return { status: "error", reason: "服务端未回报报价币数" };
    return { status: "quote", lineCount, totalChars, estimatedCoins };
  }
  const costCoins = asServerNumber(data.costCoins);
  if (costCoins === null) return { status: "error", reason: "服务端未回报实扣币数" };
  return { status: "applied", lineCount, totalChars, costCoins };
}

/** 伺服器結果 → 面板顯示狀態（唯一的映射點，面板不再自行解讀回應）。 */
function voiceoverView(outcome: VoiceoverOutcome): VoiceoverFlowView {
  if (outcome.status === "quote") {
    return {
      status: "quoted",
      lineCount: outcome.lineCount,
      totalChars: outcome.totalChars,
      estimatedCoins: outcome.estimatedCoins,
    };
  }
  if (outcome.status === "applied") {
    return {
      status: "applied",
      lineCount: outcome.lineCount,
      totalChars: outcome.totalChars,
      costCoins: outcome.costCoins,
    };
  }
  return { status: outcome.status, reason: outcome.reason };
}

export function CanvasEmbedOverlays({
  height,
  expanded,
  pendingOps,
  cardsOpen,
  creationFlowOpen,
  onCloseCreationFlow,
  historyOpen,
  onCloseHistory,
  elementListOpen,
  reviewPanel,
  reviewPendingCount,
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

  // 补齐配音（`shot-audio`）：主動作＝乾跑報價（不扣費），確認鍵才真跑；在途時鎖住防重複送出。
  const [voiceover, setVoiceover] = useState<VoiceoverFlowView>({ status: "idle" });
  const voiceoverBusyRef = useRef(false);

  const startVoiceoverQuote = async () => {
    if (voiceoverBusyRef.current) return;
    const projectId = canvas.getProjectId();
    if (!projectId) {
      setVoiceover({ status: "error", reason: "画布还没有项目号，无法试算配音费用" });
      return;
    }
    voiceoverBusyRef.current = true;
    try {
      setVoiceover({ status: "quoting" });
      setVoiceover(voiceoverView(await requestVoiceover({ projectId, dryRun: true })));
    } finally {
      voiceoverBusyRef.current = false;
    }
  };

  const confirmVoiceover = async () => {
    if (voiceoverBusyRef.current) return;
    const projectId = canvas.getProjectId();
    if (!projectId) {
      setVoiceover({ status: "error", reason: "画布还没有项目号，无法生成配音" });
      return;
    }
    voiceoverBusyRef.current = true;
    try {
      setVoiceover({ status: "applying" });
      setVoiceover(voiceoverView(await requestVoiceover({ projectId, dryRun: false })));
    } finally {
      voiceoverBusyRef.current = false;
    }
  };

  const handleNextAction = (surface: CreationNextSurface, id?: CreationNextStepId) => {
    switch (nextActionRoute(surface, id)) {
      case "voiceover-quote":
        void startVoiceoverQuote();
        return;
      case "agent":
      case "review":
        runNextStepAction(surface);
        return;
      default:
        return;
    }
  };

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

      {/* Wave C：agent 畫布操作自動化——非阻塞狀態提示（ops 一到即由宿主自動落地）。 */}
      {pendingOps && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-ios-caption1 text-white">
          AI 正在操作画布…
        </div>
      )}

      {/* WS-審查（2026-09-24）：畫布工具列入口——資產圖／分鏡確認的兩個面共用這一顆門
          （面板本體在宿主 CanvasEmbed；主入口是步驟條，由另一路實作）。
          位置選左下角：頂欄與左右彈層都被既有面板佔滿，左下是唯一不打架的空位。 */}
      <div
        data-canvas-interactive
        // 桌面全屏態入口已併進右側縮放膠囊（2026-09-27），這顆只留給行動端／非全屏。
        className={cn("pointer-events-auto absolute z-20 flex items-center gap-1.5", expanded && "md:hidden")}
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
                        <span className="shrink-0 rounded-full bg-ios-blue/[0.12] px-1.5 py-0.5 text-ios-caption2 text-[#007AFF]">
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
          hook 既有出口（projectType/currentStep/episodes/nodes），本層零新增狀態。 */}
      {creationFlowOpen && (
        (() => {
          // 面板打開才算（nodes 可能上百顆）：現況快照與下一步都由此推導，零新增狀態。
          const summary = summarizeCreationFlow({
            projectType: canvas.projectType,
            currentStep: canvas.currentStep,
            episodes: canvas.episodes,
            nodes: canvas.nodes,
          });
          return (
            <CreationFlowPanel
              summary={summary}
              nextStep={deriveNextStep(creationFlowSnapshot(summary, canvas.nodes))}
              onNextAction={handleNextAction}
              voiceover={voiceover}
              onVoiceoverConfirm={() => void confirmVoiceover()}
              onClose={() => {
                // 關閉即丟掉上一輪報價/結果（避免下次打開看到過期幣數）。
                setVoiceover({ status: "idle" });
                onCloseCreationFlow();
              }}
            />
          );
        })()
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
                aria-selected={false}
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
