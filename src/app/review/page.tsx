"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  LayoutGrid,
  Rows3,
  Star,
} from "lucide-react";
import {
  type BoardFolder,
  type SavedShotMeta,
  getShotBlob,
  listBoards,
  listShots,
} from "@/lib/boards-store";
import {
  composeReviewPanes,
  groupReviewSections,
  type ReviewPane,
} from "@/lib/review-assembler";
import { cn } from "@/lib/utils";

/**
 * 审查页：选一个画布项目（board），把它的全部镜头合成单页审查。
 *
 * 数据 owner 是 src/lib/boards-store.ts（idb 客户端存储），本页只读
 * （listBoards / listShots / getShotBlob），不建第二存储。面板模型由
 * src/lib/review-assembler.ts 纯函数组装；hash 深链 #pane-<slug> 与
 * 左侧导航双向同步（history.replaceState，不产生历史记录）。
 */

type LayoutMode = "single" | "all";

const ALL_BOARDS = "all";

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function MetadataChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="lg-float inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] leading-none">
      <span className="text-[rgba(0,0,0,0.44)]">{label}</span>
      <span className="font-medium text-[rgba(0,0,0,0.72)]">{value}</span>
    </span>
  );
}

function PaneCard({
  pane,
  imageUrl,
  expanded,
}: {
  pane: ReviewPane;
  imageUrl: string | undefined;
  expanded: boolean;
}) {
  const { metadata } = pane;
  return (
    <article
      id={pane.anchorId}
      className="lg-card relative overflow-hidden p-5 sm:p-6 scroll-mt-28"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
      <header className="mb-4 flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-lg font-semibold leading-snug text-foreground">
          <span className="mr-2 align-middle text-[13px] font-medium tracking-[0.18em] text-[#7b8694]">
            镜头
          </span>
          <span className="align-middle break-words">{pane.title}</span>
        </h2>
        {pane.starred ? (
          <Star
            className="mt-1 h-4 w-4 shrink-0 fill-[#FFB300] text-[#FFB300]"
            aria-label="已收藏"
          />
        ) : null}
      </header>
      <div className="flex justify-center rounded-[1.35rem] bg-[rgba(255,255,255,0.42)] p-3">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={pane.title}
            className={cn(
              "h-auto w-auto max-w-full rounded-[0.9rem] object-contain",
              expanded ? "max-h-[520px]" : "max-h-[62vh]",
            )}
          />
        ) : (
          <div className="flex h-48 w-full items-center justify-center rounded-[0.9rem] text-sm text-[#6e7886]">
            图片加载中…
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <MetadataChip label="模型" value={metadata.modelId ?? "—"} />
        <MetadataChip label="渠道" value={metadata.endpointLabel ?? "—"} />
        {metadata.presetLabel ? (
          <MetadataChip label="预设" value={metadata.presetLabel} />
        ) : null}
        {metadata.imageSize ? (
          <MetadataChip label="尺寸" value={metadata.imageSize} />
        ) : null}
        <MetadataChip label="生成时间" value={formatDateTime(pane.createdAt)} />
      </div>
    </article>
  );
}

