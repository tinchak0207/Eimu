"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckSquare } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useHistoryStore } from "@/hooks/use-history";
import { fetchUsageStat } from "@/lib/new-api-client";
import { buildHistoryStats } from "@/lib/history-types";
import type { HistoryEntry, HistoryQuery } from "@/lib/history-types";
import { exportHistoryCsv, exportHistoryJson, exportHistoryZip } from "@/lib/history-export";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";
import { ENTRY_KIND_VALUES, parseEntryKind } from "@/components/history/history-kind-filter";
import {
  HistoryEmptyState,
  HistoryFilterBar,
  HistoryGrid,
  HistoryLightbox,
  HistorySelectionBar,
  HistorySkeleton,
  HistoryStats,
  RerunDialog,
} from "@/components/history";
import type { HistoryRerunMode } from "@/components/history";
import { LineageDrawer } from "@/components/lineage/LineageDrawer";
import { entryToLineageView } from "@/lib/lineage-view";
import type { LineageRecordView } from "@/lib/lineage";
import { useCreativeProjects } from "@/hooks/use-creative-projects";
import { listProjectAssets } from "@/lib/project-assets-client";
import { filterByProjectTag } from "@/lib/asset-scope";
import type { AssetLibraryItem } from "@/lib/asset-scope";
import { ProjectAssetsOverview } from "@/components/history/ProjectAssetsOverview";
import { text } from "@/lib/ui-strings";
import "@/components/history/history.css";

/**
 * 生成历史页。
 *
 * 数据层在 @/lib/history-client-store：它读 localStorage 里的本地缓存
 * （readGenerationCache）并与服务端记录归并（mergePersistedHistory 同源的那套逻辑，
 * 现在由 history-types 的 mergeHistoryEntries 承担，能跨源识别同一次生成）。
 * 工作站侧栏订阅的是同一个 store，所以两处状态实时一致。
 * 卡片上带「本地缓存」角标的记录表示服务端还没落盘，只存在于这台设备上。
 */

/** URL 查询参数名。集中放置，避免读写两侧写岔。 */
const PARAM = {
  keyword: "q",
  modelId: "model",
  imageSize: "size",
  starred: "starred",
  withImage: "withImage",
  // 记录类型档位也进 URL：分享/刷新/后退都要保留「我正在只看的这一类」，
  // 与 model/size 这些筛选参数同一待遇。
  entryKind: "kind",
} as const;

/**
 * 项目维度落 URL 供分享/后退复原；它不进 `queryFromSearchParams` 的两轴编排，
 * 但作为 `HistoryQuery.projectId` 并进**服务端**请求（R2：服务端按项目过滤）。
 */
const PROJECT_PARAM = "projectId";

// 合法种类值不再手写：由交付物注册表 + 非交付种类清单推导
//   [...DELIVERABLE_KIND_IDS, ...NON_DELIVERABLE_ENTRY_KINDS]
// 推导与解析落在 history-kind-filter（纯模块）——本档带 history.css，node:test
// 下无法 import，契约就测不到。这里消费同源结果，并转发导出供需要处取用：
// 「URL 里只认哪些值」与「种类筛选器认哪些值」从此是同一份真源。
export { ENTRY_KIND_VALUES, parseEntryKind };

function queryFromSearchParams(params: URLSearchParams): HistoryQuery {
  const keyword = params.get(PARAM.keyword)?.trim();
  const modelId = params.get(PARAM.modelId)?.trim();
  const imageSize = params.get(PARAM.imageSize)?.trim();
  const entryKind = parseEntryKind(params.get(PARAM.entryKind));

  return {
    ...(keyword ? { keyword } : {}),
    ...(modelId ? { modelId } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(params.get(PARAM.starred) === "1" ? { starredOnly: true } : {}),
    ...(params.get(PARAM.withImage) === "1" ? { withImageOnly: true } : {}),
    ...(entryKind !== "all" ? { entryKind } : {}),
  };
}

function searchParamsFromQuery(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.keyword) params.set(PARAM.keyword, query.keyword);
  if (query.modelId) params.set(PARAM.modelId, query.modelId);
  if (query.imageSize) params.set(PARAM.imageSize, query.imageSize);
  if (query.starredOnly) params.set(PARAM.starred, "1");
  if (query.withImageOnly) params.set(PARAM.withImage, "1");
  if (query.entryKind) params.set(PARAM.entryKind, query.entryKind);
  return params.toString();
}

