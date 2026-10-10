"use client";

// REQ-B2 团队资产空间：项目资产库面板（列表 + 搜寻/筛选 + 项目标签）。
//
// 2026-10-09：挂用／解除挂用／显式分享交互已删——只保留「打项目标签／只看本项目标签」
// （标签＝该项目常驻可用集；打了标签的资产由卡库刷新后自动进生成注入，不需挂用副本）。
// 归属(scope)控件保留原样。视觉沿用画布弹层语汇（lg-sheet / rounded-ios-2xl / ios 字级），不另造样式体系。
// 未登入安静显示登入提示（同 CanvasLibraryPanel 的资产 tab 惯例）。
//
// 文案纪律：本元件零硬编用户可见字串，全部经 `text()` 取自 src/lib/ui-strings.ts
// （守门件 src/lib/ui-strings.test.ts 去注解后禁 CJK）。伺服器回传的 kindLabel（资产包/角色/…）
// 与用户资产名/标签是资料，原样显示。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { text, type UiStringKey } from "@/lib/ui-strings";
import {
  assignAssetProjectTags,
  assignAssetScope,
  listProjectAssets,
} from "@/lib/project-assets-client";
import { filterByProjectTag, MAX_ASSET_PROJECT_TAGS, normalizeProjectIds } from "@/lib/asset-scope";
import type { AssetKind, AssetLibraryItem, AssetVisibility } from "@/lib/asset-scope";
import { useCreativeProjects } from "@/hooks/use-creative-projects";

export interface ProjectAssetLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  /** 当前项目 id；null = 画布尚未建号（此时只有个人资产可见，挂用不可用）。 */
  projectId: string | null;
  /** 未登入态提示（父层已知登入态时传入，避免多余请求）。 */
  isLoggedIn?: boolean;
  /**
   * 2026-10-09：标签变更 → 通知父层重读卡库并重组注入集（打标签立即生效，不需刷新页面）。
   * 这是删掉挂用交互后「打了标签却要等下次卡库抓取才生效」的唯一补口。
   */
  onTagsChange?: () => void | Promise<void>;
}

const VISIBILITY_KEY: Record<AssetVisibility, UiStringKey> = {
  owner: "assets.visibility.owner",
  "in-project": "assets.visibility.inProject",
  "in-team": "assets.visibility.inTeam",
  "shared-in": "assets.visibility.sharedIn",
};

const VISIBILITY_CLASSES: Record<AssetVisibility, string> = {
  owner: "bg-black/5 text-muted-foreground",
  "in-project": "bg-ios-blue/10 text-[#007AFF]",
  "in-team": "bg-ios-indigo/10 text-[#5856D6]",
  "shared-in": "bg-ios-green/10 text-[#248A3D]",
};

const KIND_FILTERS: readonly { value: AssetKind | "all"; key: UiStringKey }[] = [
  { value: "all", key: "assets.filter.all" },
  { value: "pack", key: "assets.filter.pack" },
  { value: "card", key: "assets.filter.card" },
];

type BusyKey = string | null;

