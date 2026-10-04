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
import { ToastAction } from "@/components/ui/toast";
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
// 2026-09-12 首屏减重拆分：AGENT_TEMPLATES 只含卡面显示 metadata；
// 执行 payload（initialPrompt/directive/slots/步骤文案）在 agent-templates-payload.ts，
// 由 handleUseAgentTemplate 在使用处 await import() 动态载入（见下方回调）。
// AgentTemplateFull 为纯型别 import（编译期擦除，不拉 payload 进 bundle）。
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import type { AgentTemplateFull } from "@/lib/agent-templates-payload";
import { fetchAgentCanvasSnapshot } from "@/lib/canvas/client";
import { useAgentParamReflect } from "@/hooks/use-agent-param-reflect";

// 2026-08-27 专业工作站入口移除：AI 工作站（agent 模式）已吸收其独有机制
// （LoRA 库 / 配方模板 / kunpeng 风格库），旧工作站不再被动态 import。

// AGENT_PARAM_LABELS（D-12 撤销条项目名）留在 hooks/use-agent-param-reflect.ts；
// 撤销条 UI 已随罪状 7 删除，钩子里的三态标记仍服务参数回流。

// 聊天区的懒加载 import 在 PromptInput 里：聊天区是那张卡片的一个面，
// 由持有 toggle 的组件自己按需拉 chunk，这里不再需要它。

/** 卡片的四个面。第四个面 agent 与 edit / upscale 同级，见 PromptInput。 */
type PlaygroundMode = PromptInputMode;

