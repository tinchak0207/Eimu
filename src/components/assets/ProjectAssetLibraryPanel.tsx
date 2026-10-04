"use client";

// REQ-B2 团队资产空间：项目资产库面板（列表 + 搜寻/筛选 + 挂用入口 + 显式分享）。
//
// 最小可用面：资产包与资产卡（角色/场景/风格）同列一张清单，每列带归属与可见性标记，
// 可一键挂用/解除；项目归属的资产可在此显式分享到别的项目（唯一的跨项目授权入口）。
// 视觉沿用画布弹层语汇（lg-sheet / rounded-ios-2xl / ios 字级），不另造样式体系。
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
  assignAssetScope,
  listProjectAssets,
  mountProjectAsset,
  shareProjectAsset,
  unmountProjectAsset,
} from "@/lib/project-assets-client";
import type { AssetKind, AssetLibraryItem, AssetVisibility } from "@/lib/asset-scope";

export interface ProjectAssetLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  /** 当前项目 id；null = 画布尚未建号（此时只有个人资产可见，挂用不可用）。 */
  projectId: string | null;
  /** 未登入态提示（父层已知登入态时传入，避免多余请求）。 */
  isLoggedIn?: boolean;
  /**
   * REQ-B2b：挂用/解除后的**副本 id 变更**回报（父层据此把副本锁进／解锁出 cardIds）。
   * 这是本刀生效的硬接线——不回报＝画面说「已挂用」但生成仍注入来源 id。
   */
  onCopyChange?: (change: { locked: string[]; unlocked: string[] }) => void | Promise<void>;
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
  onCopyChange,
}: ProjectAssetLibraryPanelProps) {
  const [items, setItems] = useState<AssetLibraryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const [mountedOnly, setMountedOnly] = useState(false);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [shareTarget, setShareTarget] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(query);
  const requestSeq = useRef(0);

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
      mountedOnly,
    });
    if (seq !== requestSeq.current) return; // 旧回应不覆盖新查询
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? text("assets.error.loadFailed"));
      setItems(null);
      return;
    }
    setItems(res.data.items);
  }, [projectId, debouncedQuery, kindFilter, mountedOnly]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const toggleMount = useCallback(
    async (item: AssetLibraryItem) => {
      if (!projectId) return;
      const key = `${item.assetKind}:${item.assetId}`;
      setBusy(key);
      if (item.mounted) {
        const res = await unmountProjectAsset({ projectId, assetKind: item.assetKind, assetId: item.assetId });
        setBusy(null);
        // CanvasClientResult.ok 不是判别联合：ok 之后 data 仍可能 undefined，一起挡。
        if (!res.ok || !res.data) {
          setNotice(res.message ?? text("assets.error.action"));
          return;
        }
        // 解除＝连副本一起解锁（否则画面说「已解除」、生成还在注入副本）。
        if (res.data.localCopyIds.length > 0) {
          await onCopyChange?.({ locked: [], unlocked: res.data.localCopyIds });
        }
        setNotice(text("assets.mount.unmounted"));
        await load();
        return;
      }
      const res = await mountProjectAsset({ projectId, assetKind: item.assetKind, assetId: item.assetId });
      setBusy(null);
      if (!res.ok || !res.data) {
        setNotice(res.message ?? text("assets.error.action"));
        return;
      }
      // copy-on-use 的落地点：副本 id 锁进 cardIds（生成注入读的就是这批）。
      if (res.data.localCopyIds.length > 0) {
        await onCopyChange?.({ locked: res.data.localCopyIds, unlocked: [] });
      }
      setNotice(
        res.data.skippedItems > 0
          ? text("assets.mount.skipped", { count: res.data.skippedItems })
          : res.data.created
            ? text("assets.mount.created")
            : text("assets.mount.existing"),
      );
      await load();
    },
    [projectId, load, onCopyChange],
  );

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

  const share = useCallback(
    async (item: AssetLibraryItem) => {
      if (!projectId || !shareTarget.trim()) return;
      const key = `${item.assetKind}:${item.assetId}`;
      setBusy(key);
      const res = await shareProjectAsset({
        assetKind: item.assetKind,
        assetId: item.assetId,
        fromProjectId: projectId,
        toProjectId: shareTarget.trim(),
      });
      setBusy(null);
      if (!res.ok) {
        setNotice(res.message ?? text("assets.error.share"));
        return;
      }
      setNotice(res.data?.created ? text("assets.share.created") : text("assets.share.existing"));
      await load();
    },
    [projectId, shareTarget, load],
  );

  const summary = useMemo(() => {
    const list = items ?? [];
    return { total: list.length, mounted: list.filter((i) => i.mounted).length };
  }, [items]);

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
        <button
          type="button"
          onClick={() => setMountedOnly((v) => !v)}
          aria-pressed={mountedOnly}
          className={cn(
            "cursor-pointer rounded-full px-2 py-0.5 text-ios-caption2 font-medium",
            mountedOnly ? "bg-ios-green/10 text-[#248A3D]" : "bg-black/5 text-muted-foreground hover:bg-black/10",
          )}
        >
          {text("assets.mountedOnly")}
        </button>
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
          {mountedOnly ? text("assets.emptyMounted") : text("assets.empty")}
        </p>
      ) : (
        <div className="overflow-y-auto" style={{ maxHeight: "min(52dvh, 400px)" }}>
          {notice && <p className="border-b px-3.5 py-1.5 text-ios-caption2 text-[#007AFF]">{notice}</p>}
          <p className="border-b px-3.5 py-1 text-ios-caption2 text-foreground/45">
            {text("assets.summary", { total: summary.total, mounted: summary.mounted })}
          </p>
          {items?.map((item) => {
            const key = `${item.assetKind}:${item.assetId}`;
            const isOwnProjectAsset = item.visibility === "in-project";
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
                  <button
                    type="button"
                    disabled={busy === key}
                    onClick={() => void toggleMount(item)}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-lg px-2 py-1 text-ios-caption1 font-medium disabled:opacity-50",
                      item.mounted
                        ? "bg-ios-green/10 text-[#248A3D] hover:bg-ios-green/20"
                        : "bg-black/5 text-muted-foreground hover:bg-black/10",
                    )}
                  >
                    {busy === key ? text("assets.mount.busy") : item.mounted ? text("assets.mount.release") : text("assets.mount.mount")}
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === key}
                    onClick={() => void changeScope(item, !isOwnProjectAsset)}
                    className="cursor-pointer rounded-lg bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground hover:bg-black/10 disabled:opacity-50"
                  >
                    {isOwnProjectAsset ? text("assets.scope.toPersonal") : text("assets.scope.toProject")}
                  </button>
                  {isOwnProjectAsset && (
                    <>
                      <input
                        value={shareTarget}
                        onChange={(e) => setShareTarget(e.target.value)}
                        placeholder={text("assets.share.targetPlaceholder")}
                        className="min-w-0 flex-1 rounded-lg bg-black/5 px-2 py-0.5 text-ios-caption2 text-foreground outline-none placeholder:text-foreground/35"
                      />
                      <button
                        type="button"
                        disabled={busy === key || !shareTarget.trim()}
                        onClick={() => void share(item)}
                        className="shrink-0 cursor-pointer rounded-lg bg-black/5 px-1.5 py-0.5 text-ios-caption2 font-medium text-[#007AFF] hover:bg-black/10 disabled:opacity-40"
                      >
                        {text("assets.share.action")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