/** 300ms debounce 的字串值（沿用 CanvasLibraryPanel 同款）。 */
function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function ProjectAssetLibraryPanel({
  open,
  onClose,
  projectId,
  isLoggedIn = true,
  onTagsChange,
}: ProjectAssetLibraryPanelProps) {
  const [items, setItems] = useState<AssetLibraryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const [busy, setBusy] = useState<BusyKey>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // P1-B：标签目标项目（默认跟随全局 activeProjectId）＋「只看本项目标签」开关。
  const [tagProjectId, setTagProjectId] = useState<string | null>(null);
  const [filterByTag, setFilterByTag] = useState(false);
  const tagSelectionTouched = useRef(false);
  const debouncedQuery = useDebouncedValue(query);
  const requestSeq = useRef(0);
  const { projects, activeProjectId } = useCreativeProjects();

  // 默认选中 activeProjectId（用户手动改过就不再回填）。
  useEffect(() => {
    if (tagSelectionTouched.current) return;
    if (activeProjectId) setTagProjectId(activeProjectId);
  }, [activeProjectId]);

  const load = useCallback(async () => {
    if (!projectId) {
      setItems(null);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const res = await listProjectAssets({
      projectId,
      q: debouncedQuery,
      kind: kindFilter,
    });
    if (seq !== requestSeq.current) return; // 旧回应不覆盖新查询
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? text("assets.error.loadFailed"));
      setItems(null);
      return;
    }
    setItems(res.data.items);
  }, [projectId, debouncedQuery, kindFilter]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const changeScope = useCallback(
    async (item: AssetLibraryItem, toProjectScoped: boolean) => {
      if (!projectId) return;
      const key = `${item.assetKind}:${item.assetId}`;
      setBusy(key);
      const res = await assignAssetScope({
        assetKind: item.assetKind,
        assetId: item.assetId,
        projectId: toProjectScoped ? projectId : null,
      });
      setBusy(null);
      if (!res.ok) {
        setNotice(res.message ?? text("assets.error.action"));
        return;
      }
      setNotice(null);
      await load();
    },
    [projectId, load],
  );

  const toggleProjectTag = useCallback(
    async (item: AssetLibraryItem) => {
      if (!tagProjectId) return;
      const current = normalizeProjectIds(item.projectIds);
      const tagged = current.includes(tagProjectId);
      if (!tagged && current.length >= MAX_ASSET_PROJECT_TAGS) {
        setNotice(text("assets.projectTag.limit", { max: MAX_ASSET_PROJECT_TAGS }));
        return;
      }
      const next = tagged ? current.filter((id) => id !== tagProjectId) : [...current, tagProjectId];
      const key = `${item.assetKind}:${item.assetId}`;
      setBusy(key);
      const res = await assignAssetProjectTags({
        assetKind: item.assetKind,
        assetId: item.assetId,
        projectIds: next,
      });
      setBusy(null);
      // CanvasClientResult.ok 不是判别联合：ok 之后 data 仍可能 undefined，一起挡。
      if (!res.ok || !res.data) {
        setNotice(res.message ?? text("assets.error.action"));
        return;
      }
      // 乐观更新本地列表该项的 projectIds——不打整表刷新（其余栏位与列表顺序不动）。
      const savedProjectIds = res.data.projectIds;
      setItems(
        (prev) =>
          prev?.map((entry) =>
            entry.assetKind === item.assetKind && entry.assetId === item.assetId
              ? { ...entry, projectIds: savedProjectIds }
              : entry,
          ) ?? prev,
      );
      setNotice(null);
      // 标签变更 → 通知父层重读卡库并重组注入集（打标签立即进生成，不等下次卡库抓取）。
      await onTagsChange?.();
    },
    [tagProjectId, onTagsChange],
  );

  /**
   * 「只看本项目标签」＝客户端过滤（服务端列表已过可见性/检索/挂用；标签是展示层筛选）。
   *
   * 走 src/lib/asset-scope.ts 的 filterByProjectTag（**client-safe**：该档纯逻辑无 IO、
   * 不 import node:crypto 等伺服器专属模块，可从 "use client" 元件安全 import）。
   * 语义：projectId 空 / 空白 → 原样回传；否则 projectIds 含它才命中。单一实作，不另立规则。
   */
  const visibleItems = useMemo(() => {
    const list = items ?? [];
    if (!filterByTag) return list;
    return filterByProjectTag(list, tagProjectId);
  }, [items, filterByTag, tagProjectId]);

  const summary = useMemo(() => {
    return { total: visibleItems.length };
  }, [visibleItems]);

  if (!open) return null;

  return (
    <div
      data-canvas-interactive
      className="lg-sheet pointer-events-auto fixed z-[85] w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-ios-2xl"
      style={{
        right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
        top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
        maxHeight: "min(70dvh, 520px)",
      }}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-ios-caption1 font-semibold text-foreground">{text("assets.title")}</p>
          <p className="mt-0.5 text-ios-caption2 leading-snug text-foreground/45">{text("assets.subtitle")}</p>
        </div>
        <button
          type="button"
          aria-label={text("assets.refresh")}
          onClick={() => void load()}
          className="shrink-0 cursor-pointer rounded-lg p-1 text-foreground/45 hover:bg-black/5"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label={text("assets.close")}
          onClick={onClose}
          className="shrink-0 cursor-pointer rounded-lg p-1 text-foreground/45 hover:bg-black/5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-1 text-ios-caption2 text-foreground/45">
          <span className="shrink-0">{text("assets.projectTag.label")}</span>
          <select
            value={tagProjectId ?? ""}
            onChange={(e) => {
              tagSelectionTouched.current = true;
              const next = e.target.value || null;
              setTagProjectId(next);
              if (!next) setFilterByTag(false); // 没选项目 = 没有「本项目」可看，开关一并收起
            }}
            className="min-w-0 flex-1 cursor-pointer rounded-lg bg-black/5 px-2 py-1 text-ios-caption1 text-foreground outline-none"
          >
            <option value="">{text("assets.projectTag.none")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!tagProjectId}
          onClick={() => setFilterByTag((v) => !v)}
          aria-pressed={filterByTag}
          className={cn(
            "shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-ios-caption2 font-medium disabled:opacity-40",
            filterByTag && tagProjectId
              ? "bg-ios-blue/10 text-[#007AFF]"
              : "bg-black/5 text-muted-foreground hover:bg-black/10",
          )}
        >
          {text("assets.projectTag.filterOnly")}
        </button>
      </div>
      {!tagProjectId && (
        <p className="border-b px-3 py-1 text-ios-caption2 text-foreground/45">
          {text("assets.projectTag.filterHint")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-black/5 px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={text("assets.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-ios-caption1 text-foreground outline-none placeholder:text-foreground/35"
          />
        </label>
        {KIND_FILTERS.map(({ value, key }) => (
          <button
            key={value}
            type="button"
            onClick={() => setKindFilter(value)}
            aria-pressed={kindFilter === value}
            className={cn(
              "cursor-pointer rounded-full px-2 py-0.5 text-ios-caption2 font-medium",
              kindFilter === value ? "bg-ios-blue/10 text-[#007AFF]" : "bg-black/5 text-muted-foreground hover:bg-black/10",
            )}
          >
            {text(key)}
          </button>
        ))}
      </div>

      {!isLoggedIn ? (
        <p className="px-3.5 py-3 text-ios-caption1 text-foreground/45">{text("assets.guest")}</p>
      ) : !projectId ? (
        <p className="px-3.5 py-3 text-ios-caption1 text-foreground/45">{text("assets.noProject")}</p>
      ) : items === null && loading ? (
        <p className="flex items-center gap-1.5 px-3.5 py-3 text-ios-caption1 text-foreground/45">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {text("assets.loading")}
        </p>
      ) : error ? (
        <p className="px-3.5 py-3 text-ios-caption1 text-destructive">{text("assets.loadError", { error })}</p>
      ) : (items?.length ?? 0) === 0 ? (
        <p className="px-3.5 py-3 text-ios-caption1 text-foreground/45">
          {text("assets.empty")}
        </p>
      ) : (
        <div className="overflow-y-auto" style={{ maxHeight: "min(52dvh, 400px)" }}>
          {notice && <p className="border-b px-3.5 py-1.5 text-ios-caption2 text-[#007AFF]">{notice}</p>}
          <p className="border-b px-3.5 py-1 text-ios-caption2 text-foreground/45">
            {text("assets.summary.total", { total: summary.total })}
          </p>
          {visibleItems.length === 0 && (
            <p className="px-3.5 py-3 text-ios-caption1 text-foreground/45">{text("assets.projectTag.empty")}</p>
          )}
          {visibleItems.map((item) => {
            const key = `${item.assetKind}:${item.assetId}`;
            const isOwnProjectAsset = item.visibility === "in-project";
            const tagged = tagProjectId ? normalizeProjectIds(item.projectIds).includes(tagProjectId) : false;
            return (
              <div key={key} className="border-b px-3 py-2.5 last:border-b-0">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-ios-caption1 font-medium text-foreground">
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                        {item.kindLabel}
                      </span>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-ios-caption2", VISIBILITY_CLASSES[item.visibility])}>
                        {text(VISIBILITY_KEY[item.visibility])}
                      </span>
                    </p>
                    {item.tags.length > 0 && (
                      <p className="mt-0.5 truncate text-ios-caption2 text-foreground/45">{item.tags.join(" · ")}</p>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === key || !tagProjectId}
                    onClick={() => void toggleProjectTag(item)}
                    aria-pressed={tagged}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-lg px-1.5 py-0.5 text-ios-caption2 font-medium disabled:opacity-40",
                      tagged
                        ? "bg-ios-blue/10 text-[#007AFF] hover:bg-ios-blue/20"
                        : "bg-black/5 text-muted-foreground hover:bg-black/10",
                    )}
                  >
                    {tagged ? text("assets.projectTag.remove") : text("assets.projectTag.add")}
                  </button>
                  <button
                    type="button"
                    disabled={busy === key}
                    onClick={() => void changeScope(item, !isOwnProjectAsset)}
                    className="cursor-pointer rounded-lg bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground hover:bg-black/10 disabled:opacity-50"
                  >
                    {isOwnProjectAsset ? text("assets.scope.toPersonal") : text("assets.scope.toProject")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