export function HistoryClient() {
  const { token, isLoggedIn, isLoading: isAuthLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const history = useHistoryStore();
  // 项目维度（R1）：项目列表来自模块级单例 hook（与项目侧栏共享同一份状态）。
  // 本页/筛栏另开 fetch 会造出第二真源——禁止（数据只此一路）。
  const { projects } = useCreativeProjects();
  const projectId = searchParams.get(PROJECT_PARAM)?.trim() || null;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [accountQuota, setAccountQuota] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 「再来 N 组 / 微调变体」目标记录 + 模式：非 null 时弹出重跑对话框。 */
  const [rerunTarget, setRerunTarget] = useState<{ entry: HistoryEntry; mode: HistoryRerunMode } | null>(null);
  /** REQ-D1：溯源抽屉的目标记录（页面级单例，历史卡与灯箱共用）。 */
  const [lineageEntry, setLineageEntry] = useState<HistoryEntry | null>(null);

  // ── 项目维度（R2/R2b）：项目的资产总览 + 生成记录血缘过滤 ───────
  /** 该项目标签下的全部资产（已经 filterByProjectTag）；null＝未取到。 */
  const [projectAssets, setProjectAssets] = useState<AssetLibraryItem[] | null>(null);
  const [projectAssetsLoading, setProjectAssetsLoading] = useState(false);
  const [projectAssetsError, setProjectAssetsError] = useState<string | null>(null);

  // ── 查询与 URL 同步 ───────────────────────────────────────

  const urlQuery = useMemo(
    () => queryFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  /** 真正发给服务端的查询：项目维度已改为服务端过滤（R2），必须并进 HistoryQuery。 */
  const effectiveQuery = useMemo(
    () => (projectId ? { ...urlQuery, projectId } : urlQuery),
    [urlQuery, projectId],
  );

  const { search: runSearch, loaded } = history;
  /** 上一次真正发出去的查询，用来避免 URL 与 store 之间来回触发。 */
  const lastQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn) {
      lastQueryRef.current = null;
      return;
    }
    // projectId 不进 searchParamsFromQuery 的两轴编排，故拼进去重键——
    // 否则「只切项目」（其他筛选没变）会被早退挡掉、不发新查询。
    const serialized = projectId
      ? `${searchParamsFromQuery(urlQuery)}\u0000${projectId}`
      : searchParamsFromQuery(urlQuery);
    if (lastQueryRef.current === serialized && loaded) return;
    lastQueryRef.current = serialized;
    runSearch(effectiveQuery);
  }, [isLoggedIn, urlQuery, projectId, effectiveQuery, runSearch, loaded]);

  /** 生成中任务轮询：有 queued/running 卡时每 5 秒刷新，全部落地即停。 */
  const hasInProgress = history.entries.some(
    (entry) => entry.taskStatus === "queued" || entry.taskStatus === "running",
  );
  useEffect(() => {
    if (!isLoggedIn || !hasInProgress) return;
    const timer = window.setInterval(() => { runSearch(effectiveQuery); }, 5000);
    return () => window.clearInterval(timer);
  }, [isLoggedIn, hasInProgress, runSearch, effectiveQuery]);

  /** 把当前项目维度拼回 URL：筛选改动不得把 projectId 冲掉（反之亦然）。 */
  const buildUrl = useCallback(
    (query: HistoryQuery, pid: string | null) => {
      const params = new URLSearchParams(searchParamsFromQuery(query));
      if (pid) params.set(PROJECT_PARAM, pid);
      const serialized = params.toString();
      return serialized ? `${pathname}?${serialized}` : pathname;
    },
    [pathname],
  );

  const handleQueryChange = useCallback(
    (next: HistoryQuery) => {
      // replace 而非 push：调筛选不该在后退栈里堆一长串。
      router.replace(buildUrl(next, projectId), { scroll: false });
    },
    [router, buildUrl, projectId],
  );

  /** 项目维度切换（R3）：同样走 URL，前进/后退/直接贴 URL 都能复原。 */
  const handleProjectChange = useCallback(
    (nextId: string | null) => {
      router.replace(buildUrl(urlQuery, nextId), { scroll: false });
    },
    [router, buildUrl, urlQuery],
  );

  // ── 账户累计消耗 ─────────────────────────────────────────

  useEffect(() => {
    if (!token || !isLoggedIn) {
      setAccountQuota(null);
      return;
    }

    let cancelled = false;
    fetchUsageStat(token)
      .then((result) => {
        if (cancelled) return;
        setAccountQuota(result.success && result.data ? result.data.quota : null);
      })
      .catch(() => {
        // 统计取不到只影响顶部一个数字，不该打断整页。
        if (!cancelled) setAccountQuota(null);
      });

    return () => {
      cancelled = true;
    };
  }, [token, isLoggedIn]);

  // ── 项目资产（R2）：选中项目时拉该项目标签下的全部资产 ───────────
  // 复用既有 listProjectAssets（不得自造第二条真源）；标签筛选用 client-safe 的
  // filterByProjectTag（与资产面板同一实作）。未选项目 / 未登入一律不请求。
  useEffect(() => {
    if (!isLoggedIn || !projectId) {
      setProjectAssets(null);
      setProjectAssetsError(null);
      setProjectAssetsLoading(false);
      return;
    }
    let cancelled = false;
    setProjectAssetsLoading(true);
    setProjectAssetsError(null);
    void (async () => {
      const res = await listProjectAssets({ projectId });
      if (cancelled) return;
      setProjectAssetsLoading(false);
      if (!res.ok || !res.data) {
        setProjectAssets(null);
        setProjectAssetsError(res.message ?? text("history.project.assetsError"));
        return;
      }
      setProjectAssets(filterByProjectTag(res.data.items, projectId));
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, projectId]);

  // ── 多选 ─────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // 记录被删掉之后，选中集合里可能残留已不存在的 id。
  useEffect(() => {
    setSelectedIds((current) => {
      if (!current.size) return current;
      const alive = new Set(history.entries.map((entry) => entry.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [history.entries]);

  const selectedEntries = useMemo(
    () => history.entries.filter((entry) => selectedIds.has(entry.id)),
    [history.entries, selectedIds],
  );

  // ── 项目维度：网格与灯箱共用的展示集（R2b）───────────────────
  // 项目过滤已由服务端负责（R2：/api/history?projectId，含「盖章栏位 ∪ 资产血缘」）。
  // 这里保留一条**客户端 union 兜底**：盖章栏位命中 **或** 落进已加载资产的血缘 id 集合
  // （`projectHistoryIds`）——与新增的盖章列同一判据，不另立第二套真源、两套判据不打架。
  //
  // **辅助集未就绪时不二次裁剪**：`projectHistoryIds` 为 null ＝ `/api/project-assets`
  // 未完成或失败/403（例如项目被删/归档后的旧标签页）。此时服务端已按项目过滤过一遍，
  // 客户端**不得**拿空集合再裁一次——否则服务端正确返回的、只靠血缘命中的存量记录会被
  // 静默隐藏（Hacker 实证：服务端 total=3、网格=2）。辅助集正常时它仍负责滤掉**只存在于
  // 本地缓存**（localStorage 合并进来、未经服务端过滤）的越界条目——那才是它存在的理由。
  //
  // **下标基准唯一真源**：`displayEntries` 是网格实际渲染的阵列，也是灯箱（entries）与
  // 所有 `lightboxIndex` 计算（handleOpen / handleLineageJump / handleDelete）的唯一基准。
  // 若网格渲染 A、灯箱索引却按全量 history.entries 算，项目模式点开会翻到项目外的记录
  //（Hacker 实证翻到项目外条目）。因此本变量声明在所有使用点之前。
  const projectHistoryIds = useMemo(() => {
    if (projectAssets === null) return null;
    const ids = new Set<string>();
    for (const item of projectAssets) {
      if (item.source?.type === "history" && item.source.id) ids.add(item.source.id);
    }
    return ids;
  }, [projectAssets]);
  const projectEntries = useMemo(
    () =>
      projectId
        ? history.entries.filter(
            (entry) =>
              entry.projectIds?.includes(projectId) === true ||
              projectHistoryIds === null ||
              projectHistoryIds.has(entry.id),
          )
        : history.entries,
    [projectId, history.entries, projectHistoryIds],
  );
  /** 实际渲染进网格的记录：未选项目＝原数组（逐位元不变）；选中项目＝血缘过滤后。 */
  const displayEntries = projectEntries;

  // ── 单条操作 ─────────────────────────────────────────────

  const handleOpen = useCallback(
    (entry: HistoryEntry) => {
      const index = displayEntries.findIndex((item) => item.id === entry.id);
      if (index >= 0) setLightboxIndex(index);
    },
    [displayEntries],
  );

  /**
   * D-18：把这条记录交给 AI 助理继续做。
   *
   * 只带 prompt + 文字配方（模型/尺寸）过去，不带图。理由：助理的 image_edit /
   * image_upscale 吃的是它自己上传拿到的 mediaId，不吃我们图库里的公开 URL；
   * 硬塞 URL 只会让它重新下载再上传一次。带一句话 + 原参数（文字配方）过去让
   * 它重新构图，是这里唯一诚实可行的交接。lora 在 history 中不存在，禁止编造。
   */
  const handleOpenAgent = useCallback((entry: HistoryEntry) => {
    const prompt = entry.prompt.trim();
    // history 里的 modelId（可能缺）与 workflow.imageSize（可能缺）都是可选，
    // 只把存在的补进「原参数」括号里，避免编造 lora 之类不存在的字段。
    const modelId = entry.modelId ?? "";
    const imageSize = entry.workflow?.imageSize ?? "";
    const recipeText =
      modelId || imageSize
        ? `（原参数：${modelId ? `模型 ${modelId}` : ""}${modelId && imageSize ? "，" : ""}${imageSize ? `尺寸 ${imageSize}` : ""}）`
        : "";
    const seed = `照这个想法再做一版：${prompt}${recipeText}`;
    // 回首页并直接开在卡片的 agent 面（?agent=1），不是去 /agent 独立页——
    // 助理是那张卡片上的一个 toggle，落地就该看见工作台还在旁边。
    // ?q= 照旧（seed 已含配方文字，agent 自然能读）。
    router.push(`/?agent=1&q=${encodeURIComponent(seed)}`);
  }, [router]);

  // ── payload 级重跑（再来 N 组 / 微调变体）────────────────
  // 与 handleOpenAgent 的会话级交接不同：这里把该条的配方 payload 原样
  // （或按微调覆写）批量提交到 /api/generation-jobs，不经过助理重新猜参数。

  const handleRerun = useCallback((entry: HistoryEntry) => {
    setRerunTarget({ entry, mode: "rerun" });
  }, []);

  const handleRerunVariant = useCallback((entry: HistoryEntry) => {
    setRerunTarget({ entry, mode: "variant" });
  }, []);

  const handleRerunDone = useCallback(
    (message: string) => {
      setRerunTarget(null);
      setNotice(message);
      // 重跑任务已入队，刷新让队列态任务立即出现在历史里（闭环：提交 → 可见）。
      runSearch(urlQuery);
    },
    [runSearch, urlQuery],
  );

  // ── REQ-D1 溯源抽屉（页面级单例；历史卡与灯箱的「溯源」入口共用）────
  const handleShowLineage = useCallback((entry: HistoryEntry) => {
    setLineageEntry(entry);
  }, []);

  /**
   * 抽屉逐级跳转：血统节点的把手能对上当前列表里的记录时，直接开那条的灯箱并关抽屉
   * （返回 true 回绝抽屉自己的就地钻入）；对不上（例如资产卡在历史页没有落点）
   * 返回 false，抽屉就地钻入该级链条，诚实且零死链。
   */
  const handleLineageJump = useCallback((view: LineageRecordView) => {
    const jobId = view.selfHandles.jobId;
    const assetId = view.selfHandles.assetId;
    // 下标基准＝displayEntries（与网格/灯箱同源）；对不上时回 false，抽屉就地钻入。
    const index = displayEntries.findIndex((item) =>
      (jobId !== undefined && (item.taskId === jobId || item.generationId === jobId || item.id === jobId)) ||
      (assetId !== undefined && item.id !== "" && `history-${item.id}` === assetId) ||
      (assetId !== undefined && item.results.some((result) => result.resultId && result.resultId === assetId)),
    );
    if (index < 0) return false;
    setLineageEntry(null);
    setLightboxIndex(index);
    return true;
  }, [displayEntries]);

  const handleDownload = useCallback(async (entry: HistoryEntry) => {
    // 视频记录的结果里只有 videoUrl，音频记录里只有 audioUrl，都没有 image/imageUrl。
    // 历史卡片既然已经把视频缩略图/音频播放面显示出来了，下载钮就必须能把那段视频/
    // 音频拿走，否则按下去只会得到一句「没有可下载的图片」。
    const result = entry.results.find((item) => item.image || item.imageUrl || item.videoUrl || item.audioUrl);
    const src = result?.image ? result.image : result?.imageUrl ?? result?.videoUrl ?? result?.audioUrl;
    if (!src) {
      setNotice("这条记录没有可下载的图片、视频或音频。");
      return;
    }
    try {
      await imageHelpers.download(src, result?.modelId ?? "image");
    } catch {
      setNotice("下载失败，请稍后重试。");
    }
  }, []);

  const { remove: removeEntries, error: historyError } = history;

  const handleDelete = useCallback(
    async (id: string) => {
      // 灯箱开着且删的正是当前这张时，顺移到相邻一张，或者关掉。
      // 下标基准＝displayEntries（修复 2：灯箱与网格同源，项目模式下不得按全量数组移位）。
      setLightboxIndex((current) => {
        if (current === null) return null;
        if (displayEntries.length <= 1) return null;
        const index = displayEntries.findIndex((entry) => entry.id === id);
        if (index < 0 || index > current) return current;
        // 删掉的在当前之前（或就是当前且位于末尾）时，下标要往前挪一位。
        return current > 0 && (index < current || current === displayEntries.length - 1)
          ? current - 1
          : current;
      });

      const ok = await removeEntries([id]);
      if (!ok) setNotice(historyError ?? "删除失败。");
    },
    [displayEntries, removeEntries, historyError],
  );

  // ── 批量操作 ─────────────────────────────────────────────

  const handleBulkDownload = useCallback(async () => {
    if (!selectedEntries.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await exportHistoryZip(selectedEntries);
      if (result.exported === 0) setNotice("选中的记录都没有可下载的图片、视频或音频。");
      else if (result.skipped > 0) setNotice(`已打包 ${result.exported} 个文件，${result.skipped} 个取不到已跳过。`);
      else setNotice(`已打包 ${result.exported} 个文件。`);
    } catch {
      setNotice("打包失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [selectedEntries]);

  const { toggleStar } = history;

  const handleBulkStar = useCallback(async () => {
    const pending = selectedEntries.filter((entry) => !entry.starred);
    if (!pending.length) return;
    setBusy(true);
    try {
      // 逐条串行：并发打同一份索引会互相覆盖。
      for (const entry of pending) {
        await toggleStar(entry.id);
      }
    } finally {
      setBusy(false);
    }
  }, [selectedEntries, toggleStar]);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(true);
    try {
      const ok = await removeEntries(ids);
      if (ok) exitSelection();
      else setNotice(historyError ?? "删除失败。");
    } finally {
      setBusy(false);
    }
  }, [selectedIds, removeEntries, historyError, exitSelection]);

  // ── 提示自动消失 ─────────────────────────────────────────

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── 渲染 ─────────────────────────────────────────────────

  const localStats = useMemo(() => buildHistoryStats(history.entries), [history.entries]);
  const hasFilters = Object.keys(urlQuery).length > 0 || Boolean(projectId);
  const showSkeleton = (history.loading || isAuthLoading) && !history.entries.length;

  const emptyReason = !isLoggedIn
    ? ("logged-out" as const)
    : history.error
      ? ("error" as const)
      : hasFilters
        ? ("filtered" as const)
        : ("empty" as const);
  // 选中项目但无匹配生成记录时给明确文案（而不是套用泛用「没有符合条件的记录」）。
  const emptyMessage =
    emptyReason === "error" ? history.error : projectId ? text("history.project.historyEmpty") : null;

  return (
    <div className="min-h-screen bg-transparent px-4 pb-28 pt-8 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="mb-4 lg:mb-5 lg:flex lg:items-center lg:gap-4">
          {/* 移动端：标题左、计数+多选右同一行；桌面端 lg:contents 拆散进同一条水平工具栏。
              两份计数/多选各在对方断点 display:none，无障碍树里只暴露一份。 */}
          <div className="flex items-center justify-between gap-3 lg:contents">
            <Link
              href="/"
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-ios-body font-semibold text-[rgba(0,0,0,0.85)] lg-transition hover:text-[rgba(0,0,0,0.62)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <ArrowLeft className="h-4 w-4" />
              生成历史
            </Link>

            <div className="flex items-center gap-3 lg:hidden">
              {isLoggedIn && (history.entries.length > 0 || hasFilters) && (
                <>
                  {/* history.total 是服务端针对当前查询的计数，不包含合并进来的本地缓存记录；
                      网格里实际渲染的是 history.entries。两者在有本地专属记录时会不一致
                      （例如这条计数显示「共 3 条」，网格里「今天」分组却有 20 条），
                      用户会把它读成页面数据矛盾。这里改用真正渲染出来的条数，保证这一行
                      和它正下方的网格永远指向同一个数字。 */}
                  <span aria-live="polite" className="text-ios-footnote tabular-nums text-[rgba(0,0,0,0.58)]">
                    {hasFilters ? `筛选出 ${displayEntries.length} 条` : `共 ${displayEntries.length} 条`}
                  </span>
                  <button
                    type="button"
                    onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                    aria-pressed={selectionMode}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1.5",
                      "text-ios-footnote font-medium transition-colors duration-200",
                      "focus:outline-none focus:ring-2 focus:ring-ring/20",
                      selectionMode ? "text-[#007AFF]" : "text-[rgba(0,0,0,0.58)] hover:text-[rgba(0,0,0,0.85)]",
                    )}
                  >
                    <CheckSquare className="h-3.5 w-3.5" />
                    多选
                  </button>
                </>
              )}
            </div>
          </div>

          {isLoggedIn && (history.entries.length > 0 || hasFilters) && (
            <HistoryFilterBar
              className="mt-3 lg:order-2 lg:mt-0 lg:flex-1 lg:justify-end"
              query={urlQuery}
              facets={history.facets}
              stats={isLoggedIn ? (
                <HistoryStats
                  entries={localStats.entries}
                  images={localStats.images}
                  starred={localStats.starred}
                  accountQuota={accountQuota}
                  loading={showSkeleton}
                />
              ) : undefined}
            onExportCsv={() => exportHistoryCsv(history.entries)}
            onExportJson={() => exportHistoryJson(history.entries)}
            onChange={handleQueryChange}
            projects={projects}
            projectId={projectId}
            onProjectChange={handleProjectChange}
          />
        )}

        <div className="hidden lg:order-3 lg:flex lg:shrink-0 lg:items-center lg:gap-3">
          {isLoggedIn && (history.entries.length > 0 || hasFilters) && (
            <>
              {/* history.total 是服务端针对当前查询的计数，不包含合并进来的本地缓存记录；
                  网格里实际渲染的是 history.entries。两者在有本地专属记录时会不一致
                  （例如这条计数显示「共 3 条」，网格里「今天」分组却有 20 条），
                  用户会把它读成页面数据矛盾。这里改用真正渲染出来的条数，保证这一行
                  和它正下方的网格永远指向同一个数字。 */}
              <span aria-live="polite" className="text-ios-footnote tabular-nums text-[rgba(0,0,0,0.58)]">
                {hasFilters ? `筛选出 ${displayEntries.length} 条` : `共 ${displayEntries.length} 条`}
              </span>
              <button
                type="button"
                onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                aria-pressed={selectionMode}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1.5",
                  "text-ios-footnote font-medium transition-colors duration-200",
                  "focus:outline-none focus:ring-2 focus:ring-ring/20",
                  selectionMode ? "text-[#007AFF]" : "text-[rgba(0,0,0,0.58)] hover:text-[rgba(0,0,0,0.85)]",
                )}
              >
                <CheckSquare className="h-3.5 w-3.5" />
                多选
              </button>
            </>
          )}
        </div>
        </div>

        {/* 非致命错误：数据还在，只是某次操作失败了 */}
        {history.error && history.entries.length > 0 && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-3 rounded-ios-2xl bg-[rgba(255,59,48,0.08)] px-4 py-3"
          >
            <p className="text-ios-footnote text-[#FF3B30]">{history.error}</p>
            <button
              type="button"
              onClick={history.dismissError}
              className="shrink-0 cursor-pointer text-ios-caption1 text-[rgba(255,59,48,0.70)] transition-colors hover:text-[#FF3B30] focus:outline-none focus:ring-2 focus:ring-[rgba(255,59,48,0.20)]"
            >
              知道了
            </button>
          </div>
        )}

        {notice && (
          <div role="status" className="mb-4 rounded-ios-2xl bg-[rgba(0,122,255,0.08)] px-4 py-3">
            <p className="text-ios-footnote text-[#007AFF]">{notice}</p>
          </div>
        )}

        {/* R2：选中项目时，先展示该项目标签下的全部资产总览（只读，复用资产面板卡片）。 */}
        {projectId && isLoggedIn && (
          <ProjectAssetsOverview
            className="mb-6"
            items={projectAssets}
            loading={projectAssetsLoading}
            error={projectAssetsError}
          />
        )}

        {showSkeleton ? (
          <div className="hist-masonry" role="status" aria-label="正在加载生成历史">
            <HistorySkeleton count={8} />
          </div>
        ) : displayEntries.length === 0 ? (
          <HistoryEmptyState
            reason={emptyReason}
            message={emptyMessage}
            onClearFilters={() => (projectId ? handleProjectChange(null) : handleQueryChange({}))}
            onRetry={() => runSearch(urlQuery)}
          />
        ) : (
          <HistoryGrid
            entries={displayEntries}
            entryKindFilter={parseEntryKind(searchParams.get(PARAM.entryKind))}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            loadingMore={history.loadingMore}
            hasMore={history.hasMore}
            onLoadMore={history.loadMore}
            onOpen={handleOpen}
            onToggleSelect={toggleSelect}
            onToggleStar={toggleStar}
            onDownload={handleDownload}
            onDelete={handleDelete}
            onOpenAgent={handleOpenAgent}
            onRerun={handleRerun}
            onRerunVariant={handleRerunVariant}
            onShowLineage={handleShowLineage}
          />
        )}
      </div>

      <HistorySelectionBar
        count={selectedIds.size}
        busy={busy}
        onDownload={handleBulkDownload}
        onStar={handleBulkStar}
        onDelete={handleBulkDelete}
        onCancel={exitSelection}
      />

      <HistoryLightbox
        entries={displayEntries}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
        onToggleStar={toggleStar}
        onDownload={handleDownload}
        onDelete={handleDelete}
        onRerun={handleRerun}
        onRerunVariant={handleRerunVariant}
        onShowLineage={handleShowLineage}
      />

      {rerunTarget && (
        <RerunDialog
          entry={rerunTarget.entry}
          mode={rerunTarget.mode}
          onClose={() => setRerunTarget(null)}
          onDone={handleRerunDone}
        />
      )}

      {lineageEntry && (
        <LineageDrawer
          host={entryToLineageView(lineageEntry)}
          hostKindLabel="生成记录"
          onClose={() => setLineageEntry(null)}
          onJump={handleLineageJump}
        />
      )}
    </div>
  );
}
