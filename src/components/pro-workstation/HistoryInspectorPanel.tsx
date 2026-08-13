"use client";

import { memo, useMemo, useState } from "react";
import { ImageOff, RotateCcw, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHistoryStore } from "@/hooks/use-history";
import {
  filterHistoryEntries,
  formatModelLabel,
  formatRelativeTime,
  normalizeHistoryEntry,
  primaryModelId,
} from "@/lib/history-types";
import type { HistoryEntry } from "@/lib/history-types";
import type { PersistedGenerationEntry } from "@/lib/generation-cache";
import type { ProviderKey } from "@/lib/provider-config";

export interface HistoryInspectorPanelProps {
  /**
   * 恢复一条记录的参数到工作台。
   * 由 InvokeInspiredWorkstation 传入它自己的 restoreHistoryEntry。
   */
  onRestore: (entry: PersistedGenerationEntry) => void;
  /** 把某张历史图设为参考图，继续在它的基础上做。 */
  onUseAsReference?: (entry: HistoryEntry) => void;
  /**
   * 共享 store 首次拉取完成前先垫上的记录。
   * 工作台挂载时 use-image-generation 已经把最近几条读进内存了，
   * 直接拿来渲染，避免面板先空一下再跳出内容。
   */
  fallbackEntries?: PersistedGenerationEntry[];
}

/**
 * 统一模型 → 工作台使用的缓存实体。
 *
 * 两者字段基本一致，差别在 provider：统一模型用 string（要容纳服务端存下来的任意值），
 * 缓存实体用窄类型 ProviderKey。这里做一次显式转换而不是在调用处硬转 ——
 * provider 的值本来就出自本站自己的写入，收窄是安全的，但值得写明白。
 * restoreHistoryEntry 只读 prompt 与 workflow，results 仅为满足类型而带上。
 */
function toPersistedEntry(entry: HistoryEntry): PersistedGenerationEntry {
  return {
    id: entry.id,
    prompt: entry.prompt,
    generatedAt: entry.generatedAt,
    source: entry.source === "local" ? "local" : "server",
    results: entry.results.map((result) => ({
      provider: result.provider as ProviderKey,
      modelId: result.modelId,
      image: result.image,
      imageUrl: result.imageUrl,
    })),
    ...(entry.workflow ? { workflow: entry.workflow } : {}),
  };
}

function entryThumb(entry: HistoryEntry): string | null {
  const result = entry.results.find((item) => item.image || item.imageUrl);
  if (!result) return null;
  return result.image ? `data:image/png;base64,${result.image}` : result.imageUrl;
}

/** 侧栏只有 320px 宽，所以这里走的是密集信息布局，而不是 /history 页的瀑布流。 */
function HistoryRow({
  entry,
  onRestore,
  onUseAsReference,
  onToggleStar,
}: {
  entry: HistoryEntry;
  onRestore: (entry: PersistedGenerationEntry) => void;
  onUseAsReference?: (entry: HistoryEntry) => void;
  onToggleStar: (id: string) => void;
}) {
  const thumb = entryThumb(entry);
  const model = primaryModelId(entry);
  const label = entry.workflow?.workflowPresetLabel ?? entry.prompt.trim() ?? "";

  return (
    <div className="pro-history-row group">
      <button
        type="button"
        onClick={() => onRestore(toPersistedEntry(entry))}
        title="恢复这套参数"
        className="pro-history-main"
      >
        <span className="pro-history-thumb">
          {thumb ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={thumb} alt="" loading="lazy" decoding="async" />
          ) : (
            <ImageOff className="h-3 w-3 text-[rgba(0,0,0,0.22)]" />
          )}
        </span>
        <span className="pro-history-text">
          <span className="pro-history-label">{label || "历史配置"}</span>
          <small>
            {model ? formatModelLabel(model) : "未知模型"} · {formatRelativeTime(entry.generatedAt)}
          </small>
        </span>
      </button>

      <span className="pro-history-tools">
        <button
          type="button"
          onClick={() => onToggleStar(entry.id)}
          aria-label={entry.starred ? "取消收藏" : "收藏"}
          aria-pressed={Boolean(entry.starred)}
          title={entry.starred ? "取消收藏" : "收藏"}
          className={cn("pro-history-tool", entry.starred && "is-active")}
        >
          <Star className="h-3 w-3" fill={entry.starred ? "currentColor" : "none"} />
        </button>
        {onUseAsReference && thumb && (
          <button
            type="button"
            onClick={() => onUseAsReference(entry)}
            aria-label="作为参考图继续"
            title="作为参考图继续"
            className="pro-history-tool"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </span>
    </div>
  );
}

function HistoryInspectorPanelComponent({
  onRestore,
  onUseAsReference,
  fallbackEntries,
}: HistoryInspectorPanelProps) {
  const history = useHistoryStore();
  const [keyword, setKeyword] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);

  // store 还没拿到数据时，先用工作台已经在内存里的那几条顶上。
  const source = useMemo(() => {
    if (history.entries.length || !fallbackEntries?.length) return history.entries;
    return fallbackEntries.flatMap((entry) => {
      const normalized = normalizeHistoryEntry(entry, "local");
      return normalized ? [normalized] : [];
    });
  }, [history.entries, fallbackEntries]);

  // 侧栏的筛选是纯本地的：只在已经加载进来的记录里找，不额外打请求。
  // 要翻完整历史时用户会去 /history 页。
  const visible = useMemo(
    () =>
      filterHistoryEntries(source, {
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        ...(starredOnly ? { starredOnly: true } : {}),
      }).slice(0, 40),
    [source, keyword, starredOnly],
  );

  if (!history.isLoggedIn) {
    return <p className="pro-history-empty">登录后可以看到历史记录。</p>;
  }

  return (
    <div className="pro-history-panel">
      <div className="pro-history-filters">
        <span className="pro-history-search">
          <Search className="h-3 w-3" />
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索提示词或模型"
            aria-label="搜索历史记录"
          />
        </span>
        <button
          type="button"
          onClick={() => setStarredOnly((value) => !value)}
          aria-pressed={starredOnly}
          title="只看收藏"
          className={cn("pro-history-tool", starredOnly && "is-active")}
        >
          <Star className="h-3 w-3" fill={starredOnly ? "currentColor" : "none"} />
        </button>
      </div>

      {history.loading && source.length === 0 ? (
        <p className="pro-history-empty">正在载入历史记录…</p>
      ) : visible.length === 0 ? (
        <p className="pro-history-empty">
          {source.length === 0
            ? "还没有历史记录。生成后会显示在这里。"
            : "没有符合条件的记录。"}
        </p>
      ) : (
        <div className="pro-history-list">
          {visible.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              onRestore={onRestore}
              {...(onUseAsReference ? { onUseAsReference } : {})}
              onToggleStar={history.toggleStar}
            />
          ))}
        </div>
      )}

      {history.error && <p className="pro-history-empty">{history.error}</p>}
    </div>
  );
}

export const HistoryInspectorPanel = memo(HistoryInspectorPanelComponent);
