"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { authHeaders } from "@/lib/canvas/client";
import { hasReflectedParams, reflectParams } from "@/lib/agent-param-reflect";
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent-chat-client";
import { subscribeAgentSurfaceActions } from "@/lib/agent-surface-actions";
import { buildAnchorMessage, buildReanchorMessage, deriveBatchAnchor, shouldOfferBatchAnchor } from "@/lib/agent-batch-anchor";
import type { AgentAudioItem, AgentImageItem, AgentVideoItem } from "@/lib/agent-chat-types";
import type { AssetPack, AssetPackItem } from "@/lib/asset-pack-store";
import type { AgentTranscriptProps } from "@/components/agent-chat/AgentTranscript";
import { assetUrlFieldOf } from "@/lib/deliverable-kind";
import { buildChatSaveItem, CHAT_ASSETS_PACK_ID, type AgentChatLibraryItem } from "@/lib/agent-chat-asset-builders";
import {
  AGENT_MEDIA_HISTORY_MAX_ATTEMPTS,
  agentHistoryEntryForMedia,
  agentMediaItemIds,
  planAgentMediaHistoryWrites,
  saveAgentMediaToHistory,
} from "@/lib/agent-media-history";
import { imageExtensionFromUrl, stationAuthHeaders } from "@/lib/agent-image-share";
import type { HistoryEntry } from "@/lib/history-types";
import type { HistoryRerunMode } from "@/components/history/RerunDialog";
import type { NewApiUser } from "@/lib/new-api-client";
import type { ReflectedParams } from "@/lib/agent-param-reflect";
import type { AgentChatState } from "@/lib/agent-chat-types";
import type { UseAgentChatResumable } from "@/hooks/use-agent-chat";
import { triggerDownload } from "./AgentChatSurface.helpers";

interface AgentSurfaceSessionActionsProps {
  variant: "page" | "inline";
  chatHistoryUser: NewApiUser | null;
  historyOwnerRef: RefObject<number | null>;
  savedIds: Set<string>;
  setSavedIds: Dispatch<SetStateAction<Set<string>>>;
  sessionId: string | null;
  onSessionChange?: (sessionId: string | null) => void;
  switchSession: (sessionId: string) => Promise<boolean>;
  switchSessionRef?: RefObject<((sessionId: string) => Promise<boolean>) | null>;
  startNewSession: () => Promise<boolean>;
  startNewSessionRef?: RefObject<(() => Promise<boolean>) | null>;
  state: AgentChatState;
  onParamsReflected?: (params: ReflectedParams) => void;
  currentModelId?: string;
  onImageResult?: (url: string) => void;
  connection: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  setPrefill: Dispatch<SetStateAction<{ text: string; nonce: number } | null>>;
  prefillRequest?: { text: string; nonce: number } | null;
  resumable: UseAgentChatResumable | null;
  initialSessionId?: string;
  agentInjection?: { text: string; nonce: number; directive?: string; echo?: boolean } | null;
  onUserMessage?: () => void;
  send: (text: string, opts?: { sessionDirective?: string; silent?: boolean }) => Promise<void>;
  anchorAskedFor: string | null;
  setAnchorAskedFor: Dispatch<SetStateAction<string | null>>;
  anchorBusy: boolean;
  setAnchorBusy: Dispatch<SetStateAction<boolean>>;
  abort: () => Promise<void>;
  setRerunDialog: Dispatch<SetStateAction<{ entry: HistoryEntry; mode: HistoryRerunMode } | null>>;
  assetPacks: AssetPack[] | null;
  setAssetCache: Dispatch<SetStateAction<{ ownerId: number; packs: AssetPack[] } | null>>;
  setActivatingPackId: Dispatch<SetStateAction<string | null>>;
  setAssetQuery: Dispatch<SetStateAction<string>>;
  showAssets: boolean;
  setShowAssets: Dispatch<SetStateAction<boolean>>;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  switchingTo: string | null;
  setSwitchingTo: Dispatch<SetStateAction<string | null>>;
  startingNew: boolean;
  setStartingNew: Dispatch<SetStateAction<boolean>>;
  setHistoryCache: Dispatch<SetStateAction<{ ownerId: number; items: AgentSessionSummary[] } | null>>;
  setHistoryError: Dispatch<SetStateAction<{ ownerId: number; message: string } | null>>;
  setHistorySnapshot: Dispatch<SetStateAction<{ itemCount: number; savedAt: number } | null>>;
  historyList: AgentSessionSummary[] | null;
  assetQuery: string;
  debouncedAssetQuery: string;
  activatingPackId: string | null;
  openSettings: () => void;
  onExit?: () => void;
}

