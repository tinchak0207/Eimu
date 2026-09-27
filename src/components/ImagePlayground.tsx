"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ImageDisplay } from "@/components/ImageDisplay";
import { PromptInput, type PromptInputMode } from "@/components/PromptInput";
import { FaqSection } from "@/components/FaqSection";
import { UseCaseLinks } from "@/components/UseCaseLinks";
import { useCanvasChat, type UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import {
  FALLBACK_PROGRESS_DURATION_MS,
  NORMAL_PROGRESS_DURATION_MS,
} from "@/components/GenerationProgressBar";
import { useImageGeneration } from "@/hooks/use-image-generation";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import {
  MODEL_CONFIGS,
  PROVIDERS,
  ProviderKey,
} from "@/lib/provider-config";
import {
  defaultGenerateAudio,
  defaultAspectRatio,
  defaultDuration,
  defaultOutputResolution,
  generationCoins,
  generationModel,
  normalizeGenerationConfig,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { enhancePrompt, type StylePreset } from "@/lib/prompt-enhancer";
import { hasEnoughQuota } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { cn } from "@/lib/utils";
import { isStandalonePwa, createHandoffLogin } from "@/lib/github-login";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { PromoIntroOverlay } from "@/components/promo/PromoIntroOverlay";
import {
  PROMO_ENTRY_UNDECIDED,
  PROMO_SEEN_KEY,
  PROMO_TRIAL_PROMPT,
  clearPendingTrial,
  isForcedPreview,
  readPendingTrial,
  resolvePromoEntry,
  resolvePromoTrialIntent,
  stashBlockedSend,
  writePendingTrial,
  type PromoEntryDecision,
} from "@/components/promo/promo-gate";
import { getInitialSuggestions, type Suggestion } from "@/lib/suggestions";
import { WelcomeGiftDialog } from "@/components/welcome/WelcomeGiftDialog";
import { AGENT_EXAMPLE_PROMPTS } from "@/lib/agent-example-prompts";
import { ackWelcomeGiftModalSeen } from "@/lib/auth-client";
import {
  markWelcomeGiftModalSeenLocally,
  welcomeGiftModalSeenLocally,
} from "@/lib/welcome-gift-modal";
import type { ReferenceImage } from "@/lib/image-types";
import { CanvasChatWorkstation } from "@/components/canvas-workstation/CanvasChatWorkstation";
import { AgentTemplateCarousel } from "@/components/canvas-workstation/AgentTemplateCarousel";
import { templateToCanvasLayout } from "@/components/canvas-workstation/agent-template-canvas";
import { DIRECTOR_RENDER_REQUEST_EVENT } from "@/components/director-mini/DirectorMiniViewport";
// 2026-09-12 首屏減重拆分：AGENT_TEMPLATES 只含卡面顯示 metadata；
// 執行 payload（initialPrompt/directive/slots/步驟文案）在 agent-templates-payload.ts，
// 由 handleUseAgentTemplate 在使用處 await import() 動態載入（見下方回調）。
// AgentTemplateFull 為純型別 import（編譯期擦除，不拉 payload 進 bundle）。
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import type { AgentTemplateFull } from "@/lib/agent-templates-payload";
import { fetchAgentCanvasSnapshot } from "@/lib/canvas/client";
import { useAgentParamReflect } from "@/hooks/use-agent-param-reflect";

// 2026-08-27 專業工作站入口移除：AI 工作站（agent 模式）已吸收其獨有機制
// （LoRA 庫 / 配方模板 / kunpeng 風格库），舊工作站不再被動態 import。

// AGENT_PARAM_LABELS（D-12 撤销条项目名）留在 hooks/use-agent-param-reflect.ts；
// 撤销条 UI 已随罪状 7 删除，钩子里的三态标记仍服务参数回流。

// 聊天区的懒加载 import 在 PromptInput 里：聊天区是那张卡片的一个面，
// 由持有 toggle 的组件自己按需拉 chunk，这里不再需要它。

/** 卡片的四个面。第四个面 agent 与 edit / upscale 同级，见 PromptInput。 */
type PlaygroundMode = PromptInputMode;

export function ImagePlayground({ suggestions }: { suggestions: Suggestion[] }) {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  // D-1 + D-24 状态B：agent 是卡片的第四个面，和 edit / upscale 同一层级的 toggle。
  // 按下去只换卡片中间那块控件区（共用 generate/edit/upscale 那套 dust 转场），
  // 卡片底板、右边结果画布、底下案例区全部原地不动，也不跳 /agent 独立页。
  //
  // 2026-09-22 暴君裁定：**首屏初始面翻成 AI 助理**，直接生圖降為同級第二面
  // （不刪除、toggle 語義一行不動）。理由是首屏決定產品定位——進站第一眼看見
  // 的是參數框＋輸入框＋輸出框，就會被判定成生圖中轉站；新範式若鎖在「先點
  // 助理再發話」兩步之後，每一步都不是使用者已知的。深度連結（?agent=1）的
  // setMode("agent") 因此常態成為冪等，但那段仍需處理 q / session 注入。
  const [mode, setMode] = useState<PlaygroundMode>("agent");
  const [displayMode, setDisplayMode] = useState<PlaygroundMode>("agent");
  const [animState, setAnimState] = useState<"idle" | "exit" | "enter">("idle");
  // 别的页面（D-18 图库卡）用 ?agent=1&q= 交接过来的一句话。
  const [agentSeed, setAgentSeed] = useState("");
  // 2026-08-25 模板庫：點卡注入 pending（nonce 讓「換一張卡」也是新注入）。
  // directive 是隱形引導詞：隨首條訊息經網關 system 欄位注入，用戶全程不可見。
  const [agentTemplateInjection, setAgentTemplateInjection] = useState<{ text: string; nonce: number; directive?: string; echo?: boolean } | null>(null);
  // C4 生成閉環事件橋：導演台視口「生成真实画面」完成 capture+上傳後 dispatch
  // director-render-request → 與模板庫共用同一注入 setter（AgentChatSurface 的
  // injection effect 收到即靜默發送，send() 無會話時 lazy 建號＋連線）。卸載時移除監聽。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      if (!detail || typeof detail.text !== "string" || !detail.text.trim()) return;
      setAgentTemplateInjection({ text: detail.text, nonce: Date.now() });
    };
    window.addEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
    return () => window.removeEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
  }, []);
  // 模板庫退場旗標：發出第一條用戶消息（模板注入或手打）即收起，之後不再出現。
  const [agentTemplateDismissed, setAgentTemplateDismissed] = useState(false);
  // PWA 登录交接面板（standalone 内 GitHub 授权走跨浏览器 handoff）。
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);
  // wish 插件深链（?agent=1&session=<uuid>）：落地后直开该会话而非新开对话。
  const [initialAgentSessionId, setInitialAgentSessionId] = useState("");
  /**
   * 未登入新訪客的進站宣傳片（2026-09-27 暴君裁定落地）。
   *
   * 頻率：每瀏覽器一次（PROMO_SEEN_KEY）——新機／新瀏覽器給完整震撼，回訪的
   * 未登入用戶不再被反覆擋在門外。判定鏈是純函式（promo-gate.ts），這裡只負責
   * 讀儲存、開浮層、以及收尾那句「一送出就開新對話直送產線」。
   *
   * 為什麼掛在這頁而不是 layout：收尾要當場開新對話並把那句話送進聊天區，
   * 那條通路（startNewSessionRef ＋ agentTemplateInjection）只在這棵樹上——
   * 掛 layout 就只能整頁跳轉，等於把畫布與聊天區整個重建一次。
   */
  const [promoOpen, setPromoOpen] = useState(false);
  // 未登入時送不出去的那句話：存起來，登入態翻真就自動補送（見 promo-gate.ts）。
  const promoPendingRef = useRef<string | null>(null);
  const { images, timings, failedProviders, isLoading, startGeneration, cancelTask, tasks } = useImageGeneration();
  // authLoading 必須與上面 useImageGeneration 的 isLoading 區分開：
  // 那是生圖忙碌態，不是登入態——拿它當水合判斷，等於對狀態不明的用戶插播。
  // 註：措辭避開「生＋成＋中」那三字連寫，ImageDisplay.test 以它在四檔的
  // 出現次數＝1 當契約，這裡多一次會讓它誤紅。
  const { user, token, isLoggedIn, refresh, isLoading: authLoading, welcomeGift, clearWelcomeGift } = useAuth();
  const { toast } = useToast();
  // 新人禮首登彈窗的開啟態（每設備只彈一次的輔助閘門見 welcomeGiftModalSeenLocally）。
  const [welcomeGiftOpen, setWelcomeGiftOpen] = useState(false);
  // 彈窗主按鈕的「預填但不送出」通路：走 AgentChatSurface 既有的 prefillRequest
  // （輸入框有字、光標在末尾、焦點在框上，人再按送出），不是新機制。
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const initialSuggestions = useMemo(() => getInitialSuggestions(suggestions), [suggestions]);
  const [selectedModels, setSelectedModels] = useState(MODEL_CONFIGS.fast);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(() => defaultAspectRatio(MODEL_CONFIGS.fast.image_tinchak));
  const [outputResolution, setOutputResolution] = useState<OutputResolution>(() => defaultOutputResolution(MODEL_CONFIGS.fast.image_tinchak));
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(() => defaultDuration(MODEL_CONFIGS.fast.image_tinchak));
  const [generateAudio, setGenerateAudio] = useState(() => defaultGenerateAudio(MODEL_CONFIGS.fast.image_tinchak));
  const [stylePreset, setStylePreset] = useState<StylePreset>("none");
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
// PixAI edit/upscale results are delivered straight to the result canvas on
// the right; they do not go through the normal generation queue.
const [pixaiResultUrl, setPixaiResultUrl] = useState<string | null>(null);
  // v3 embed：右側結果面板 mode。2026-08-25 canvas 常駐化：agent 模式右側
  // 一進入就是 canvas（模板庫或畫布），不再有「AI 助理左邊、圖片結果右邊」
  // 的中間態。非 agent 模式（generate/edit/upscale）維持 ImageDisplay。
  // 畫布工作站（2026-08-16，暴君裁定「擠」）：畫布模式 = 全場畫布，聊天卡
  // 變成左側浮動面板，expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  // 遼闊是預設，不是獎勵——不再有「compact 嵌右欄」這種把畫布塞縫裡的狀態。
  // 面板兩態/寬度/拖寬與 localStorage 持久化抽到 canvas-workstation/use-chat-panel。
  // 單一 SSE：AgentChatSurface 自建 useAgentChat，其 onCanvasEvent 出口餵回畫布。
  // 用 ref 解開循環依賴：onCanvasEvent 轉交 canvasHostRef；canvasHost 後建，餵回 ref。
  const canvasHostRef = useRef<UseCanvasChatReturn | null>(null);
  const handleCanvasEvent = useCallback((event: AgentSseEvent) => {
    // 畫布資料管線只吃 canvas 結構事件，tool.invoke 不入 reducer
    // （模式切換已不需要：canvas 常駐化後 agent 模式右側恆為 canvas）。
    if (event.name === "tool.invoke") {
      return;
    }
    canvasHostRef.current?.feedCanvasEvent(event);
  }, []);
  const handleCanvasSummary = useCallback(() => canvasHostRef.current?.summarize(), []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // Bug1a：模板庫退場旗標隨「進入新對話」復位。session id 變了 = 開新聊天 =
  // 畫布已被清空，模板庫必須再次出現（「開啟新聊天就代表 Canvas 進入模板展示態」）；
  // 續上同一會話（toggle 往返 / 刷新 resume）不復位 —— 那是繼續對話，不是新開始。
  // ref 記住上一個非空 id：卸載-重掛時的 onSessionChange(null) 中間態不許把
  // 錨點洗掉，否則同會話 resume 也會被誤判成「新對話」而重播模板庫。
  const prevAgentSessionRef = useRef<string | null>(null);
  const handleAgentSessionChange = useCallback((nextSessionId: string | null) => {
    if (nextSessionId === null) {
      setCurrentSessionId(null);
      return;
    }
    if (nextSessionId !== prevAgentSessionRef.current) {
      prevAgentSessionRef.current = nextSessionId;
      setAgentTemplateDismissed(false);
    }
    setCurrentSessionId(nextSessionId);
  }, []);
  const canvasHost = useCanvasChat(currentSessionId);
  canvasHostRef.current = canvasHost;

  // 雙向同步方向A：畫布選中 workflow 節點 → chat 切到該節點所屬會話。
  // switchSessionRef 由 AgentChatSurface 上拋（畫布 → chat 方向唯一入口）；
  // 節點不帶 session_id（普通生成/提示卡）不切，避免誤切。
  // 反饋閉環靠 currentSessionId 兜底：切完後 selectedNodeId 對應節點的
  // session_id === currentSessionId，相等判斷擋住死循環。
  const switchSessionRef = useRef<((sessionId: string) => Promise<boolean>) | null>(null);
  // 暴君裁定 2026-09-01：套模板「留舊開新」——AgentChatSurface 上拋 startNewSession。
  const startNewSessionRef = useRef<(() => Promise<boolean>) | null>(null);
  const lastLinkedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    const nodeId = canvasHost.selectedNodeId;
    if (!nodeId) return;
    const node = canvasHost.nodes.find((n) => n.id === nodeId);
    const targetSessionId = node?.metadata?.session_id;
    if (!targetSessionId) return;
    if (targetSessionId === currentSessionId) return;
    if (lastLinkedSelectionRef.current === nodeId) return;
    lastLinkedSelectionRef.current = nodeId;
    void switchSessionRef.current?.(targetSessionId);
  }, [canvasHost.selectedNodeId, canvasHost.nodes, currentSessionId]);

  // 模板庫只在「畫布空且無對話」的初始態出現：有任何節點/計畫（模板鋪過、
  // agent 建過、或歷史專案恢復）或已發過消息（agentTemplateDismissed）就讓位。
  const showAgentTemplateGallery =
    displayMode === "agent" &&
    !agentTemplateDismissed &&
    canvasHost.nodes.length === 0 &&
    canvasHost.plans.length === 0;

  /**
   * 2026-08-25 模板卡點擊（卡即動作）：
   * ① initialPrompt 經既有 useAgentChat 鏈路自動發出（PromptInput →
   *    AgentChatSurface 的 agentInjection：09-12 起注入到了就 send，
   *    send() 無會話時 lazy 建號＋連線，不再等 autoStart/連線 open）。
   * ② 模板 slots 經 recipeTemplateToRecallConfig → templateToCanvasLayout
   *    → useCanvasChat.replaceWorkflowNodes 鋪成 workflow，等 agent 修改。
   * ③ 首條消息落地即收起畫廊（onUserMessage）。
   * 2026-08-26 環節選擇：第二參 selectedIndices 來自卡面圓環，先 cropTemplate
   *    裁剪（全選 = 原對象零開銷），注入與鋪畫布都用裁剪後的模板。
   * 09-01 裁定「留舊開新」+ 09-12 建號權收歸發送按鈕：startNewSession 只清空
   *    回空態（不建號、無 session transition），結算即鋪即注入；注入的首條
   *    消息 lazy 建新會話承接，畫布摘要隨該消息上行。
   */
  // Bug3：同一 workflow 重點 = 替換不是疊加。cropTemplate 裁剪後 template.id 不變，
  // 重選環節再點同一張卡 = 同 id 替換：舊節點及其連線一次清掉，history 一格可整體 undo。
  const applyPendingTemplate = useCallback((cropped: AgentTemplateFull) => {
    const layout = templateToCanvasLayout(cropped);
    canvasHostRef.current?.replaceWorkflowNodes(cropped.id, layout.nodes, layout.connections);
    setAgentTemplateInjection({ text: cropped.initialPrompt, nonce: Date.now(), directive: cropped.directive });
    setAgentTemplateDismissed(true);
  }, []);
  const handleUseAgentTemplate = useCallback((card: AgentTemplate, selectedIndices: number[]) => {
    // 2026-09-12 首屏減重：執行 payload 點卡才動態載入（chunk 進快取，之後零開銷）；
    // 載入失敗（離線等）不收起畫廊，模板不會憑空消失，可重試。
    void (async () => {
      const { hydrateAgentTemplate, cropTemplate } = await import("@/lib/agent-templates-payload");
      const template = hydrateAgentTemplate(card);
      const cropped = cropTemplate(template, selectedIndices);
      setAgentTemplateDismissed(true);
      const start = startNewSessionRef.current;
      if (!start) {
        // ref 未接上（極端時序）：退回舊行為直接鋪在當前會話，模板不能憑空消失。
        applyPendingTemplate(cropped);
        return;
      }
      // 開新＝清空回空態是同步語義（僅在建號管線在飛時等一下），結算即鋪；
      // ok=false（auth/closed 封鎖開新）同樣直接鋪在當前會話——模板不能憑空消失。
      void Promise.resolve(start()).then(() => applyPendingTemplate(cropped));
    })().catch((error) => {
      console.error("[agent-templates] 執行 payload 載入失敗", error);
      setAgentTemplateDismissed(false);
    });
  }, [applyPendingTemplate]);

  // Bug1b：會話恢復回填。refresh/重進後左聊天續上（本地存檔 resume），但右畫布
  // 空白 —— 快照此前只有上行沒有下行。監聽 currentSessionId：每個新拿到的 sid 拉
  // 一次閘道存檔（GET 同上行端點），僅當 nodes>0 才回填；拉取異步到達時 sessionId
  // 變化 effect（newCanvasSession 清場）已跑完，load 直接覆蓋即可。用戶搶先鋪過
  // 模板（或有計畫卡）就不覆蓋，避免快照把剛做好的東西沖掉。
  const restoredSnapshotForRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = currentSessionId;
    if (!sid || restoredSnapshotForRef.current === sid) return;
    restoredSnapshotForRef.current = sid;
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchAgentCanvasSnapshot(sid);
      if (cancelled || !snapshot) return;
      const host = canvasHostRef.current;
      if (!host || host.nodes.length > 0 || host.plans.length > 0) return;
      host.restoreAgentSnapshot(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);
  const [progressStartedAt, setProgressStartedAt] = useState<number>();
  const [progressDurationMs, setProgressDurationMs] = useState(NORMAL_PROGRESS_DURATION_MS);
  const [showProgress, setShowProgress] = useState(false);

  // 進度條 ETA：服務端已按模型統計成功生成的耗時 p80（/api/user/model-eta，
  // 數據源 = generation_attempt.latency_ms 遙測）。掛載時拉一次；讀不到
  // （遙測不可用/樣本不足）就沿用固定 duration。ETA 不顯示，只調進度流逝。
  const [modelEtaMs, setModelEtaMs] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/model-eta")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { models?: Record<string, number> } | null) => {
        if (!cancelled && payload?.models) setModelEtaMs(payload.models);
      })
      .catch(() => {
        // ETA 是加分項：拉不到就靜默用固定 duration。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const etaDurationForModel = useCallback(
    (modelId: string): number => modelEtaMs[modelId] ?? NORMAL_PROGRESS_DURATION_MS,
    [modelEtaMs],
  );

  // 2026-08-25 canvas 常駐化：右側面板 mode 由 displayMode 唯一決定——agent 模式
  // 恆為 canvas（模板庫→畫布），非 agent 模式恆為 ImageDisplay。原黏性旗標/
  // workflow_start 切換/節點數回退等中間態邏輯全部收斂刪除。
  const resultMode: "image" | "canvas" = displayMode === "agent" ? "canvas" : "image";
  const inCanvasWorkstation = displayMode === "agent";
  // 首頁輸入欄高度自適應（2026-09-11）：結果欄 ImageDisplay 一直吃滿欄高，輸入卡
  // 過去由內容高決定、下方留一片空白。≥xl（Tailwind xl = 1280px，與 globals.css 的
  // .playground-column-fill 同一斷點）把卡片交給 flex 鏈吃滿欄高，跟隨結果欄；
  // <xl 維持文檔流自然高（useIsNarrow 首幀回 false＝寬屏，與 CSS 的 mobile-first
  // 方向一致，不會出現 CSS/JS 斷點錯位）。
  const isBelowXl = useIsNarrow("(max-width: 1279.98px)");
  // ─── 畫布工作站：畫布模式鎖頁面捲動（面板記憶載入/持久化在 use-chat-panel）───
  useEffect(() => {
    if (!inCanvasWorkstation) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inCanvasWorkstation]);

  const redirectToGithub = useCallback(() => {
    // PWA standalone：GitHub 登录态带不进来，改走跨浏览器交接面板。
    if (isStandalonePwa()) {
      void (async () => {
        const handoff = await createHandoffLogin();
        if (handoff) {
          setPwaHandoffUrl(handoff.loginUrl);
          return;
        }
        window.location.href = "/api/auth/github/start";
      })();
      return;
    }
    window.location.href = "/api/auth/github/start";
  }, []);

  const triggerTransition = useCallback((next: PlaygroundMode) => {
    setAnimState("exit");
    setMode(next); // 按钮选中状态立即更新
    // 立即 mount：聊天面 chunk 渲染与建号管线即刻启动，翻面动画纯视觉层
    // （animState enter/idle 保留驱动过渡，不再用 260ms setTimeout 挡 displayMode）。
    setDisplayMode(next);
    setAnimState("enter");
    setTimeout(() => setAnimState("idle"), 320);
  }, []);

  const handleModeChange = useCallback((next: PlaygroundMode) => {
    if (animState !== "idle") return;
    if (next === mode && mode !== "generate") {
      triggerTransition("generate");
    } else if (next !== mode) {
      triggerTransition(next);
    }
  }, [mode, animState, triggerTransition]);

  // D-18 交接：/history 的「交给 AI 助理继续做」带 ?agent=1&q= 回首页。
  // 那些页面不像这张卡片能就地翻面，只能带着话跳过来；落地后直接开在 agent 面。
  // 读完就把 query 从地址栏抹掉（replaceState，不进历史）：留着它刷新会重复注入。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("agent") !== "1") return;
    // URL 里塞进来的东西不可信，截一下长度，别让它撑爆输入区。
    setAgentSeed((params.get("q") ?? "").slice(0, 500));
    // 会话深链：只接受 UUID 形状（36 位十六进制+连字符），别的值当没带。
    const sessionParam = params.get("session") ?? "";
    if (/^[0-9a-f-]{36}$/i.test(sessionParam)) setInitialAgentSessionId(sessionParam);
    setMode("agent");
    setDisplayMode("agent");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // 交接语只属于它被交给的那一次对话：离开 agent 面就作废。
  // 不清的话，使用者半小时后再 toggle 开助理，会被塞回一句
  // 「照这个想法再做一版：…」——那是上次从图库带过来的话，早就不是他现在想做的事。
  useEffect(() => {
    if (mode !== "agent" && agentSeed) setAgentSeed("");
  }, [mode, agentSeed]);

  /**
   * 進站判定：登入態水合完成後才判——水合中（authLoading）是「還不知道」，
   * 對還不知道的用戶插播等於對已登入用戶插播。讀一次 localStorage，
   * 看過就不再開；深鏈交接（?agent=1&q=/?session=）讓路、渠道來訪（B 站／微信，
   * 人是被宣傳片吸引來的）也讓路，判準全在 promo-gate.ts。
   *
   * 頻率：**每頁載入只判一次**（resolvePromoEntry）。這條 effect 依賴登入態，
   * 但登入態翻面不等於重新進站——2026-09-27 暴君實錘：登入中的用戶按登出，
   * isLoggedIn 由真翻假，若重判就會把 `?promo=1` 的強制預覽又播一次（見
   * promo-gate.ts 的 resolvePromoEntry 註釋）。定案後一律沿用首次結果。
   *
   * 渠道來訪只是「這次不開浮層」，不寫「已看過」：他下次直接進站（無 Referer）
   * 仍會被影片接住，首次進站的震撼不會被渠道那一次的判斷吃掉。
   */
  const promoEntryRef = useRef<PromoEntryDecision>(PROMO_ENTRY_UNDECIDED);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (promoEntryRef.current.decided) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(PROMO_SEEN_KEY) === "1";
    } catch {
      // 私密模式／停用儲存：讀不到就當沒看過（本次照播），不因此炸掉首頁。
    }
    const decision = resolvePromoEntry(promoEntryRef.current, {
      isLoading: authLoading,
      isLoggedIn,
      seen,
      search: window.location.search,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
    });
    promoEntryRef.current = decision;
    if (decision.decided && decision.play) setPromoOpen(true);
  }, [authLoading, isLoggedIn]);

  /**
   * 浮層收尾（2026-09-27 暴君第二輪：「还不如把封面做成结尾界面，输入框变成
   * 真的能输入，用户一发送马上开新对话」）：不再只是預填，而是當場開新對話把那句
   * 送進聊天區——送出去的動作就是人按的那一下，D-5／D-24 的語義不受影響。
   *
   * 強制預覽（?promo=1）不寫「已看過」：驗收看過一次不等於這個瀏覽器已經
   * 消耗掉真正的首次進站體驗。
   */
  const markPromoSeen = useCallback(() => {
    if (isForcedPreview(window.location.search)) return;
    try {
      window.localStorage.setItem(PROMO_SEEN_KEY, "1");
    } catch {
      // 存不了就算了：不擋這次的動作，最壞情況是下次再播一遍。
    }
  }, []);

  /**
   * 留舊開新＋直送。與模板卡同一條路（startNewSessionRef → 注入即送），
   * 但這條要 echo：那句話是使用者自己打的，必須出現在他自己的聊天記錄裡
   * ——不 echo 的話，送出後到第一個字回來之前畫面完全是空的（2026-09-27 暴君）。
   */
  const runPromoTrial = useCallback((text: string) => {
    const trimmed = text.trim() || PROMO_TRIAL_PROMPT;
    const inject = (): void =>
      setAgentTemplateInjection({ text: trimmed, nonce: Date.now(), echo: true });
    const start = startNewSessionRef.current;
    if (!start) {
      // ref 未接上（極端時序）：退回直接送在當前會話，不能把這句話吃掉。
      inject();
      return;
    }
    void Promise.resolve(start()).then(inject);
  }, []);

  /**
   * 收尾送出的那句話（2026-09-27 暴君第三輪）：登入態決定「當場開跑」還是
   * 「先彈登入窗再開跑」，分流是純函式（resolvePromoTrialIntent）。
   *
   * 未登入那條不是丟掉：那句話先寫進 ref ＋ sessionStorage，登入態一翻真就補送。
   * 兩型登入都吃這條——微信彈窗是原地完成（ref 還在），GitHub 同窗口跳轉回來
   * 時元件已重掛（ref 沒了，靠 sessionStorage 那一份接住）。
   * 使用者主動按了送出＝這部片對他是有效的，所以無論走哪條都先記「看過」。
   */
  const handlePromoTrial = useCallback(
    (text: string) => {
      markPromoSeen();
      const intent = resolvePromoTrialIntent(text, isLoggedIn);
      if (intent.kind === "login") {
        // 那句話先留住；登入小框由浮層自己長（在送出鈕正上方），不遮蓋結尾畫面。
        promoPendingRef.current = intent.pending;
        writePendingTrial(typeof window === "undefined" ? null : window.sessionStorage, intent.pending);
        return;
      }
      setPromoOpen(false);
      setMode("agent");
      setDisplayMode("agent");
      runPromoTrial(intent.text);
    },
    [isLoggedIn, markPromoSeen, runPromoTrial],
  );

  /**
   * 收尾的退路（跳過 / Esc / 先逛逛）：只關浮層，不送話。
   * 順手清掉待送的那句——使用者在登入窗前選了「先不登入」並離開，
   * 之後某次無關的登入不該突然把這句話送出去（那不是他要的）。
   */
  const handlePromoDismiss = useCallback(() => {
    markPromoSeen();
    setPromoOpen(false);
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
  }, [markPromoSeen]);

  /**
   * 登入小框被關掉（先不登录／Esc／點封面空白處）：浮層留在原地，但那句話不再
   * 待送——他選擇不登入，之後某次無關的登入不該突然把它送出去。
   */
  const handlePromoLoginDismiss = useCallback(() => {
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
  }, []);

  /**
   * 主輸入區那句話被登入擋下（hook 的 onSendBlockedByAuth）→ 存進與宣傳片同一格。
   *
   * 為什麼要有這條：宣傳片浮層已經有「pending + 登入後補送」，但站上真正的入口
   * （首頁主輸入區）沒吃到——未登入的人在那裡打字送出，那句話當場消失（composer
   * 已清空，且 GitHub 登入是同窗口整頁跳轉，回來元件狀態全死），要重打一遍。
   * 存同一格＝下面那條「登入態翻真 → 補送」effect 原樣接手，不必另造補送鏈。
   */
  const handleSendBlockedByAuth = useCallback((text: string) => {
    const stashed = stashBlockedSend(
      typeof window === "undefined" ? null : window.sessionStorage,
      text,
    );
    promoPendingRef.current = stashed;
  }, []);

  /**
   * 登入態翻真 → 補送那句話。
   * 讀 ref 與 sessionStorage 兩處：ref 覆蓋同頁登入（按對話區的登入鈕／微信 popup），
   * sessionStorage 覆蓋跳轉型登入（OAuth 落地回 / 時元件已重掛、ref 早就沒了）。
   *
   * 這句話有兩個來源，共用同一格、走同一條補送：
   * ①宣傳片收尾輸入框（handlePromoTrial 的 login 分支）；
   * ②首頁主輸入區（handleSendBlockedByAuth：未登入送出＝hook 的 not_authenticated）。
   * 兩者都是「使用者已經按下送出、只是還沒登入」，所以補送就是完成他那個動作，
   * 不是替他多做一件事。
   */
  useEffect(() => {
    if (!isLoggedIn || authLoading) return;
    const pending = promoPendingRef.current
      ?? readPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
    if (!pending) return;
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
    // 登入成功＝宣傳片這條線走完：浮層收掉，然後真的開一個會話開跑。
    setPromoOpen(false);
    setMode("agent");
    setDisplayMode("agent");
    runPromoTrial(pending);
  }, [authLoading, isLoggedIn, runPromoTrial]);

  /**
   * 新人禮待展示 → 開彈窗。
   * 閘門權威在服務端（welcome_gift_grant.modal_seen_at，經 /api/auth/me 的加法欄位）；
   * 本機 localStorage 只擋「同一台設備已經看過」的重複彈，換設備時本機標記是空的，
   * 仍由服務端決定彈不彈。未登入／還沒水合完都不彈——否則會對未登入的人插播
   * 一條「已送你 5 币」。
   */
  useEffect(() => {
    if (authLoading || !isLoggedIn || !user?.id) return;
    if (!welcomeGift?.pending) return;
    if (welcomeGiftModalSeenLocally(user.id)) return;
    setWelcomeGiftOpen(true);
  }, [authLoading, isLoggedIn, user?.id, welcomeGift]);

  /**
   * 展示過的回執＋本機關門。回執失敗照樣關窗（見 ackWelcomeGiftModalSeen 註：
   * 沒寫上只會讓下次登入再彈一次，比把新人禮藏起來輕）。
   */
  const handleWelcomeGiftSeen = useCallback(() => {
    const userId = user?.id;
    if (userId) markWelcomeGiftModalSeenLocally(userId);
    setWelcomeGiftOpen(false);
    clearWelcomeGift();
    if (token) void ackWelcomeGiftModalSeen(token);
  }, [clearWelcomeGift, token, user?.id]);

  /**
   * 主按鈕「马上生成第一张」：關窗、切到 AI 助理、把**既有示例的第一條**預填進輸入框。
   * 示例句不寫死——與聊天面板空態快捷 chips 共用 agent-example-prompts 這一真源。
   */
  const handleWelcomeGiftStart = useCallback(() => {
    handleWelcomeGiftSeen();
    setMode("agent");
    setDisplayMode("agent");
    const sample = AGENT_EXAMPLE_PROMPTS[0];
    if (sample) setComposerPrefill({ text: sample, nonce: Date.now() });
  }, [handleWelcomeGiftSeen]);

  /**
   * 工作站的 applyCreatorResource 依赖 [onModelChange]，一旦这个 prop 每次
   * render 都换身份，<CreatorResourcePanel> 的 memo 就完全失效，
   * 32 张资源卡（含 32 个 next/image）会跟着生成期间的每一次 render 重渲染。
   * setState 的 updater 形式让依赖数组可以是空的。
   */
  const handleModelChange = useCallback((modelId: string) => {
    const normalized = normalizeGenerationConfig(modelId).config;
    setSelectedModels((current) => ({ ...current, image_tinchak: modelId }));
    setAspectRatio(normalized.aspectRatio);
    setOutputResolution(normalized.outputResolution);
    setDurationSeconds(normalized.durationSeconds);
    setGenerateAudio(normalized.generateAudio ?? false);
    // 参考图的清理交给下面的 effect：副作用（提示）不能写在 setState 的 updater 里。
  }, []);

  // ── D-12：助理动过的参数回流到工作台控件（三态復原抽到 use-agent-param-reflect）──
  // userSet* 系列 setter 的身分（useCallback 依賴陣列）在 hook 內原樣保留：
  // PromptInput 那側沒有 memo 依賴，但工作站 onModelChange 的穩定引用設計
  // 不允許這裡換身分。
  const {
    handleParamsReflected,
    userSetAspectRatio,
    userSetOutputResolution,
    userSetModel,
  } = useAgentParamReflect({
    modelId: selectedModels.image_tinchak,
    aspectRatio,
    outputResolution,
    handleModelChange,
    setAspectRatio,
    setOutputResolution,
  });

  /**
   * 模型不支持参考图时清空并说明原因。
   */
  useEffect(() => {
    if (generationModel(selectedModels.image_tinchak)?.referenceImages) return;
    if (referenceImages.length === 0) return;
    setReferenceImages([]);
  }, [selectedModels.image_tinchak, referenceImages.length]);

  const handlePromptSubmit = useCallback(async (rawPrompt: string) => {
    if (!LOCAL_TEST_MODE && (!isLoggedIn || !user)) {
      redirectToGithub();
      return;
    }
    const requiredCoins = generationCoins(selectedModels.image_tinchak, {
      resolution: outputResolution,
      durationSeconds,
      generateAudio,
    });
    if (!LOCAL_TEST_MODE && user && !hasEnoughQuota(user, requiredCoins)) {
      toast({ title: "余额不足", description: "请先充值再继续做图", variant: "destructive" });
      return;
    }
    const finalPrompt = enhancePrompt(rawPrompt, stylePreset);
    setProgressStartedAt(Date.now());
    setProgressDurationMs(etaDurationForModel(selectedModels.image_tinchak));
    setShowProgress(true);
    await startGeneration(finalPrompt, ["image_tinchak"], { image_tinchak: selectedModels.image_tinchak }, {
      referenceImages,
      qualityMode: outputResolution === "1k" ? "fast" : "quality",
      aspectRatio,
      outputResolution,
      durationSeconds,
      generateAudio,
    });
    // 送出即下滚到生图结果栏：手机端结果在卡片下方，不滚就等于「按了没反应」。
    // 桌面 xl 双栏结果本就在视野内，scrollIntoView 对已可见元素是 no-op。
    document.getElementById("generation-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!LOCAL_TEST_MODE) {
      refresh().catch(() => {});
    }
  }, [isLoggedIn, user, stylePreset, selectedModels, outputResolution, durationSeconds, generateAudio, aspectRatio, startGeneration, toast, refresh, referenceImages, redirectToGithub]);

  const usedFallback = images.some((image) =>
    image.endpointLabel === "fallback" && (image.image || image.imageUrl),
  );
  const hasGeneratedImage = images.some((image) => image.image || image.imageUrl || image.videoUrl);

  useEffect(() => {
    if (usedFallback) setProgressDurationMs(FALLBACK_PROGRESS_DURATION_MS);
  }, [usedFallback]);

  // 離頁再回來時本地沒有進度條狀態，但 hook 恢復了 server 端還在跑的任務（isLoading=true）：
  // 補喚進度條，避免「回來進度消失」；完成時由上方 effect 依 isLoading=false 收起並揭曉結果。
  useEffect(() => {
    if (!isLoading || showProgress || failedProviders.length > 0) return;
    if (hasGeneratedImage) return;
    setShowProgress(true);
    setProgressStartedAt(Date.now());
  }, [failedProviders.length, hasGeneratedImage, isLoading, showProgress]);

  useEffect(() => {
    if (failedProviders.length > 0 || hasGeneratedImage) {
      setShowProgress(false);
      return;
    }
    if (!showProgress || !progressStartedAt || isLoading) return;
    const elapsed = Date.now() - progressStartedAt;
    const remaining = Math.max(0, progressDurationMs - elapsed);
    const timer = window.setTimeout(() => setShowProgress(false), remaining + 450);
    return () => window.clearTimeout(timer);
  }, [failedProviders.length, hasGeneratedImage, isLoading, progressDurationMs, progressStartedAt, showProgress]);

  const revealGeneratedResult = !showProgress;
  const resultView = useMemo(() => {
    const key: ProviderKey = "image_tinchak";
    const imageItem = images.find((img) => img.provider === key);
    // agent 模式只產圖片（kotone-bridge 回傳的是靜態圖）。右側空態與展示都
    // 該按圖片走，不能繼承普通模式的影片模型選擇——否则右側空態显示
    // 「视频会出现在这里」，与「生成图片」的请求自相矛盾。
    const mediaTypeOverride = displayMode === "agent" ? "image" : undefined;
    return {
      image: revealGeneratedResult ? imageItem?.image : null,
      imageUrl: revealGeneratedResult ? (pixaiResultUrl ?? imageItem?.imageUrl) : null,
      videoUrl: revealGeneratedResult ? imageItem?.videoUrl : null,
      mediaType:
        mediaTypeOverride ??
        imageItem?.mediaType ??
        generationModel(imageItem?.modelId ?? selectedModels[key])?.kind ??
        "image",
      modelId: imageItem?.modelId ?? selectedModels[key],
      timing: showProgress
        ? { startTime: progressStartedAt ?? Date.now(), durationMs: progressDurationMs }
        : timings[key],
      failed: revealGeneratedResult && failedProviders.includes(key),
    };
  }, [images, selectedModels, revealGeneratedResult, showProgress, progressStartedAt, progressDurationMs, timings, failedProviders, pixaiResultUrl, displayMode]);

  const renderState = isLoading
    ? "处理中"
    : failedProviders.length > 0
      ? "需要重试"
      : images.some((i) => i.image || i.imageUrl || i.videoUrl)
        ? "已完成"
        : "当前可用";

  // 人工终止：取最新一个未完成任务作为取消目标（hook 的 tasks 按
  // createdAt 降序，mergeGenerationTaskProjections 已排序）。
  const activeTask = tasks.find((task) => task.status === "queued" || task.status === "running") ?? null;
  const handleCancelGenerate = activeTask
    ? () => { void cancelTask(activeTask.taskId); }
    : undefined;

  return (
    <>
      {/* 這一層不參與模式轉場：dust 動畫的範圍只有卡片中間那塊控制區
          （在 PromptInput 裡）。上一版讓整頁跟著翻面，等於為了開個聊天區
          把首頁整塊換掉——使用者要的是卡片換一面，不是換個網站。 */}
      {/* F6 應用式滿屏（2026-09-10）：≥xl 兩欄態走「Navbar 自然高 → main flex-1 →
          本層 flex-1 → page-shell flex-1 → grid flex-1 → 結果欄吃滿」的高度鏈，
          視口高於內容時右欄結果卡撐滿到視口底，不再出現下方大面積空白。
          <xl（含手機）維持文檔流：min-h-screen + 自然高滾動。
          pb 收斂 28/32→16：底部只需為 fixed bottom-4 的浮動 toast 條留安全空間。 */}
      <div className="min-h-screen bg-transparent pb-16 pt-10 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="page-shell xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
              <div className={inCanvasWorkstation ? "block" : "grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]"}>
                {/* min-w-0 is load-bearing: an auto-sized grid column takes its
                    minimum from the item's min-content, so a single nowrap
                    control inside the card would widen the column past the
                    viewport and push the whole page sideways on phones.
                    畫布工作站的殼（inline style + 全場畫布 overlay + 面板殼/拖寬
                    手柄）抽到 canvas-workstation/CanvasChatWorkstation；inCanvas
                    Workstation 仍在這裡派生並經 props 下發。面板內容（D-12 撤銷條
                    + PromptInput）經 children 原地注入——聊天卡 DOM 不搬家，SSE
                    會話與輸入狀態零丟失；chatHeaderExtra（收合按鈕）由面板兩態
                    決定，經 render prop 回傳接線。
                    F6（2026-09-10）：這層 wrapper 是左欄真正的 grid item——≥xl 撐滿
                    row 高（stretch）且內容超出時自身滾動，不撐破視口；內容不足時
                    內部卡保持自然高不拉伸。工作站態面板是 fixed 定位，不吃此層。 */}
                <div className={cn("min-w-0 xl:min-h-0 xl:overflow-y-auto", !inCanvasWorkstation && "playground-column-fill")}>
                <CanvasChatWorkstation
                  inCanvasWorkstation={inCanvasWorkstation}
                  isLoading={isLoading}
                  canvasHost={canvasHost}
                  {...(showAgentTemplateGallery ? { overlayContent: <AgentTemplateCarousel templates={AGENT_TEMPLATES} onUseTemplate={handleUseAgentTemplate} /> } : {})}
                >
                  {(chatHeaderExtra) => (
                    <>
                  {/* 罪状 7（暴君人肉评测）：聊天框顶栏的「AI 助理改了 N 项设置 /
                      模型 / 恢复我的设定」撤销条整块删除（非隐藏）——控件上已是现值，
                      再画一遍被动过什么只是噪音；D-12 的参数回流本身（模型/比例/
                      解析度真正被改掉）仍然生效，撤的只是这条提示栏。 */}
                  <PromptInput
                    onSubmit={handlePromptSubmit}
                    isLoading={isLoading}
                    onCancelGenerate={handleCancelGenerate}
                    isLoggedIn={LOCAL_TEST_MODE ? true : isLoggedIn}
                    suggestions={initialSuggestions}
                    stylePreset={stylePreset}
                    onStyleChange={setStylePreset}
                    aspectRatio={aspectRatio}
                    onAspectRatioChange={userSetAspectRatio}
                    outputResolution={outputResolution}
                    onOutputResolutionChange={userSetOutputResolution}
                    durationSeconds={durationSeconds}
                    onDurationChange={setDurationSeconds}
                    generateAudio={generateAudio}
                    onGenerateAudioChange={setGenerateAudio}
                    referenceImages={referenceImages}
                    onReferenceImagesChange={setReferenceImages}
                    models={PROVIDERS.image_tinchak.models}
                    modelId={selectedModels.image_tinchak}
                    onModelChange={userSetModel}
                    mode={mode}
                    onModeChange={handleModeChange}
                    animState={animState}
                    displayMode={displayMode}
                    /* 工作站面板態本來就吃滿；首頁 ≥xl 也吃滿（跟隨右側結果欄） */
                    fillAvailableHeight={inCanvasWorkstation || !isBelowXl}
                    /* 收合面板按鈕併入聊天 header——面板頂欄已刪，觸發前後
                       同一個 header 同一套操作（2026-08-22 統一裁定）。按鈕本體
                       在 CanvasChatWorkstation（面板兩態是它的私有狀態），經
                       render prop 回傳到這裡接線。 */
                    chatHeaderExtra={chatHeaderExtra}
                    onEditResult={setPixaiResultUrl}
                    onUpscaleResult={setPixaiResultUrl}
                    onParamsReflected={handleParamsReflected}
                    onImageResult={setPixaiResultUrl}
                    agentSeed={agentSeed}
                    initialAgentSessionId={initialAgentSessionId}
                    onCanvasEvent={handleCanvasEvent}
                    canvasStateProvider={handleCanvasSummary}
                    onSessionChange={handleAgentSessionChange}
                    switchSessionRef={switchSessionRef}
                    startNewSessionRef={startNewSessionRef}
                    agentInjection={agentTemplateInjection}
                    prefillRequest={composerPrefill}
                    onUserMessage={() => setAgentTemplateDismissed(true)}
                    onSendBlockedByAuth={handleSendBlockedByAuth}
                  />
                    </>
                  )}
                </CanvasChatWorkstation>
                </div>

                {/* Result canvas only — the picker moved onto the left rail, so
                    this column no longer needs an identity header or a status
                    badge duplicating the one ImageDisplay already draws.
                    畫布工作站態：整欄隱藏（畫布已是全場主角）。
                    F6：xl:min-h-0 打通 grid row → #generation-result → ImageDisplay
                    的 xl:h-full 高度鏈（ImageDisplay 自帶 xl:min-h-[30rem] 地板）。 */}
                <div id="generation-result" className={cn("flex min-w-0 flex-col xl:min-h-0", inCanvasWorkstation && "hidden")}>
                  <ImageDisplay
                    modelId={resultView.modelId}
                    provider="image_tinchak"
                    image={resultView.image}
                    imageUrl={resultView.imageUrl}
                    videoUrl={resultView.videoUrl}
                    mediaType={resultView.mediaType}
                    timing={resultView.timing}
                    failed={resultView.failed}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 場景指南及以下为 SEO 内容：保留 DOM，但视觉隐藏。 */}
          <div className="hidden" aria-hidden="true">
            <UseCaseLinks />
            <FaqSection />
          </div>

      {pwaHandoffUrl && (
        <PwaHandoffPanel
          loginUrl={pwaHandoffUrl}
          onSuccess={() => {
            setPwaHandoffUrl(null);
            refresh().catch(() => {});
          }}
          onClose={() => setPwaHandoffUrl(null)}
        />
      )}

      {/* 未登入新訪客的進站宣傳片：z-[120] 在 navbar(z-80) 與既有 portal 彈層(z-90) 之上，
          浮層開著時底下的首頁仍完整掛載——收尾的「开始试玩」要當場把話預填進輸入框，
          整頁跳轉會把那個輸入框連同畫布一起重建。 */}
      {promoOpen && (
        <PromoIntroOverlay
          onTrial={handlePromoTrial}
          onDismiss={handlePromoDismiss}
          needsLogin={!isLoggedIn}
          onLoginDismiss={handlePromoLoginDismiss}
        />
      )}

      {/* 新人禮首登彈窗（已發放、未展示才彈）。標題/正文/幣數全部來自服務端，
          這裡不寫死任何數字；與宣傳片浮層同層級（z-[95] 的 portal）。 */}
      {welcomeGiftOpen && welcomeGift && welcomeGift.title && welcomeGift.body && (
        <WelcomeGiftDialog
          open
          title={welcomeGift.title}
          body={welcomeGift.body}
          onStart={handleWelcomeGiftStart}
          onLater={handleWelcomeGiftSeen}
        />
      )}

      {(!showProgress && (isLoading || failedProviders.length > 0)) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 sm:bottom-6">
          <div className="pointer-events-auto lg-bar flex items-center gap-3 rounded-ios-4xl px-5 py-2.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isLoading ? "bg-[#34C759] animate-pulse" : "bg-[#FF3B30]",
              )}
            />
            <span className="text-ios-footnote text-[rgba(0,0,0,0.58)]">{renderState}</span>
          </div>
        </div>
      )}

    </>
  );
}
