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
import { publishUserShowcaseCase } from "@/lib/showcase-user-cases";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";
import {
  HistoryEmptyState,
  HistoryFilterBar,
  HistoryGrid,
  HistoryLightbox,
  HistorySelectionBar,
  HistorySkeleton,
  HistoryStats,
  RerunDialog,
  SaveCardDialog,
} from "@/components/history";
import type { HistoryRerunMode } from "@/components/history";
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
} as const;

function queryFromSearchParams(params: URLSearchParams): HistoryQuery {
  const keyword = params.get(PARAM.keyword)?.trim();
  const modelId = params.get(PARAM.modelId)?.trim();
  const imageSize = params.get(PARAM.imageSize)?.trim();

  return {
    ...(keyword ? { keyword } : {}),
    ...(modelId ? { modelId } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(params.get(PARAM.starred) === "1" ? { starredOnly: true } : {}),
    ...(params.get(PARAM.withImage) === "1" ? { withImageOnly: true } : {}),
  };
}

function searchParamsFromQuery(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.keyword) params.set(PARAM.keyword, query.keyword);
  if (query.modelId) params.set(PARAM.modelId, query.modelId);
  if (query.imageSize) params.set(PARAM.imageSize, query.imageSize);
  if (query.starredOnly) params.set(PARAM.starred, "1");
  if (query.withImageOnly) params.set(PARAM.withImage, "1");
  return params.toString();
}

