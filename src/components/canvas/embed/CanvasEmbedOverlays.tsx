/**
 * CanvasEmbedOverlays —— CanvasEmbed 四个浮层 + 内嵌 <style>（自 CanvasEmbed.tsx L1563-1632/L1849-2068 机械搬迁）。
 * 本组件必须「无条件挂载」：<style> 的 .ce-embed-* 选择器同时作用于组件壳的顶栏/根容器，
 * 浮层全关时仍渲染样式块，否则壳层样式失效。
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
  /** embed 高度（.ce-embed-root 动态样式）。 */
  height: string;
  expanded: boolean;
  /** Wave C：agent 画布操作自动化状态提示（ops 一到由宿主自动执行）。 */
  pendingOps: UseCanvasChatReturn["pendingAgentOps"];
  /** P2：角色/场景卡面板。 */
  cardsOpen: boolean;
  /** G2（2026-09-16）：作品/剧集面板。 */
  creationFlowOpen: boolean;
  onCloseCreationFlow: () => void;
  /** 历史画布下拉。 */
  historyOpen: boolean;
  onCloseHistory: () => void;
  /** B2：节点清单（全屏态）。 */
  elementListOpen: boolean;
  /**
   * WS-审查（2026-09-24）：资产/分镜审查面板的画布工具列入口状态。
   * 面板本体挂在 CanvasEmbed（宿主），这里只放入口——第二个门（步骤条）由另一路实作，
   * 呼叫端可用 `openReviewPanel()`（`src/components/assets/AssetReviewPanel.tsx` 导出）派事件开这里。
   */
  reviewPanel: ReviewPanelKind | null;
  /** 待批准＋已驳回的总数（入口徽章；0 ＝不显示徽章）。 */
  reviewPendingCount: number;
  /** 入口开关（同一颗门：已开＝收合，未开＝开该面）。主面＝资产审查。 */
  onToggleReview: (panel: ReviewPanelKind) => void;
  canvas: UseCanvasChatReturn;
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}

/**
 * 分镜媒体现况计数（引导面板 snapshot 的分母／分子）。
 *
 * 真源＝冻结介面 `shotMediaReadiness`（`@/lib/canvas/storyboard-shots`，W5a 2026-09-30）：
 * 逐镜投影**分镜节点自己**的 metadata，本层不另立第二套判准、不往外捞连线邻居。
 * 「哪些节点算一镜」＝`metadata.storyboardShot` 非空，与 `countStoryboardProgress`
 * （面板「已落画布 N 镜」）同一把尺，分子分母不会漂移。
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
 * 引导面板的现况快照（`CreationFlowSnapshot`）：全部由**当前真实资料**推导，
 * 零持久化 onboarding 标记。推不出来的栏位一律不填（fail-closed：`deriveNextStep`
 * 回 `unknown`，不补假进度）。
 *
 * `hasCut`：本站无剪辑产物栏位、也无任何产生剪辑的路径 ⇒ 成片恒不存在（站点能力事实，
 * 非猜测）。取保守值 `false`——永不冒充「已完成」；`deriveNextStep` 的 cut 分支正为此现况而写。
 */