export default function ReviewPage() {
  const [boards, setBoards] = useState<BoardFolder[]>([]);
  const [shots, setShots] = useState<SavedShotMeta[]>([]);
  const [boardId, setBoardId] = useState<string>(ALL_BOARDS);
  const [ready, setReady] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("single");
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const shotUrlsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [boardList, shotList] = await Promise.all([listBoards(), listShots()]);
      if (cancelled) return;
      setBoards(boardList);
      setShots(shotList);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleShots = useMemo(
    () => shots.filter((shot) => boardId === ALL_BOARDS || shot.boardId === boardId),
    [shots, boardId],
  );

  const panes = useMemo(() => composeReviewPanes(visibleShots), [visibleShots]);
  const sections = useMemo(() => groupReviewSections(panes), [panes]);

  // hash 深链：#pane-<slug> 直达某个面板，hashchange 也跟随（含浏览器前进后退）。
  const applyHash = useCallback(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#pane-")) return;
    const anchorId = hash.slice(1);
    setActiveAnchor((current) => (current === anchorId ? current : anchorId));
    const target = document.getElementById(anchorId);
    if (target) target.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [applyHash]);

  // 面板集变化后校准激活面板：默认第一个；深链 hash 先于异步数据到达，
  // 所以这里以 hash 为最高优先级，hash 指向的锚点不存在时才回退。
  useEffect(() => {
    setActiveAnchor((current) => {
      if (panes.length === 0) return null;
      const hashAnchor = window.location.hash.startsWith("#pane-")
        ? window.location.hash.slice(1)
        : null;
      if (hashAnchor && panes.some((pane) => pane.anchorId === hashAnchor)) {
        return hashAnchor;
      }
      if (current && panes.some((pane) => pane.anchorId === current)) return current;
      return panes[0].anchorId;
    });
  }, [panes]);

  // 深链首滚：面板是异步加载后才渲染的，浏览器不会自动滚到 hash 目标，
  // 首次拿到面板集合后补一次滚动（只做一次，避免和用户滚动打架）。
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (panes.length === 0 || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    const hashAnchor = window.location.hash.startsWith("#pane-")
      ? window.location.hash.slice(1)
      : null;
    if (!hashAnchor) return;
    const target = document.getElementById(hashAnchor);
    if (target) target.scrollIntoView({ block: "start" });
  }, [panes]);

  // 点击导航：切面板并同步 hash（replaceState 不产生历史记录）。
  const selectPane = useCallback(
    (anchorId: string, scroll: boolean) => {
      setActiveAnchor(anchorId);
      window.history.replaceState(null, "", window.location.pathname + "#" + anchorId);
      if (scroll) {
        const target = document.getElementById(anchorId);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    },
    [],
  );

  const activeIndex = panes.findIndex((pane) => pane.anchorId === activeAnchor);
  const activePane = activeIndex >= 0 ? panes[activeIndex] : undefined;

  const stepPane = useCallback(
    (delta: number) => {
      if (panes.length === 0 || activeIndex < 0) return;
      const next = (activeIndex + delta + panes.length) % panes.length;
      selectPane(panes[next].anchorId, false);
    },
    [panes, activeIndex, selectPane],
  );

  // 缩略图：并行读 IndexedDB blob → objectURL；集合变化时回收旧 URL。
  const visibleKey = useMemo(
    () => visibleShots.map((shot) => shot.id).join("|"),
    [visibleShots],
  );
  useEffect(() => {
    let cancelled = false;
    const ids = visibleKey === "" ? [] : visibleKey.split("|");
    if (ids.length === 0) {
      setShotUrls({});
      return;
    }
    (async () => {
      const entries = (
        await Promise.all(
          ids.map(async (id) => {
            const blob = await getShotBlob(id);
            return blob ? ([id, URL.createObjectURL(blob)] as const) : null;
          }),
        )
      ).filter((entry): entry is readonly [string, string] => !!entry);
      if (cancelled) {
        entries.forEach(([, url]) => URL.revokeObjectURL(url));
        return;
      }
      setShotUrls((prev) => {
        const next = Object.fromEntries(entries);
        for (const [id, url] of Object.entries(prev)) {
          if (!(id in next)) URL.revokeObjectURL(url);
        }
        shotUrlsRef.current = next;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleKey]);

  // 卸载时回收全部 objectURL。
  useEffect(() => {
    const urlsRef = shotUrlsRef;
    return () => {
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
    };
  }, []);

  const boardLabel =
    boardId === ALL_BOARDS
      ? "全部项目"
      : (boards.find((board) => board.id === boardId)?.name ?? "项目");

  return (
    <div className="min-h-screen bg-transparent px-4 pb-28 pt-20 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1660px]">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.18em] text-[#7b8694]">REVIEW</p>
            <h1 className="mt-1 text-lg font-semibold text-foreground">审查页 · {boardLabel}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="lg-float flex items-center gap-2 rounded-[1.35rem] px-3 py-2 text-[13px]">
              <Clapperboard
                className="h-3.5 w-3.5 shrink-0 text-[rgba(0,0,0,0.44)]"
                aria-hidden="true"
              />
              <span className="text-[rgba(0,0,0,0.44)]">项目</span>
              <select
                value={boardId}
                onChange={(event) => setBoardId(event.target.value)}
                className="max-w-[180px] cursor-pointer bg-transparent text-[13px] font-medium text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                aria-label="选择画布项目"
              >
                <option value={ALL_BOARDS}>全部项目</option>
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setLayoutMode((mode) => (mode === "single" ? "all" : "single"))}
              className="lg-float inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium text-[rgba(0,0,0,0.72)] transition-all duration-200 hover:-translate-y-[1px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
              aria-pressed={layoutMode === "all"}
            >
              {layoutMode === "all" ? (
                <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {layoutMode === "all" ? "单页逐张" : "平铺全部"}
            </button>
          </div>
        </div>

        {!ready ? (
          <div className="lg-card flex items-center justify-center p-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[rgba(0,122,255,0.20)] border-t-[#007AFF]" />
          </div>
        ) : boards.length === 0 ? (
          <div className="lg-card relative overflow-hidden p-10 text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
            <p className="text-lg font-semibold text-foreground">还没有画布项目</p>
            <p className="mt-2 text-sm text-[#6e7886]">
              先到工作台生成并存入项目，再来这里逐张审查成片。
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center rounded-full bg-[#2d3142] px-5 py-3.5 text-sm font-medium text-white shadow-[0_18px_36px_rgba(45,49,66,0.12)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(45,49,66,0.35)]"
            >
              回到工作台
            </Link>
          </div>
        ) : panes.length === 0 ? (
          <div className="lg-card relative overflow-hidden p-10 text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
            <p className="text-lg font-semibold text-foreground">这个项目还没有镜头</p>
            <p className="mt-2 text-sm text-[#6e7886]">生成并保存成片后，会出现在这里。</p>
          </div>
        ) : (
          <div className="flex items-start gap-6">
            {/* 左侧 sticky 导航（桌面） */}
            <nav
              aria-label="镜头导航"
              className="sticky top-24 hidden w-64 shrink-0 lg:block"
            >
              <div className="lg-card relative max-h-[calc(100vh-8.5rem)] overflow-y-auto p-4">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
                {sections.map((section) => (
                  <div key={section.key} className="mb-4 last:mb-0">
                    <p className="mb-2 px-2 text-[11px] font-medium tracking-[0.18em] text-[#7b8694]">
                      {section.label}
                    </p>
                    <ul className="space-y-1">
                      {section.panes.map((pane) => (
                        <li key={pane.anchorId}>
                          <button
                            type="button"
                            onClick={() => selectPane(pane.anchorId, layoutMode === "all")}
                            className={cn(
                              "w-full cursor-pointer rounded-[0.9rem] px-3 py-2 text-left text-[13px] leading-snug transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
                              activeAnchor === pane.anchorId
                                ? "lg-fill-active font-medium text-[rgba(0,0,0,0.85)]"
                                : "text-[rgba(0,0,0,0.58)] hover:bg-[rgba(255,255,255,0.55)] hover:text-[rgba(0,0,0,0.80)]",
                            )}
                          >
                            <span className="block truncate">{pane.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </nav>

            {/* 移动端：横向面板条 */}
            {layoutMode === "single" ? (
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="镜头导航">
                {panes.map((pane) => (
                  <button
                    key={pane.anchorId}
                    type="button"
                    onClick={() => selectPane(pane.anchorId, false)}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-full px-3.5 py-2 text-[13px] leading-none transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
                      activeAnchor === pane.anchorId
                        ? "lg-fill-active font-medium text-[rgba(0,0,0,0.85)]"
                        : "lg-float text-[rgba(0,0,0,0.58)]",
                    )}
                  >
                    <span className="block max-w-[140px] truncate">{pane.title}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {/* 右侧内容区 */}
            <div className="min-w-0 flex-1">
              {layoutMode === "single" && activePane ? (
                <div>
                  <PaneCard pane={activePane} imageUrl={shotUrls[activePane.shotId]} expanded={false} />
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => stepPane(-1)}
                      disabled={panes.length <= 1}
                      className="lg-float inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-medium text-[rgba(0,0,0,0.72)] transition-all duration-200 hover:-translate-y-[1px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      上一张
                    </button>
                    <p className="text-[13px] text-[#6e7886]" aria-live="polite">
                      {activeIndex + 1} / {panes.length}
                    </p>
                    <button
                      type="button"
                      onClick={() => stepPane(1)}
                      disabled={panes.length <= 1}
                      className="lg-float inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-medium text-[rgba(0,0,0,0.72)] transition-all duration-200 hover:-translate-y-[1px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                    >
                      下一张
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {panes.map((pane) => (
                    <PaneCard
                      key={pane.anchorId}
                      pane={pane}
                      imageUrl={shotUrls[pane.shotId]}
                      expanded
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