export function useAgentSurfaceSessionActions(P: AgentSurfaceSessionActionsProps): {
  prefetchAssets: () => void;
  toggleAssets: () => Promise<void>;
  onActivatePack: (pack: AssetPack) => Promise<void>;
  prefetchHistory: () => void;
  toggleHistory: () => Promise<void>;
  onPickSession: (targetSessionId: string) => Promise<void>;
  onStartNewSession: () => Promise<void>;
  isActive: boolean;
  isInline: boolean;
  onSaveToLibrary: (item: AgentChatLibraryItem) => Promise<boolean>;
  attachFilesRef: RefObject<((files: File[]) => void) | null>;
  onEdit: (item: AgentImageItem) => Promise<boolean>;
  onDownload: (item: AgentImageItem) => Promise<boolean>;
  onVideoDownload: (item: AgentVideoItem) => Promise<boolean>;
  onAudioDownload: (item: AgentAudioItem) => Promise<boolean>;
  continueDraft: () => void;
  clearPrefill: () => void;
  anchor: ReturnType<typeof deriveBatchAnchor>;
  onAnchor: () => Promise<void>;
  onReanchor: () => Promise<void>;
  onAnchorDismiss: () => void;
  onStopGeneration: () => void;
  imageActions: AgentTranscriptProps["imageActions"];
  videoActions: AgentTranscriptProps["videoActions"];
  audioActions: AgentTranscriptProps["audioActions"];
} {
  const lastAssetQueryRef = useRef<string | null>(null);
  useEffect(() => {
    lastAssetQueryRef.current = null;
    P.setAssetCache(null);
    P.setSavedIds(new Set());
    P.setAssetQuery("");
    P.setActivatingPackId(null);
    P.setShowAssets(false);
  }, [P.chatHistoryUser?.id]);

  /** 拉取资产包列表；q 非空时走 ?q= 服务端搜索，空字串还原为全量。同 query 去重。 */
  const loadAssets = useCallback(async (q: string): Promise<void> => {
    const query = q.trim();
    const ownerId = P.chatHistoryUser?.id;
    const headers = authHeaders();
    if (ownerId == null || !headers || headers["x-user-id"] !== String(ownerId)) return;
    const queryKey = `${ownerId}:${query}`;
    if (queryKey === lastAssetQueryRef.current) return;
    lastAssetQueryRef.current = queryKey;
    try {
      const url = query ? `/api/assets?q=${encodeURIComponent(query)}` : "/api/assets";
      const res = await fetch(url, { headers, cache: "no-store" });
      if (P.historyOwnerRef.current !== ownerId || lastAssetQueryRef.current !== queryKey) return;
      if (!res.ok) {
        lastAssetQueryRef.current = null; // 失败要能重拉，不能被去重挡死
        return;
      }
      const data = (await res.json()) as { packs?: AssetPack[] };
      if (P.historyOwnerRef.current === ownerId && lastAssetQueryRef.current === queryKey && Array.isArray(data?.packs)) {
        P.setAssetCache({ ownerId, packs: data.packs });
      }
    } catch {
      // 静默失败：面板保持原状，可重试（清去重标记）。
      if (P.historyOwnerRef.current === ownerId && lastAssetQueryRef.current === queryKey) lastAssetQueryRef.current = null;
    }
  }, [P.chatHistoryUser?.id]);

  /*
   * 2026-10-01 暴君「打开反应缓慢」：悬停/聚焦顶栏图标就先拉数据，点下去时列表多半已就绪。
   * 去重交给 loadAssets 的 lastAssetQueryRef 与 historyLoadingRef，悬停多次不重复请求。
   */
  const prefetchAssets = useCallback((): void => {
    if (P.assetPacks === null) void loadAssets("");
  }, [P.assetPacks, loadAssets]);

  /** 我的资产：开关。首次打开拉全量；搜索词变化由下方 effect 重新拉取。 */
  const toggleAssets = useCallback(async (): Promise<void> => {
    P.setShowAssets((prev) => {
      const next = !prev;
      // 2026-10-01 修：原本先把 lastAssetQueryRef 设成 "" 再 loadAssets("")——去重判定
      // 当场命中直接 return，首开永远不发请求，面板卡在「正在加载资产…」直到用户打字。
      if (next) {
        lastAssetQueryRef.current = null;
        void loadAssets(P.assetQuery);
      }
      return next;
    });
  }, [P.assetQuery, loadAssets]);

  // 搜索词（300ms debounce）变化 → 重新拉取（空字串还原为全量）。
  useEffect(() => {
    if (!P.showAssets) return;
    void loadAssets(P.debouncedAssetQuery);
  }, [P.showAssets, P.debouncedAssetQuery, loadAssets]);

  /** 使用此包：把该包 active:true 写回（store 自动清其它包 active），成功后收面板。 */
  const onActivatePack = useCallback(
    async (pack: AssetPack): Promise<void> => {
      if (P.activatingPackId !== null) return;
      const ownerId = P.chatHistoryUser?.id;
      const headers = authHeaders();
      if (ownerId == null || !headers || headers["x-user-id"] !== String(ownerId)) return;
      P.setActivatingPackId(pack.id);
      try {
        const res = await fetch("/api/assets", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ ...pack, active: true }),
        });
        if (res.ok && P.historyOwnerRef.current === ownerId) P.setShowAssets(false);
      } catch {
        // 静默失败：面板留在原地，用户可重试。
      } finally {
        if (P.historyOwnerRef.current === ownerId) P.setActivatingPackId(null);
      }
    },
    [P.activatingPackId, P.chatHistoryUser?.id],
  );

  /** dropdown 开关：第一次打开时拉取目录（之后直接切换显示，不重复请求）。 */
  const historyLoadingRef = useRef<number | null>(null);
  const prefetchHistory = useCallback((): void => {
    const ownerId = P.chatHistoryUser?.id;
    if (ownerId === undefined || P.historyList !== null || historyLoadingRef.current === ownerId) return;
    historyLoadingRef.current = ownerId;
    P.setHistoryError(null);
    void listAgentSessions()
      .then((items) => {
        if (P.historyOwnerRef.current === ownerId) P.setHistoryCache({ ownerId, items });
      })
      .catch(() => {
        if (P.historyOwnerRef.current === ownerId) P.setHistoryError({ ownerId, message: "历史加载失败，请重新打开重试。" });
      })
      .finally(() => {
        if (historyLoadingRef.current === ownerId) historyLoadingRef.current = null;
      });
  }, [P.historyList, P.chatHistoryUser?.id]);

  useEffect(() => {
    P.setHistoryCache(null);
    P.setHistoryError(null);
    P.setShowHistory(false);
    P.setSwitchingTo(null);
    P.setHistorySnapshot(null);
    historyLoadingRef.current = null;
    prefetchHistory();
    // 账号不变时保留缓存；目录由登录/切换账号触发服务端恢复。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [P.chatHistoryUser?.id]);

  const toggleHistory = useCallback(async (): Promise<void> => {
    P.setShowHistory((prev) => {
      const next = !prev;
      if (next) prefetchHistory();
      return next;
    });
  }, [prefetchHistory]);

  /** 点选某个历史会话：切过去（SSE 续传 agent 端上下文），成功后收起 dropdown。 */
  const onPickSession = useCallback(async (targetSessionId: string): Promise<void> => {
    if (P.switchingTo !== null) return;
    P.setSwitchingTo(targetSessionId);
    try {
      const ok = await P.switchSession(targetSessionId);
      // 成功：收起 dropdown 并清快照。失败：也收起——switchSession 已在失败分支
      // 经既有 dispatchNotice（transcript notice）/ setError（非活跃时横幅）链路把原因
      // 说清楚，surface 本身无自有 toast/notice seam，留著遮罩只会挡住那条反馈，
      // 于是「静默失败」变成「看得见的人话」（不自造轮子）。
      P.setShowHistory(false);
      if (ok) P.setHistorySnapshot(null);
    } finally {
      P.setSwitchingTo(null);
    }
  }, [P.switchingTo, P.switchSession]);
  const didAutoFreshStartRef = useRef(false);

  // 深链每次交接都恢复目标；旧请求竞态由 hook 的 connectSeqRef 守卫。
  // 清 query 不开新会话，恢复失败也不抹掉已有内容与失败反馈。
  useEffect(() => {
    if (!P.initialSessionId) return;
    didAutoFreshStartRef.current = true;
    void P.switchSession(P.initialSessionId);
  }, [P.initialSessionId, P.switchSession]);

  /** 开新对话：旧会话留在历史里可切回；成功后收 dropdown 并让历史目录重拉。 */
  const onStartNewSession = useCallback(async (): Promise<void> => {
    if (P.startingNew) return;
    P.setStartingNew(true);
    try {
      const ok = await P.startNewSession();
      if (ok) {
        P.setShowHistory(false);
        P.setHistorySnapshot(null);
        P.setHistoryCache(null); // 下次打开重新读取服务端目录。
      }
    } finally {
      P.setStartingNew(false);
    }
  }, [P.startingNew, P.startNewSession]);

  // 跨元件动作桥（窄屏侧栏叫动本面顶栏钮）：侧栏与本面不住同一棵元件树，
  // 走 window CustomEvent。回 true＝本面处理掉了，桥会 preventDefault，让
  // 侧栏知道不必退回导航；"exit" 无 onExit 时回 false，侧栏自行导航。
  useEffect(() => {
    return subscribeAgentSurfaceActions((action) => {
      switch (action) {
        case "assets":
          void toggleAssets();
          return true;
        case "history":
          void toggleHistory();
          return true;
        case "settings":
          P.openSettings();
          return true;
        case "new-session":
          void onStartNewSession();
          return true;
        case "exit":
          if (!P.onExit) return false;
          P.onExit();
          return true;
        default:
          return false;
      }
    });
  }, [toggleAssets, toggleHistory, P.openSettings, onStartNewSession, P.onExit]);

  // quota 字段保留在 hook state 里但不再展示——余额端点缺失是已知稳态，
  // 展示「余额未知」只浪费布局空间，扣费仍正常记账。
  const isActive = P.connection !== "idle" && P.connection !== "closed";
  const isInline = P.variant === "inline";

  const onSaveToLibrary = useCallback(async (item: AgentChatLibraryItem): Promise<boolean> => {
    const ownerId = P.chatHistoryUser?.id;
    const headers = authHeaders();
    if (ownerId == null || !headers || headers["x-user-id"] !== String(ownerId)) return false;
    // 客户端幂等：连点两下不该在资产包里躺两条一样的记录；去重命中也算「已存入」。
    if (P.savedIds.has(item.id)) return true;
    try {
      const now = new Date().toISOString();
      // 1. 拉取现有资产包，找「聊天素材」确定性包（不存在则构造空包）。
      const listRes = await fetch("/api/assets", { headers, cache: "no-store" });
      if (!listRes.ok || P.historyOwnerRef.current !== ownerId) return false;
      const data = (await listRes.json()) as { success?: boolean; packs?: AssetPack[] };
      if (!data.success || !Array.isArray(data.packs)) return false;
      const packs = data.packs;
      const existing = packs.find((p) => p.id === CHAT_ASSETS_PACK_ID);
      if (P.historyOwnerRef.current !== ownerId) return false;
      // 2. 去重键按种类走各自的 URL 栏位（图→imageUrl，影片/音频→mediaUrl）：
      //    不让影片拿图片的 imageUrl 去比，图片既有去重逻辑逐字不受影响。
      const urlField = assetUrlFieldOf(item.kind);
      if (existing?.items.some((it) => it[urlField] === item.url)) {
        P.setSavedIds((prev) => new Set([...prev, item.id]));
        return true;
      }
      const newItem: AssetPackItem = buildChatSaveItem(item, P.sessionId, now);
      const pack: AssetPack = existing
        ? { ...existing, items: [...existing.items, newItem], updatedAt: now }
        : {
            id: CHAT_ASSETS_PACK_ID,
            title: "聊天素材",
            items: [newItem],
            tags: [],
            createdAt: now,
            updatedAt: now,
          };
      // 3. PUT 整包 upsert（store 按 id 覆写，单用户写入串行）。
      const res = await fetch("/api/assets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(pack),
      });
      if (!res.ok || P.historyOwnerRef.current !== ownerId) return false;
      P.setSavedIds((prev) => new Set([...prev, item.id]));
      lastAssetQueryRef.current = null;
      P.setAssetCache(null);
      return true;
    } catch {
      // 回 false＝卡片显示短暂「未存入」；图还在，用户仍可下载。
      return false;
    }
  }, [P.savedIds, P.sessionId, P.chatHistoryUser?.id]);

  // 媒体卡「改图」把图加进输入框附件的既有入口（AgentComposer.enqueueFiles 经此上抛）。
  const attachFilesRef = useRef<((files: File[]) => void) | null>(null);

  // D-9：改图＝把图抓回、组 File 加进附件列（走既有附件上传状态机），**不送任何消息**。
  // 输入框出现 chip 就是回馈；抓取中/失败由卡片按钮自身呈现。
  const onEdit = useCallback(async (item: AgentImageItem): Promise<boolean> => {
    const attach = attachFilesRef.current;
    if (!attach) return false;
    try {
      const res = await fetch(`/api/media-download?url=${encodeURIComponent(item.url)}`, {
        headers: stationAuthHeaders(),
      });
      if (!res.ok) return false;
      const blob = await res.blob();
      const ext = imageExtensionFromUrl(item.url);
      const file = new File([blob], `agent-image-${item.seq}.${ext}`, {
        type: blob.type || "image/png",
      });
      attach([file]);
      return true;
    } catch {
      return false;
    }
  }, []);

  const onDownload = useCallback(async (item: AgentImageItem): Promise<boolean> => {
    return triggerDownload(item.url, `agent-${Date.now()}.png`);
  }, []);

  // 影片下载：与图片同一条 triggerDownload 路径，副档名换 mp4。
  const onVideoDownload = useCallback(async (item: AgentVideoItem): Promise<boolean> => {
    return triggerDownload(item.url, `agent-${Date.now()}.mp4`);
  }, []);
  // 影片「存图库」已接线（见下方 videoActions）：item 经 assetItemKindOf/
  // assetUrlFieldOf 落 kind:"video" + mediaUrl（agent-chat-asset-builders）。
  // 音频下载：与影片同一条 triggerDownload 路径；副档名优先取 URL 自带者
  // （FlowMusic/lyria 出 m4a，TTS 出 mp3），取不到时回落 m4a。
  const onAudioDownload = useCallback(async (item: AgentAudioItem): Promise<boolean> => {
    const ext = /\.(m4a|mp3|wav|ogg|opus|aac|flac)(?:$|\?)/i.exec(item.url)?.[1] ?? "m4a";
    return triggerDownload(item.url, `agent-${Date.now()}.${ext}`);
  }, []);
  // 音频「存图库」同影片已接线：kind:"audio" + mediaUrl（见下方 audioActions）。

  // D-12：盯住最新一条工具调用，把助理实际用的参数回流给工作台控件。
  // 用 ref 记住处理过的条目 id——重渲染不该把同一次调用回流两次，
  // 那会把使用者刚手动改回去的值又冲掉。
  const reflectedRef = useRef<string | null>(null);

  // 监听 sessionId 变化，通知父组件（用于同步清空画布）
  useEffect(() => {
    if (P.onSessionChange) {
      P.onSessionChange(P.sessionId);
    }
  }, [P.sessionId, P.onSessionChange]);

  // 双向同步：把 switchSession 能力上抛给父层（画布选中 workflow 节点时切会话）。
  useEffect(() => {
    if (P.switchSessionRef) P.switchSessionRef.current = P.switchSession;
  }, [P.switchSession, P.switchSessionRef]);

  // 暴君裁定 2026-09-01：把 startNewSession 能力同模式上抛（套模板 = 留旧开新）。
  useEffect(() => {
    if (P.startNewSessionRef) P.startNewSessionRef.current = P.startNewSession;
  }, [P.startNewSession, P.startNewSessionRef]);

  useEffect(() => {
    if (!P.onParamsReflected) return;
    // 从后往前找最新一条带参数的工具条目
    for (let i = P.state.items.length - 1; i >= 0; i -= 1) {
      const item = P.state.items[i];
      if (item.kind !== "tool") continue;
      if (item.argsSummary === undefined) continue;
      // 守卫键带上当前模型 id：同一条工具调用若在不同模型下被重新处理
      // （例如模型切换后重新回流参数），不应被「已回流过」误挡。
      const effectiveModelId = P.currentModelId ?? "";
      const guardKey = `${item.id}:${effectiveModelId}`;
      if (reflectedRef.current === guardKey) return; // 这条（在这个模型下）已经回流过
      reflectedRef.current = guardKey;
      const params = reflectParams(item.argsSummary, effectiveModelId);
      if (hasReflectedParams(params)) P.onParamsReflected(params);
      return;
    }
  }, [P.state.items, P.onParamsReflected, P.currentModelId]);

  // 每次 transcript 里出现新图，把 URL 推给右侧 ImageDisplay。
  // ref 守门避免同一张图因重渲染多次回调。
  const lastImageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!P.onImageResult) return;
    for (let i = P.state.items.length - 1; i >= 0; i -= 1) {
      const item = P.state.items[i];
      if (item.kind !== "image") continue;
      if (lastImageIdRef.current === item.id) return;
      lastImageIdRef.current = item.id;
      P.onImageResult(item.url);
      return;
    }
  }, [P.state.items, P.onImageResult]);

  /*
   * 自动落历史：助理产出的图／影片／音乐不需要使用者按钮就进生成历史（幂等 upsert）。
   *
   * 边界＝「本会话连线就绪」那一刻：连线 open 时先把当下已存在的媒体条目记为基准
   * （深链／历史切换还原回放的旧作品在生成时早就写过，这里不补写、不覆盖），
   * 之后才出现的才是本轮新产物。id 稳定（agent-<taskId>，无 taskId 用 url 杂凑），
   * 同一媒体重复写不会长第二条。写失败静默——历史是旁路，不占用户的对话流。
   */
  const mediaHistoryProcessedRef = useRef<Set<string>>(new Set());
  const mediaHistoryPrimedSessionRef = useRef<string | null>(null);
  const mediaHistoryInFlightRef = useRef<Set<string>>(new Set());
  const mediaHistoryAttemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!P.sessionId || P.connection !== "open") return;
    if (mediaHistoryPrimedSessionRef.current !== P.sessionId) {
      // 切换会话（或深链还原落点）＝新基准点：同时重设 processed／in-flight／重试计数——
      // 当下已存在的旧媒体一律视为「生成时早写过」，不补写；计数不跨会话累积。
      mediaHistoryPrimedSessionRef.current = P.sessionId;
      mediaHistoryProcessedRef.current = new Set(agentMediaItemIds(P.state.items));
      mediaHistoryInFlightRef.current = new Set();
      mediaHistoryAttemptsRef.current = new Map();
      return;
    }
    const plan = planAgentMediaHistoryWrites(
      P.state.items,
      mediaHistoryProcessedRef.current,
      mediaHistoryInFlightRef.current,
      mediaHistoryAttemptsRef.current,
    );
    // 送出前只占位本轮要送的 id（＋重试用尽判放弃者），不再把全部媒体一律标记；
    // 失败且未达上限者会在回调里从 processed 撤回，下一轮效应触发时重试。
    mediaHistoryProcessedRef.current = new Set(plan.nextProcessedIds);
    if (plan.writes.length === 0) return;
    for (const { itemId, entry } of plan.writes) {
      mediaHistoryInFlightRef.current.add(itemId);
      const onFailure = (): void => {
        const used = (mediaHistoryAttemptsRef.current.get(itemId) ?? 0) + 1;
        mediaHistoryAttemptsRef.current.set(itemId, used);
        // 未达上限 → 撤回占位，放回 pending 供下次效应重试；
        // 用尽上限 → 留在 processed（明确不可救的失败才定案为已处理），不影响其他条目。
        if (used < AGENT_MEDIA_HISTORY_MAX_ATTEMPTS) {
          mediaHistoryProcessedRef.current.delete(itemId);
        }
      };
      void saveAgentMediaToHistory(entry)
        .then((ok) => {
          if (!ok) onFailure();
        }, onFailure)
        .finally(() => {
          mediaHistoryInFlightRef.current.delete(itemId);
        });
    }
  }, [P.state.items, P.connection, P.sessionId]);

  /**
   * D-24 无缝续写：点药丸 = 把半句话搬进输入框，光标落末尾，人接着打。
   * 不直接 send —— 半句话送出去可能立刻开一轮扣费的生成（D-5）。
   */
  const continueDraft = useCallback((): void => {
    const text = P.draft.trim();
    if (!text) return;
    P.setDraft("");
    P.setPrefill({ text, nonce: Date.now() });
  }, [P.draft]);

  /**
   * 外部预填（新人礼弹窗主按钮）：与 D-24 药丸同一条通路——只搬进输入框，不发送。
   * 依赖是物件参考，所以「同一句话再点一次」由父层换 nonce 触发；输入区吃掉后
   * 会把 internal prefill 清空，而这里的依赖没变，不会重播（人在打字的东西不会被冲）。
   */
  useEffect(() => {
    if (!P.prefillRequest) return;
    P.setPrefill(P.prefillRequest);
  }, [P.prefillRequest]);

  // 稳定的引用：输入区把它放在 effect 依赖里，每次渲染换新函数会白跑一轮。
  const clearPrefill = useCallback((): void => P.setPrefill(null), []);

  /*
   * 暴君裁定 2026-09-01：进页默认起新聊天，不静默续旧——旧对话留在网关
   * 历史下拉，随时切回。同一次访问 toggle 往返不走这里（sessionTouchedInThisVisit
   * 时 resumable 根本不会被设置）。09-12 建号权收归发送按钮后，这里的
   * startNewSession 只把界面清回空态、不建号——预建的旧存档收下后不再驱动任何开场。
   * 深链（initialSessionId）另有 switchSession 接管，这里让路避免落点赛跑。
   *
   * ref 守门是必须的：resumable 会在相关路径里被清成
   * null，effect 因此至少跑两次；没有守门，任何让 resumable 再次非空的路径
   * 都会重跑一次清空。每次 mount 只自动开一次。
   */
  useEffect(() => {
    if (!P.resumable || didAutoFreshStartRef.current) return;
    didAutoFreshStartRef.current = true;
    if (P.initialSessionId) return;
    void P.startNewSession();
  }, [P.resumable, P.startNewSession, P.initialSessionId]);

  /**
   * 2026-08-25 模板注入；2026-09-12 改「nonce 到即发」：
   * 旧实现等 connection === "open" 才 send——那是 autoStart/预建年代的时序
   * （连线总在注入前开好了）。现在进助理不建号不连线，等 open 等于把注入饿死。
   * send() 内部自带 lazy 建号＋连线（ensure 在乐观插入之前），这里不再需要闸门。
   * ref 记 nonce：只在拿到新的注入时发一次，重渲染不重发。
   */
  const injectedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!P.agentInjection || injectedNonceRef.current === P.agentInjection.nonce) return;
    injectedNonceRef.current = P.agentInjection.nonce;
    P.onUserMessage?.();
    // directive 隐形上送（网关拼进 system）；模板注入默认 silent，echo 才进 transcript。
    void P.send(P.agentInjection.text, {
      ...(P.agentInjection.directive ? { sessionDirective: P.agentInjection.directive } : {}),
      silent: !P.agentInjection.echo,
    });
  }, [P.agentInjection, P.send, P.onUserMessage]);

  /**
   * D-26 首张锚定。第一张图 + 产出它的那次工具调用参数都在 transcript 里，
   * 推不出可复现参数时 deriveBatchAnchor 回 null，卡片自然不出现。
   */
  const derivedAnchor = useMemo(() => deriveBatchAnchor(P.state.items), [P.state.items]);
  // 只有用户表达过批量意图（≥2 张图或消息里带批量措辞）才弹锚定卡：
  // 只要了一张图的人不该被追问「要不要出完整批」。
  const anchor =
    derivedAnchor && derivedAnchor.imageId !== P.anchorAskedFor && shouldOfferBatchAnchor(P.state.items)
      ? derivedAnchor
      : null;

  /** 「就按这张」：把第一张实际用过的参数念回给 agent，让它照抄而不是重猜。 */
  const onAnchor = useCallback(async (): Promise<void> => {
    if (!anchor) return;
    P.setAnchorBusy(true);
    P.setAnchorAskedFor(anchor.imageId);
    try {
      await P.send(buildAnchorMessage(anchor));
    } finally {
      P.setAnchorBusy(false);
    }
  }, [anchor, P.send]);

  /** 「换个方向」：先回到一张，满意再放量——不拿一整批的钱去赌一个方向。 */
  const onReanchor = useCallback(async (): Promise<void> => {
    if (!anchor) return;
    P.setAnchorBusy(true);
    P.setAnchorAskedFor(anchor.imageId);
    try {
      await P.send(buildReanchorMessage(anchor));
    } finally {
      P.setAnchorBusy(false);
    }
  }, [anchor, P.send]);

  /** 「不用了」：纯 UI，不送消息。 */
  const onAnchorDismiss = useCallback((): void => {
    if (!anchor) return;
    P.setAnchorAskedFor(anchor.imageId);
  }, [anchor]);

  /**
   * D-26「随时可停」。系统层强制中止：网关 /session/:id/abort 打到 opencode，
   * 正在跑的这一轮直接终止（不再花后面的钱）。这不是发 prompt 软停。
   */
  const onStopGeneration = useCallback((): void => {
    void P.abort();
  }, [P.abort]);

  /*
   * 三张卡的「再来 N 组／微调」：
   *  - 图：payload 级重跑（RerunDialog → /api/generation-jobs，逐任务帐本预检、明码计价）。
   *  - 影片／音频：会话级（payload 级对按秒计费不开放）——「再来 N 组」翻成一句话用
   *    既有 send() 丢回对话，让助理重新决定参数；「微调」只预填输入框，不自动送出
   *    （半句话直接送出去会立刻开一轮扣费生成）。
   */
  const onImageRerun = useCallback((item: AgentImageItem): void => {
    P.setRerunDialog({ entry: agentHistoryEntryForMedia(item), mode: "rerun" });
  }, []);
  const onImageRerunVariant = useCallback((item: AgentImageItem): void => {
    P.setRerunDialog({ entry: agentHistoryEntryForMedia(item), mode: "variant" });
  }, []);
  const onVideoRerun = useCallback((item: AgentVideoItem, count: number): void => {
    const kind = item.mediaKind === "film" ? "成片" : "影片";
    void P.send(`把上一条${kind}按原参数再来 ${count} 组（第 ${item.seq} 段，${item.url}）`);
  }, [P.send]);
  const onVideoVariant = useCallback((item: AgentVideoItem): void => {
    const kind = item.mediaKind === "film" ? "成片" : "影片";
    P.setPrefill({ text: `微调第 ${item.seq} 段${kind}（${item.url}）：`, nonce: Date.now() });
  }, []);
  const onAudioRerun = useCallback((item: AgentAudioItem, count: number): void => {
    const kind = item.mediaKind === "music" ? "音乐" : "音频";
    void P.send(`把上一条${kind}按原参数再来 ${count} 组（第 ${item.seq} 段，${item.url}）`);
  }, [P.send]);
  const onAudioVariant = useCallback((item: AgentAudioItem): void => {
    const kind = item.mediaKind === "music" ? "音乐" : "音频";
    P.setPrefill({ text: `微调第 ${item.seq} 段${kind}（${item.url}）：`, nonce: Date.now() });
  }, []);

  const imageActions: AgentTranscriptProps["imageActions"] = {
    onSaveToLibrary,
    onEdit,
    onDownload,
    onRerun: onImageRerun,
    onRerunVariant: onImageRerunVariant,
  };

  const videoActions: AgentTranscriptProps["videoActions"] = {
    onSaveToLibrary,
    onDownload: onVideoDownload,
    onRerun: onVideoRerun,
    onVariant: onVideoVariant,
  };

  const audioActions: AgentTranscriptProps["audioActions"] = {
    onSaveToLibrary,
    onDownload: onAudioDownload,
    onRerun: onAudioRerun,
    onVariant: onAudioVariant,
  };

  return {
    prefetchAssets,
    toggleAssets,
    onActivatePack,
    prefetchHistory,
    toggleHistory,
    onPickSession,
    onStartNewSession,
    isActive,
    isInline,
    onSaveToLibrary,
    attachFilesRef,
    onEdit,
    onDownload,
    onVideoDownload,
    onAudioDownload,
    continueDraft,
    clearPrefill,
    anchor,
    onAnchor,
    onReanchor,
    onAnchorDismiss,
    onStopGeneration,
    imageActions,
    videoActions,
    audioActions,
  };
}