function creationFlowSnapshot(
  summary: CreationFlowSummary,
  nodes: readonly CanvasNode[],
): CreationFlowSnapshot {
  const media = shotMediaCounts(nodes);
  return {
    // 与面板「已设定」同一把尺（作品类型／当前步骤／已有剧集任一成立）。
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
 * 下一步主动作 → 既有入口（不另开通路）：
 *   · `agent`：聚焦画布 AI 助理的对话输入框（`AgentComposer` 的固定 id）。
 *     面板处于收合（rail）态时输入框不在 DOM，此时聚焦落空——不假装已开启。
 *   · `canvas-generation`：开启既有分镜审查面。`openReviewPanel` 是专为「步骤条」这类
 *     CanvasEmbed 外呼叫端准备的既有外开介面（`AssetReviewPanel` 导出），不造第二个事件。
 */
function runNextStepAction(surface: CreationNextSurface): void {
  if (surface === "agent") {
    const input = document.getElementById("agent-composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
    return;
  }
  if (surface === "canvas-generation") openReviewPanel({ panel: "shot" });
}

/** 下一步主动作的路由结果（纯函式，供呼叫端与测试断言分派，不改既有 `runNextStepAction` 行为）。 */
export type NextActionRoute = "voiceover-quote" | "agent" | "review" | "none";

/**
 * 由（surface, id）决定主动作怎么走。
 *
 * 唯一新增的路由是 `id === "shot-audio"` → `voiceover-quote`（补配音真的接上生成入口）；
 * 其余逐条照旧：`agent` → AI 助理输入框、`canvas-generation` → 分镜审查面、`none` → 无动作。
 * `surface === "none"` 的面板本来就不渲染按钮，这里回 `none` 只是让函式全值域诚实。
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
 * 配音请求结果（伺服器回应的**忠实投影**，本层不加工、不算币）。
 * `quote` ＝ 干跑报价（未扣费）、`applied` ＝ 真跑完成（`costCoins` 为实扣）、
 * `refused` ＝ 伺服器明确拒收（附原因）、`error` ＝ 传输／回应不完整。
 */
export type VoiceoverOutcome =
  | { status: "quote"; lineCount: number; totalChars: number; estimatedCoins: number }
  | { status: "applied"; lineCount: number; totalChars: number; costCoins: number }
  | { status: "refused"; reason: string }
  | { status: "error"; reason: string };

/** 非负有限数判据（伺服器回的币数/字数；不合法＝不知道，不四舍五入、不补 0）。 */
function asServerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 拒收原因的人话（形状未冻结：字串或物件；读不出就回一句诚实的通用话，不假成功）。 */
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
 * `dryRun: true` ＝**只报价不生成**（付费硬闸的第一段）；`dryRun: false` ＝ 真跑，
 * 必须由使用者在看到报价后按确认键才会走到这里。
 * `fetchImpl` 可注入（测试全程用假 fetch，禁任何真实付费呼叫）。
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
    // 非 2xx 一律当失败：不把错误回应当成功（HTTP 200 都 ≠ 可用，更何况非 200）。
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

/** 伺服器结果 → 面板显示状态（唯一的映射点，面板不再自行解读回应）。 */
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
  // REQ-D1：资产卡「溯源」抽屉——卡片面板每行一颗入口，单例抽屉挂在本浮层。
  const [lineageCardId, setLineageCardId] = useState<string | null>(null);
  const lineageCard = lineageCardId
    ? canvas.characterCards.find((card) => card.id === lineageCardId) ?? null
    : null;

  // 补齐配音（`shot-audio`）：主动作＝干跑报价（不扣费），确认键才真跑；在途时锁住防重复送出。
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

        /* 材质（背景/阴影/模糊）改由 lg-float 供给；这里只留尺寸与排版。 */
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

        /* 工作站态避让改由宿主完成：ImagePlayground 把整个 overlay 向右 dock
           （--ce-dock-left = 面板宽 + 12px），画布全域随之右移，顶栏与左侧弹层
           不再各自加 --ce-chrome-left（避免双重位移）。行动端面板在底部，
           宿主把 overlay 复位成全屏，这里只保留顶栏右缘约束让 chips 能换行。 */
        @media (max-width: 767px) {
          .ce-embed-topbar { right: 0.75rem; }
          /* 行动端 chips 收敛：一排放得下，不再炸成两行大药丸。 */
          .ce-embed-topbar .ce-embed-bar-btn {
            min-width: 0;
            min-height: 2.125rem;
            padding: 0 0.7rem;
            font-size: 0.75rem;
            line-height: 1rem;
          }
        }
      `}</style>

      {/* Wave C：agent 画布操作自动化——非阻塞状态提示（ops 一到即由宿主自动落地）。 */}
      {pendingOps && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-ios-caption1 text-white">
          AI 正在操作画布…
        </div>
      )}

      {/* WS-审查（2026-09-24）：画布工具列入口——资产图／分镜确认的两个面共用这一颗门
          （面板本体在宿主 CanvasEmbed；主入口是步骤条，由另一路实作）。
          位置选左下角：顶栏与左右弹层都被既有面板占满，左下是唯一不打架的空位。 */}
      <div
        data-canvas-interactive
        // 桌面全屏态入口已并进右侧缩放胶囊（2026-09-27），这颗只留给行动端／非全屏。
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

      {/* P2：角色/场景卡面板——卡列表、生效 badge、锁定/解锁、删卡 */}
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
            <p className="text-ios-caption1 font-semibold text-foreground">实体卡（角色 / 场景 / 风格 / 道具 / 音频）</p>
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
                    <p className="flex items-center gap-1.5 truncate text-ios-caption1 font-medium text-foreground">
                      <span className="truncate">{card.name}</span>
                      <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                        {CHARACTER_CARD_KIND_LABEL[card.kind]}
                      </span>
                      {card.variantOf && (
                        <span className="shrink-0 rounded-full bg-ios-blue/[0.12] px-1.5 py-0.5 text-ios-caption2 text-[#007AFF]">
                          变体
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
                        ? "shrink-0 cursor-pointer rounded-lg bg-ios-green/10 px-2 py-1 text-ios-caption1 font-medium text-[#248A3D] hover:bg-ios-green/20"
                        : "shrink-0 cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-ios-caption1 font-medium text-muted-foreground hover:bg-black/10"
                    }
                  >
                    {active ? "解锁" : "锁定"}
                  </button>
                  {/* REQ-D1 溯源入口：卡本体的血统抽屉（「存为卡片」登记的来源可查）。 */}
                  <button
                    type="button"
                    aria-label={`溯源卡 ${card.name}`}
                    onClick={() => setLineageCardId(card.id)}
                    className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-ios-caption1 text-foreground/45 hover:bg-black/5 hover:text-[#007AFF]"
                  >
                    溯源
                  </button>
                  <button
                    type="button"
                    aria-label={`删除卡 ${card.name}`}
                    onClick={() => void canvas.removeCharacterCard(card.id)}
                    className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-ios-caption1 text-foreground/45 hover:bg-black/5 hover:text-destructive"
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

      {/* G2（2026-09-16）：作品/剧集面板——与角色卡同款左侧弹层；资料全部取自
          hook 既有出口（projectType/currentStep/episodes/nodes），本层零新增状态。 */}
      {creationFlowOpen && (
        (() => {
          // 面板打开才算（nodes 可能上百颗）：现况快照与下一步都由此推导，零新增状态。
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
                // 关闭即丢掉上一轮报价/结果（避免下次打开看到过期币数）。
                setVoiceover({ status: "idle" });
                onCloseCreationFlow();
              }}
            />
          );
        })()
      )}

      {/* 历史画布下拉 */}
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

      {/* B2：节点清单（全屏态）→ 点击飞行聚焦 */}
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
                <span className="min-w-0 flex-1 truncate text-ios-caption1 text-muted-foreground">{n.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