export function ImagePlayground({ suggestions }: { suggestions: Suggestion[] }) {
  // 订阅定价覆写：管理员改价后本页报价立即重算。
  usePricingRevision();
  // D-1 + D-24 状态B：agent 是卡片的第四个面，和 edit / upscale 同一层级的 toggle。
  // 按下去只换卡片中间那块控件区（共用 generate/edit/upscale 那套 dust 转场），
  // 卡片底板、右边结果画布、底下案例区全部原地不动，也不跳 /agent 独立页。
  //
  // 2026-09-22 暴君裁定：**首屏初始面翻成 AI 助理**，直接生图降为同级第二面
  // （不删除、toggle 语义一行不动）。理由是首屏决定产品定位——进站第一眼看见
  // 的是参数框＋输入框＋输出框，就会被判定成生图中转站；新范式若锁在「先点
  // 助理再发话」两步之后，每一步都不是使用者已知的。深度连结（?agent=1）的
  // setMode("agent") 因此常态成为幂等，但那段仍需处理 q / session 注入。
  const [mode, setMode] = useState<PlaygroundMode>("agent");
  const [displayMode, setDisplayMode] = useState<PlaygroundMode>("agent");
  const [animState, setAnimState] = useState<"idle" | "exit" | "enter">("idle");
  // 别的页面（D-18 图库卡）用 ?agent=1&q= 交接过来的一句话。
  const [agentSeed, setAgentSeed] = useState("");
  // 2026-08-25 模板库：点卡注入 pending（nonce 让「换一张卡」也是新注入）。
  // directive 是隐形引导词：随首条讯息经网关 system 栏位注入，用户全程不可见。
  const [agentTemplateInjection, setAgentTemplateInjection] = useState<{ text: string; nonce: number; directive?: string; echo?: boolean } | null>(null);
  // C4 生成闭环事件桥：导演台视口「生成真实画面」完成 capture+上传后 dispatch
  // director-render-request → 与模板库共用同一注入 setter（AgentChatSurface 的
  // injection effect 收到即静默发送，send() 无会话时 lazy 建号＋连线）。卸载时移除监听。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      if (!detail || typeof detail.text !== "string" || !detail.text.trim()) return;
      setAgentTemplateInjection({ text: detail.text, nonce: Date.now() });
    };
    window.addEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
    return () => window.removeEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
  }, []);
  // 模板库退场旗标：发出第一条用户消息（模板注入或手打）即收起，之后不再出现。
  const [agentTemplateDismissed, setAgentTemplateDismissed] = useState(false);
  // PWA 登录交接面板（standalone 内 GitHub 授权走跨浏览器 handoff）。
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);
  // wish 插件深链（?agent=1&session=<uuid>）：落地后直开该会话而非新开对话。
  const [initialAgentSessionId, setInitialAgentSessionId] = useState("");
  /**
   * 未登入新访客的进站宣传片（2026-09-27 暴君裁定落地）。
   *
   * 频率：每浏览器一次（PROMO_SEEN_KEY）——新机／新浏览器给完整震撼，回访的
   * 未登入用户不再被反覆挡在门外。判定链是纯函式（promo-gate.ts），这里只负责
   * 读储存、开浮层、以及收尾那句「一送出就开新对话直送产线」。
   *
   * 为什么挂在这页而不是 layout：收尾要当场开新对话并把那句话送进聊天区，
   * 那条通路（startNewSessionRef ＋ agentTemplateInjection）只在这棵树上——
   * 挂 layout 就只能整页跳转，等于把画布与聊天区整个重建一次。
   */
  const [promoOpen, setPromoOpen] = useState(false);
  // 未登入时送不出去的那句话：存起来，登入态翻真就自动补送（见 promo-gate.ts）。
  const promoPendingRef = useRef<string | null>(null);
  // 本次载入已替使用者补送过那句话（登入后）：新人礼弹窗让路，别盖住刚开的会话。
  const pendingTrialSentRef = useRef(false);
  const { images, timings, failedProviders, isLoading, startGeneration, cancelTask, tasks } = useImageGeneration();
  // authLoading 必须与上面 useImageGeneration 的 isLoading 区分开：
  // 那是生图忙碌态，不是登入态——拿它当水合判断，等于对状态不明的用户插播。
  // 注：措辞避开「生＋成＋中」那三字连写，ImageDisplay.test 以它在四档的
  // 出现次数＝1 当契约，这里多一次会让它误红。
  const { user, token, isLoggedIn, refresh, isLoading: authLoading, welcomeGift, clearWelcomeGift } = useAuth();
  const { toast } = useToast();
  // 新人礼首登弹窗的开启态（每设备只弹一次的辅助闸门见 welcomeGiftModalSeenLocally）。
  const [welcomeGiftOpen, setWelcomeGiftOpen] = useState(false);
  // 弹窗主按钮的「预填但不送出」通路：走 AgentChatSurface 既有的 prefillRequest
  // （输入框有字、光标在末尾、焦点在框上，人再按送出），不是新机制。
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
  // v3 embed：右侧结果面板 mode。2026-08-25 canvas 常驻化：agent 模式右侧
  // 一进入就是 canvas（模板库或画布），不再有「AI 助理左边、图片结果右边」
  // 的中间态。非 agent 模式（generate/edit/upscale）维持 ImageDisplay。
  // 画布工作站（2026-08-16，暴君裁定「挤」）：画布模式 = 全场画布，聊天卡
  // 变成左侧浮动面板，expanded|rail 两态 + 右缘拖宽，localStorage 记忆。
  // 辽阔是预设，不是奖励——不再有「compact 嵌右栏」这种把画布塞缝里的状态。
  // 面板两态/宽度/拖宽与 localStorage 持久化抽到 canvas-workstation/use-chat-panel。
  // 单一 SSE：AgentChatSurface 自建 useAgentChat，其 onCanvasEvent 出口喂回画布。
  // 用 ref 解开循环依赖：onCanvasEvent 转交 canvasHostRef；canvasHost 后建，喂回 ref。
  const canvasHostRef = useRef<UseCanvasChatReturn | null>(null);
  const handleCanvasEvent = useCallback((event: AgentSseEvent) => {
    // 画布资料管线只吃 canvas 结构事件，tool.invoke 不入 reducer
    // （模式切换已不需要：canvas 常驻化后 agent 模式右侧恒为 canvas）。
    if (event.name === "tool.invoke") {
      return;
    }
    canvasHostRef.current?.feedCanvasEvent(event);
  }, []);
  const handleCanvasSummary = useCallback(() => canvasHostRef.current?.summarize(), []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // Bug1a：模板库退场旗标随「进入新对话」复位。session id 变了 = 开新聊天 =
  // 画布已被清空，模板库必须再次出现（「开启新聊天就代表 Canvas 进入模板展示态」）；
  // 续上同一会话（toggle 往返 / 刷新 resume）不复位 —— 那是继续对话，不是新开始。
  // ref 记住上一个非空 id：卸载-重挂时的 onSessionChange(null) 中间态不许把
  // 锚点洗掉，否则同会话 resume 也会被误判成「新对话」而重播模板库。
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

  // 双向同步方向A：画布选中 workflow 节点 → chat 切到该节点所属会话。
  // switchSessionRef 由 AgentChatSurface 上抛（画布 → chat 方向唯一入口）；
  // 节点不带 session_id（普通生成/提示卡）不切，避免误切。
  // 反馈闭环靠 currentSessionId 兜底：切完后 selectedNodeId 对应节点的
  // session_id === currentSessionId，相等判断挡住死循环。
  const switchSessionRef = useRef<((sessionId: string) => Promise<boolean>) | null>(null);
  // 暴君裁定 2026-09-01：套模板「留旧开新」——AgentChatSurface 上抛 startNewSession。
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

  // 模板库只在「画布空且无对话」的初始态出现：有任何节点/计画（模板铺过、
  // agent 建过、或历史专案恢复）或已发过消息（agentTemplateDismissed）就让位。
  const showAgentTemplateGallery =
    displayMode === "agent" &&
    !agentTemplateDismissed &&
    canvasHost.nodes.length === 0 &&
    canvasHost.plans.length === 0;

  /**
   * 2026-08-25 模板卡点击（卡即动作）：
   * ① initialPrompt 经既有 useAgentChat 链路自动发出（PromptInput →
   *    AgentChatSurface 的 agentInjection：09-12 起注入到了就 send，
   *    send() 无会话时 lazy 建号＋连线，不再等 autoStart/连线 open）。
   * ② 模板 slots 经 recipeTemplateToRecallConfig → templateToCanvasLayout
   *    → useCanvasChat.replaceWorkflowNodes 铺成 workflow，等 agent 修改。
   * ③ 首条消息落地即收起画廊（onUserMessage）。
   * 2026-08-26 环节选择：第二参 selectedIndices 来自卡面圆环，先 cropTemplate
   *    裁剪（全选 = 原对象零开销），注入与铺画布都用裁剪后的模板。
   * 09-01 裁定「留旧开新」+ 09-12 建号权收归发送按钮：startNewSession 只清空
   *    回空态（不建号、无 session transition），结算即铺即注入；注入的首条
   *    消息 lazy 建新会话承接，画布摘要随该消息上行。
   */
  // Bug3：同一 workflow 重点 = 替换不是叠加。cropTemplate 裁剪后 template.id 不变，
  // 重选环节再点同一张卡 = 同 id 替换：旧节点及其连线一次清掉，history 一格可整体 undo。
  const applyPendingTemplate = useCallback((cropped: AgentTemplateFull) => {
    const layout = templateToCanvasLayout(cropped);
    canvasHostRef.current?.replaceWorkflowNodes(cropped.id, layout.nodes, layout.connections);
    setAgentTemplateInjection({ text: cropped.initialPrompt, nonce: Date.now(), directive: cropped.directive });
    setAgentTemplateDismissed(true);
  }, []);
  const handleUseAgentTemplate = useCallback((card: AgentTemplate, selectedIndices: number[]) => {
    // 2026-09-12 首屏减重：执行 payload 点卡才动态载入（chunk 进快取，之后零开销）；
    // 载入失败（离线等）不收起画廊，模板不会凭空消失，可重试。
    void (async () => {
      const { hydrateAgentTemplate, cropTemplate } = await import("@/lib/agent-templates-payload");
      const template = hydrateAgentTemplate(card);
      const cropped = cropTemplate(template, selectedIndices);
      setAgentTemplateDismissed(true);
      const start = startNewSessionRef.current;
      if (!start) {
        // ref 未接上（极端时序）：退回旧行为直接铺在当前会话，模板不能凭空消失。
        applyPendingTemplate(cropped);
        return;
      }
      // 开新＝清空回空态是同步语义（仅在建号管线在飞时等一下），结算即铺；
      // ok=false（auth/closed 封锁开新）同样直接铺在当前会话——模板不能凭空消失。
      void Promise.resolve(start()).then(() => applyPendingTemplate(cropped));
    })().catch((error) => {
      console.error("[agent-templates] 执行 payload 载入失败", error);
      setAgentTemplateDismissed(false);
    });
  }, [applyPendingTemplate]);

  // Bug1b：会话恢复回填。refresh/重进后左聊天续上（本地存档 resume），但右画布
  // 空白 —— 快照此前只有上行没有下行。监听 currentSessionId：每个新拿到的 sid 拉
  // 一次闸道存档（GET 同上行端点），仅当 nodes>0 才回填；拉取异步到达时 sessionId
  // 变化 effect（newCanvasSession 清场）已跑完，load 直接覆盖即可。用户抢先铺过
  // 模板（或有计画卡）就不覆盖，避免快照把刚做好的东西冲掉。
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

  // 进度条 ETA：服务端已按模型统计成功生成的耗时 p80（/api/user/model-eta，
  // 数据源 = generation_attempt.latency_ms 遥测）。挂载时拉一次；读不到
  // （遥测不可用/样本不足）就沿用固定 duration。ETA 不显示，只调进度流逝。
  const [modelEtaMs, setModelEtaMs] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/model-eta")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { models?: Record<string, number> } | null) => {
        if (!cancelled && payload?.models) setModelEtaMs(payload.models);
      })
      .catch(() => {
        // ETA 是加分项：拉不到就静默用固定 duration。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const etaDurationForModel = useCallback(
    (modelId: string): number => modelEtaMs[modelId] ?? NORMAL_PROGRESS_DURATION_MS,
    [modelEtaMs],
  );

  // 2026-08-25 canvas 常驻化：右侧面板 mode 由 displayMode 唯一决定——agent 模式
  // 恒为 canvas（模板库→画布），非 agent 模式恒为 ImageDisplay。原黏性旗标/
  // workflow_start 切换/节点数回退等中间态逻辑全部收敛删除。
  const inCanvasWorkstation = displayMode === "agent";
  // 首页输入栏高度自适应（2026-09-11）：结果栏 ImageDisplay 一直吃满栏高，输入卡
  // 过去由内容高决定、下方留一片空白。≥xl（Tailwind xl = 1280px，与 globals.css 的
  // .playground-column-fill 同一断点）把卡片交给 flex 链吃满栏高，跟随结果栏；
  // <xl 维持文档流自然高（useIsNarrow 首帧回 false＝宽屏，与 CSS 的 mobile-first
  // 方向一致，不会出现 CSS/JS 断点错位）。
  const isBelowXl = useIsNarrow("(max-width: 1279.98px)");
  // ─── 画布工作站：画布模式锁页面卷动（面板记忆载入/持久化在 use-chat-panel）───
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
   * 进站判定：登入态水合完成后才判——水合中（authLoading）是「还不知道」，
   * 对还不知道的用户插播等于对已登入用户插播。读一次 localStorage，
   * 看过就不再开；深链交接（?agent=1&q=/?session=）让路、渠道来访（B 站／微信，
   * 人是被宣传片吸引来的）也让路，判准全在 promo-gate.ts。
   *
   * 频率：**每页载入只判一次**（resolvePromoEntry）。这条 effect 依赖登入态，
   * 但登入态翻面不等于重新进站——2026-09-27 暴君实锤：登入中的用户按登出，
   * isLoggedIn 由真翻假，若重判就会把 `?promo=1` 的强制预览又播一次（见
   * promo-gate.ts 的 resolvePromoEntry 注释）。定案后一律沿用首次结果。
   *
   * 渠道来访只是「这次不开浮层」，不写「已看过」：他下次直接进站（无 Referer）
   * 仍会被影片接住，首次进站的震撼不会被渠道那一次的判断吃掉。
   */
  const promoEntryRef = useRef<PromoEntryDecision>(PROMO_ENTRY_UNDECIDED);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (promoEntryRef.current.decided) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(PROMO_SEEN_KEY) === "1";
    } catch {
      // 私密模式／停用储存：读不到就当没看过（本次照播），不因此炸掉首页。
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
   * 浮层收尾（2026-09-27 暴君第二轮：「还不如把封面做成结尾界面，输入框变成
   * 真的能输入，用户一发送马上开新对话」）：不再只是预填，而是当场开新对话把那句
   * 送进聊天区——送出去的动作就是人按的那一下，D-5／D-24 的语义不受影响。
   *
   * 强制预览（?promo=1）不写「已看过」：验收看过一次不等于这个浏览器已经
   * 消耗掉真正的首次进站体验。
   */
  const markPromoSeen = useCallback(() => {
    if (isForcedPreview(window.location.search)) return;
    try {
      window.localStorage.setItem(PROMO_SEEN_KEY, "1");
    } catch {
      // 存不了就算了：不挡这次的动作，最坏情况是下次再播一遍。
    }
  }, []);

  /**
   * 留旧开新＋直送。与模板卡同一条路（startNewSessionRef → 注入即送），
   * 但这条要 echo：那句话是使用者自己打的，必须出现在他自己的聊天记录里
   * ——不 echo 的话，送出后到第一个字回来之前画面完全是空的（2026-09-27 暴君）。
   */
  const runPromoTrial = useCallback((text: string) => {
    const trimmed = text.trim() || PROMO_TRIAL_PROMPT;
    const inject = (): void =>
      setAgentTemplateInjection({ text: trimmed, nonce: Date.now(), echo: true });
    const start = startNewSessionRef.current;
    if (!start) {
      // ref 未接上（极端时序）：退回直接送在当前会话，不能把这句话吃掉。
      inject();
      return;
    }
    void Promise.resolve(start()).then(inject);
  }, []);

  /**
   * 收尾送出的那句话（2026-09-27 暴君第三轮）：登入态决定「当场开跑」还是
   * 「先弹登入窗再开跑」，分流是纯函式（resolvePromoTrialIntent）。
   *
   * 未登入那条不是丢掉：那句话先写进 ref ＋ sessionStorage，登入态一翻真就补送。
   * 两型登入都吃这条——微信弹窗是原地完成（ref 还在），GitHub 同窗口跳转回来
   * 时元件已重挂（ref 没了，靠 sessionStorage 那一份接住）。
   * 使用者主动按了送出＝这部片对他是有效的，所以无论走哪条都先记「看过」。
   */
  const handlePromoTrial = useCallback(
    (text: string) => {
      markPromoSeen();
      const intent = resolvePromoTrialIntent(text, isLoggedIn);
      if (intent.kind === "login") {
        // 那句话先留住；登入小框由浮层自己长（在送出钮正上方），不遮盖结尾画面。
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
   * 收尾的退路（跳过 / Esc / 先逛逛）：只关浮层，不送话。
   * 顺手清掉待送的那句——使用者在登入窗前选了「先不登入」并离开，
   * 之后某次无关的登入不该突然把这句话送出去（那不是他要的）。
   */
  const handlePromoDismiss = useCallback(() => {
    markPromoSeen();
    setPromoOpen(false);
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
  }, [markPromoSeen]);

  /**
   * 登入小框被关掉（先不登录／Esc／点封面空白处）：浮层留在原地，但那句话不再
   * 待送——他选择不登入，之后某次无关的登入不该突然把它送出去。
   */
  const handlePromoLoginDismiss = useCallback(() => {
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
  }, []);

  /**
   * 主输入区那句话被登入挡下（hook 的 onSendBlockedByAuth）→ 存进与宣传片同一格。
   *
   * 为什么要有这条：宣传片浮层已经有「pending + 登入后补送」，但站上真正的入口
   * （首页主输入区）没吃到——未登入的人在那里打字送出，那句话当场消失（composer
   * 已清空，且 GitHub 登入是同窗口整页跳转，回来元件状态全死），要重打一遍。
   * 存同一格＝下面那条「登入态翻真 → 补送」effect 原样接手，不必另造补送链。
   */
  const handleSendBlockedByAuth = useCallback((text: string) => {
    const stashed = stashBlockedSend(
      typeof window === "undefined" ? null : window.sessionStorage,
      text,
    );
    promoPendingRef.current = stashed;
  }, []);

  /**
   * 登入态翻真 → 补送那句话。
   * 读 ref 与 sessionStorage 两处：ref 覆盖同页登入（按对话区的登入钮／微信 popup），
   * sessionStorage 覆盖跳转型登入（OAuth 落地回 / 时元件已重挂、ref 早就没了）。
   *
   * 这句话有两个来源，共用同一格、走同一条补送：
   * ①宣传片收尾输入框（handlePromoTrial 的 login 分支）；
   * ②首页主输入区（handleSendBlockedByAuth：未登入送出＝hook 的 not_authenticated）。
   * 两者都是「使用者已经按下送出、只是还没登入」，所以补送就是完成他那个动作，
   * 不是替他多做一件事。
   */
  useEffect(() => {
    if (!isLoggedIn || authLoading) return;
    const pending = promoPendingRef.current
      ?? readPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
    if (!pending) return;
    promoPendingRef.current = null;
    clearPendingTrial(typeof window === "undefined" ? null : window.sessionStorage);
    pendingTrialSentRef.current = true;
    // 登入成功＝宣传片这条线走完：浮层收掉，然后真的开一个会话开跑。
    setPromoOpen(false);
    setMode("agent");
    setDisplayMode("agent");
    runPromoTrial(pending);
  }, [authLoading, isLoggedIn, runPromoTrial]);

  /**
   * 新人礼待展示 → 开弹窗。
   * 闸门权威在服务端（welcome_gift_grant.modal_seen_at，经 /api/auth/me 的加法栏位）；
   * 本机 localStorage 只挡「同一台设备已经看过」的重复弹，换设备时本机标记是空的，
   * 仍由服务端决定弹不弹。未登入／还没水合完都不弹——否则会对未登入的人插播
   * 一条「已送你 5 币」。
   */
  useEffect(() => {
    if (authLoading || !isLoggedIn || !user?.id) return;
    if (!welcomeGift?.pending) return;
    // 这次登入是为了送出那句话（宣传片结尾／首页输入框被登入挡下）：画面要留给
    // 刚开跑的真会话，新人礼弹窗不盖上去（2026-09-30）。不回执、不本机关门，
    // 服务端仍是 pending，下次进站照弹。
    if (pendingTrialSentRef.current) return;
    if (welcomeGiftModalSeenLocally(user.id)) return;
    setWelcomeGiftOpen(true);
  }, [authLoading, isLoggedIn, user?.id, welcomeGift]);

  /**
   * 展示过的回执＋本机关门。回执失败照样关窗（见 ackWelcomeGiftModalSeen 注：
   * 没写上只会让下次登入再弹一次，比把新人礼藏起来轻）。
   */
  const handleWelcomeGiftSeen = useCallback(() => {
    const userId = user?.id;
    if (userId) markWelcomeGiftModalSeenLocally(userId);
    setWelcomeGiftOpen(false);
    clearWelcomeGift();
    if (token) void ackWelcomeGiftModalSeen(token);
  }, [clearWelcomeGift, token, user?.id]);

  /**
   * 主按钮「马上生成第一张」：关窗、切到 AI 助理、把**既有示例的第一条**预填进输入框。
   * 示例句不写死——与聊天面板空态快捷 chips 共用 agent-example-prompts 这一真源。
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

  // ── D-12：助理动过的参数回流到工作台控件（三态复原抽到 use-agent-param-reflect）──
  // userSet* 系列 setter 的身分（useCallback 依赖阵列）在 hook 内原样保留：
  // PromptInput 那侧没有 memo 依赖，但工作站 onModelChange 的稳定引用设计
  // 不允许这里换身分。
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
      // 额度用完＝转化率最高的时刻：提示里直接给付款入口，不让用户自己找。
      toast({
        title: "余额不足",
        description: `这次需要 ${requiredCoins} 币，充值后马上继续`,
        variant: "destructive",
        action: (
          // 带 ?plan=first-charge：定价页据此滚到首充专享卡（有资格的人第一眼就看到 4 倍划算那档）。
          <ToastAction altText="去充值" onClick={() => { window.location.href = "/pricing?plan=first-charge"; }}>
            去充值
          </ToastAction>
        ),
      });
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
  }, [isLoggedIn, user, stylePreset, selectedModels, outputResolution, durationSeconds, generateAudio, aspectRatio, startGeneration, toast, refresh, referenceImages, redirectToGithub, etaDurationForModel]);

  const usedFallback = images.some((image) =>
    image.endpointLabel === "fallback" && (image.image || image.imageUrl),
  );
  const hasGeneratedImage = images.some((image) => image.image || image.imageUrl || image.videoUrl);

  useEffect(() => {
    if (usedFallback) setProgressDurationMs(FALLBACK_PROGRESS_DURATION_MS);
  }, [usedFallback]);

  // 离页再回来时本地没有进度条状态，但 hook 恢复了 server 端还在跑的任务（isLoading=true）：
  // 补唤进度条，避免「回来进度消失」；完成时由上方 effect 依 isLoading=false 收起并揭晓结果。
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
    // agent 模式只产图片（kotone-bridge 回传的是静态图）。右侧空态与展示都
    // 该按图片走，不能继承普通模式的影片模型选择——否则右侧空态显示
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
      {/* 这一层不参与模式转场：dust 动画的范围只有卡片中间那块控制区
          （在 PromptInput 里）。上一版让整页跟著翻面，等于为了开个聊天区
          把首页整块换掉——使用者要的是卡片换一面，不是换个网站。 */}
      {/* F6 应用式满屏（2026-09-10）：≥xl 两栏态走「Navbar 自然高 → main flex-1 →
          本层 flex-1 → page-shell flex-1 → grid flex-1 → 结果栏吃满」的高度链，
          视口高于内容时右栏结果卡撑满到视口底，不再出现下方大面积空白。
          2026-10-01：<xl（含手机）原本用 min-h-screen，但本层是 main(flex-1) 的直接
          子项，min-h-screen＝100vh 又加在 70px header 之下 ⇒ body＝100vh+header，
          手机 agent 态内容全 fixed、流内高度 0 ⇒ 多出的 header 高度成为纯空滑（且
          header 被 sticky 一起拖走）。改用 flex-1：精确吃掉「视口−header」，视觉上
          仍撑满视口；内容真的高于视口时 flex item 的自动最小高度会让它自然长高、
          整页照常滚动。
          pb 收敛 28/32→16：底部只需为 fixed bottom-4 的浮动 toast 条留安全空间。 */}
      <div className="flex-1 bg-transparent pb-16 pt-10 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="page-shell xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
              <div className={inCanvasWorkstation ? "block" : "grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]"}>
                {/* min-w-0 is load-bearing: an auto-sized grid column takes its
                    minimum from the item's min-content, so a single nowrap
                    control inside the card would widen the column past the
                    viewport and push the whole page sideways on phones.
                    画布工作站的壳（inline style + 全场画布 overlay + 面板壳/拖宽
                    手柄）抽到 canvas-workstation/CanvasChatWorkstation；inCanvas
                    Workstation 仍在这里派生并经 props 下发。面板内容（D-12 撤销条
                    + PromptInput）经 children 原地注入——聊天卡 DOM 不搬家，SSE
                    会话与输入状态零丢失；chatHeaderExtra（收合按钮）由面板两态
                    决定，经 render prop 回传接线。
                    F6（2026-09-10）：这层 wrapper 是左栏真正的 grid item——≥xl 撑满
                    row 高（stretch）且内容超出时自身滚动，不撑破视口；内容不足时
                    内部卡保持自然高不拉伸。工作站态面板是 fixed 定位，不吃此层。 */}
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
                    onNeedLogin={redirectToGithub}
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
                    /* 工作站面板态本来就吃满；首页 ≥xl 也吃满（跟随右侧结果栏） */
                    fillAvailableHeight={inCanvasWorkstation || !isBelowXl}
                    /* 收合面板按钮并入聊天 header——面板顶栏已删，触发前后
                       同一个 header 同一套操作（2026-08-22 统一裁定）。按钮本体
                       在 CanvasChatWorkstation（面板两态是它的私有状态），经
                       render prop 回传到这里接线。 */
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
                    画布工作站态：整栏隐藏（画布已是全场主角）。
                    F6：xl:min-h-0 打通 grid row → #generation-result → ImageDisplay
                    的 xl:h-full 高度链（ImageDisplay 自带 xl:min-h-[30rem] 地板）。 */}
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

          {/* 场景指南及以下为 SEO 内容：保留 DOM，但视觉隐藏。 */}
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

      {/* 未登入新访客的进站宣传片：z-[120] 在 navbar(z-80) 与既有 portal 弹层(z-90) 之上，
          浮层开著时底下的首页仍完整挂载——收尾的「开始试玩」要当场把话预填进输入框，
          整页跳转会把那个输入框连同画布一起重建。 */}
      {promoOpen && (
        <PromoIntroOverlay
          onTrial={handlePromoTrial}
          onDismiss={handlePromoDismiss}
          needsLogin={!isLoggedIn}
          onLoginDismiss={handlePromoLoginDismiss}
        />
      )}

      {/* 新人礼首登弹窗（已发放、未展示才弹）。标题/正文/币数全部来自服务端，
          这里不写死任何数字；与宣传片浮层同层级（z-[95] 的 portal）。 */}
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