export function HistoryClient() {
  const { token, isLoggedIn, isLoading: isAuthLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const history = useHistoryStore();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [accountQuota, setAccountQuota] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 「存为角色卡」目标记录：非 null 时弹出命名对话框。 */
  const [saveCardEntry, setSaveCardEntry] = useState<HistoryEntry | null>(null);
  /** 「再来 N 组 / 微调变体」目标记录 + 模式：非 null 时弹出重跑对话框。 */
  const [rerunTarget, setRerunTarget] = useState<{ entry: HistoryEntry; mode: HistoryRerunMode } | null>(null);

  // ── 查询与 URL 同步 ───────────────────────────────────────

  const urlQuery = useMemo(
    () => queryFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const { search: runSearch, loaded } = history;
  /** 上一次真正发出去的查询，用来避免 URL 与 store 之间来回触发。 */
  const lastQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn) {
      lastQueryRef.current = null;
      return;
    }
    const serialized = searchParamsFromQuery(urlQuery);
    if (lastQueryRef.current === serialized && loaded) return;
    lastQueryRef.current = serialized;
    runSearch(urlQuery);
  }, [isLoggedIn, urlQuery, runSearch, loaded]);

  const handleQueryChange = useCallback(
    (next: HistoryQuery) => {
      const serialized = searchParamsFromQuery(next);
      // replace 而非 push：调筛选不该在后退栈里堆一长串。
      router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false });
    },
    [router, pathname],
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

  // ── 单条操作 ─────────────────────────────────────────────

  const handleOpen = useCallback(
    (entry: HistoryEntry) => {
      const index = history.entries.findIndex((item) => item.id === entry.id);
      if (index >= 0) setLightboxIndex(index);
    },
    [history.entries],
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

  const handleDownload = useCallback(async (entry: HistoryEntry) => {
    const result = entry.results.find((item) => item.image || item.imageUrl);
    const src = result?.image ? result.image : result?.imageUrl;
    if (!src) {
      setNotice("这条记录没有可下载的图片。");
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
      setLightboxIndex((current) => {
        if (current === null) return null;
        if (history.entries.length <= 1) return null;
        const index = history.entries.findIndex((entry) => entry.id === id);
        if (index < 0 || index > current) return current;
        // 删掉的在当前之前（或就是当前且位于末尾）时，下标要往前挪一位。
        return current > 0 && (index < current || current === history.entries.length - 1)
          ? current - 1
          : current;
      });

      const ok = await removeEntries([id]);
      if (!ok) setNotice(historyError ?? "删除失败。");
    },
    [history.entries, removeEntries, historyError],
  );

  // ── 批量操作 ─────────────────────────────────────────────

  const handleBulkDownload = useCallback(async () => {
    if (!selectedEntries.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await exportHistoryZip(selectedEntries);
      if (result.exported === 0) setNotice("选中的记录都没有可下载的图片。");
      else if (result.skipped > 0) setNotice(`已打包 ${result.exported} 张，${result.skipped} 张取不到图已跳过。`);
      else setNotice(`已打包 ${result.exported} 张。`);
    } catch {
      setNotice("打包失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [selectedEntries]);

  // ── 存为角色卡（历史一锚定）─────────────────────────

  /** 对话框完成回调：结果进页面通知条（成功/失败统一走这里）。 */
  const handleSaveCardDone = useCallback((message: string) => {
    setSaveCardEntry(null);
    setNotice(message);
  }, []);

  // ── 发布为案例（配方资产总线对向动作）───────────────────
  // 把这条历史的配方快照发布进首页案例环（showcase-user-cases 的 localStorage
  // 数据层扩展点，幂等）。无审核流的最小可用路径：发布后回首页即出现在案例环。
  const handlePublishCase = useCallback((entry: HistoryEntry) => {
    const result = publishUserShowcaseCase(entry);
    setNotice(result.ok
      ? (result.alreadyPublished
          ? "这条配方已发布过案例，首页案例环里可以直接找到它。"
          : "已发布为案例：回到首页，它已进入案例环，可随时「用此工作流打开」。")
      : result.reason);
  }, []);

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
  const hasFilters = Object.keys(urlQuery).length > 0;
  const showSkeleton = (history.loading || isAuthLoading) && !history.entries.length;

  const emptyReason = !isLoggedIn
    ? ("logged-out" as const)
    : history.error
      ? ("error" as const)
      : hasFilters
        ? ("filtered" as const)
        : ("empty" as const);

  return (
    <div className="min-h-screen bg-transparent px-4 pb-28 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="mb-4 lg:mb-5 lg:flex lg:items-center lg:gap-4">
          {/* 移动端：标题左、计数+多选右同一行；桌面端 lg:contents 拆散进同一条水平工具栏。
              两份计数/多选各在对方断点 display:none，无障碍树里只暴露一份。 */}
          <div className="flex items-center justify-between gap-3 lg:contents">
            <Link
              href="/"
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-ios-body font-semibold text-[rgba(0,0,0,0.85)] lg-transition hover:text-[rgba(0,0,0,0.62)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
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
                    {hasFilters ? `筛选出 ${history.entries.length} 条` : `共 ${history.entries.length} 条`}
                  </span>
                  <button
                    type="button"
                    onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                    aria-pressed={selectionMode}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1.5",
                      "text-ios-footnote font-medium transition-colors duration-200",
                      "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
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
                {hasFilters ? `筛选出 ${history.entries.length} 条` : `共 ${history.entries.length} 条`}
              </span>
              <button
                type="button"
                onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                aria-pressed={selectionMode}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1.5",
                  "text-ios-footnote font-medium transition-colors duration-200",
                  "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
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

        {showSkeleton ? (
          <div className="hist-masonry" role="status" aria-label="正在加载生成历史">
            <HistorySkeleton count={8} />
          </div>
        ) : history.entries.length === 0 ? (
          <HistoryEmptyState
            reason={emptyReason}
            message={emptyReason === "error" ? history.error : null}
            onClearFilters={() => handleQueryChange({})}
            onRetry={() => runSearch(urlQuery)}
          />
        ) : (
          <HistoryGrid
            entries={history.entries}
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
            onSaveCard={setSaveCardEntry}
            onRerun={handleRerun}
            onRerunVariant={handleRerunVariant}
            onPublishCase={handlePublishCase}
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
        entries={history.entries}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
        onToggleStar={toggleStar}
        onDownload={handleDownload}
        onDelete={handleDelete}
        onSaveCard={setSaveCardEntry}
        onRerun={handleRerun}
        onRerunVariant={handleRerunVariant}
        onPublishCase={handlePublishCase}
      />

      {rerunTarget && (
        <RerunDialog
          entry={rerunTarget.entry}
          mode={rerunTarget.mode}
          onClose={() => setRerunTarget(null)}
          onDone={handleRerunDone}
        />
      )}

      {saveCardEntry && (
        <SaveCardDialog
          entry={saveCardEntry}
          onClose={() => setSaveCardEntry(null)}
          onDone={handleSaveCardDone}
        />
      )}
    </div>
  );
}
