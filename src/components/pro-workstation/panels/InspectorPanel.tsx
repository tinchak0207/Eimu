"use client";

import { memo } from "react";
import { BookmarkPlus, Bot, ChevronLeft, ChevronRight, Clipboard, FileJson, FolderOpen, Gauge, Images, RotateCcw } from "lucide-react";
import { HistoryInspectorPanel } from "@/components/pro-workstation/HistoryInspectorPanel";
import { resultSrc } from "@/components/image-src";
import { cn } from "@/lib/utils";
import { formatPublicGenerationSummary } from "@/lib/public-generation-summary";
import type { ImageResult } from "@/lib/image-types";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import type { PersistedGenerationEntry } from "@/lib/generation-cache";
import type { HistoryEntry } from "@/lib/history-types";
import type { ReferenceImage } from "@/lib/image-types";
import type { NoticeLevel, InspectorTab, GalleryMode, SlotState } from "../workstation-constants";
import { INSPECTOR_TABS, REFERENCE_IMAGE_ROLES } from "../workstation-constants";
import type { SlotItemView } from "../workstation-subcomponents";
import { QueueSlotList } from "../workstation-subcomponents";

export interface InspectorPanelProps {
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  inspectorExpanded: boolean;
  setInspectorExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setLoraPanelOpen: (open: boolean) => void;
  activeInspectorTabHint: string;
  sectionOpen: Record<string, boolean>;
  toggleSection: (key: string, open: boolean) => void;
  /** 队列 tab：进度与计数。 */
  isLoading: boolean;
  runningSlots: number;
  runTotal: number;
  runSettled: number;
  runProgress: number;
  runEtaLabel: string | null;
  tasks: GenerationTaskProjection[];
  copies: number;
  completedSlots: number;
  failedSlots: number;
  slotItems: SlotItemView[];
  openTaskSlot: (slot: SlotItemView) => void;
  retrySlot: (slot: SlotItemView) => void;
  firstFailedTask: GenerationTaskProjection | undefined;
  retryTask: (task: GenerationTaskProjection) => void;
  run: (requestedCopies?: number) => void;
  failedSlotCount: number;
  /** 图库 tab。 */
  inspectorGalleryMode: GalleryMode;
  setInspectorGalleryMode: (mode: GalleryMode) => void;
  renderBoardsPanel: () => React.ReactNode;
  allResults: ImageResult[];
  selectedSlotId: string | null;
  activePresetLabel: string;
  referenceImages: ReferenceImage[];
  openResultOnCanvas: (image: ImageResult) => void;
  copyProvenanceConfig: (image?: ImageResult) => void;
  saveResultToBoard: (image: ImageResult) => void;
  /** 模板捕获器：把这张成片的配方存为我的模板（命名卡由工作台入口渲染）。 */
  onSaveAsTemplate: (image: ImageResult) => void;
  /** 历史 tab。 */
  restoreHistoryEntry: (entry: PersistedGenerationEntry) => void;
  useHistoryEntryAsReference: (entry: { results?: ReadonlyArray<{ image?: string | null; imageUrl?: string | null }> }) => void;
  recentWorkflows: PersistedGenerationEntry[];
  restoreConfigText: string;
  setRestoreConfigText: (text: string) => void;
  restoreProvenanceConfig: () => void;
  restoreConfigMessage: string;
  visibleResult: ImageResult | undefined;
}

/**
 * 右栏检查器：queue / gallery / history 三个 tab（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 整个 <aside class="pro-inspector"> 由本组件渲染；状态与 setter 全部由工作台入口传入。
 */
export const InspectorPanel = memo(function InspectorPanel({
  inspectorTab,
  setInspectorTab,
  inspectorExpanded,
  setInspectorExpanded,
  setLoraPanelOpen,
  activeInspectorTabHint,
  sectionOpen,
  toggleSection,
  isLoading,
  runningSlots,
  runTotal,
  runSettled,
  runProgress,
  runEtaLabel,
  tasks,
  copies,
  completedSlots,
  failedSlots,
  slotItems,
  openTaskSlot,
  retrySlot,
  firstFailedTask,
  retryTask,
  run,
  failedSlotCount,
  inspectorGalleryMode,
  setInspectorGalleryMode,
  renderBoardsPanel,
  allResults,
  selectedSlotId,
  activePresetLabel,
  referenceImages,
  openResultOnCanvas,
  copyProvenanceConfig,
  saveResultToBoard,
  onSaveAsTemplate,
  restoreHistoryEntry,
  useHistoryEntryAsReference,
  recentWorkflows,
  restoreConfigText,
  setRestoreConfigText,
  restoreProvenanceConfig,
  restoreConfigMessage,
  visibleResult,
}: InspectorPanelProps) {
  return (
    <aside className="pro-inspector pro-glass-panel">
      <div
        className="pro-inspector-tabs"
        id="pro-tour-inspector"
        role="tablist"
        aria-label="产出面板"
        aria-orientation="horizontal"
        onKeyDown={(event) => {
          const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!delta) return;
          event.preventDefault();
          const index = INSPECTOR_TABS.findIndex((tab) => tab.id === inspectorTab);
          const next = INSPECTOR_TABS[(index + delta + INSPECTOR_TABS.length) % INSPECTOR_TABS.length];
          setInspectorTab(next.id);
          setInspectorExpanded(true);
          requestAnimationFrame(() => document.getElementById(`pro-inspector-tab-${next.id}`)?.focus());
        }}
      >
        {INSPECTOR_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`pro-inspector-tab-${tab.id}`}
            aria-selected={inspectorTab === tab.id}
            aria-controls={`pro-inspector-panel-${tab.id}`}
            tabIndex={inspectorTab === tab.id ? 0 : -1}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => {
              // 再点一次当前 tab = 收起右栏，把宽度让给画布；这是唯一不需要额外控件的收放手势。
              if (inspectorTab === tab.id && inspectorExpanded) {
                setInspectorExpanded(false);
                return;
              }
              setInspectorTab(tab.id);
              setInspectorExpanded(true);
              setLoraPanelOpen(false);
            }}
            className={cn(inspectorTab === tab.id && "is-active")}
          >
            {tab.id === "queue" ? (
              <Gauge className="pro-inspector-tab-icon" aria-hidden="true" />
            ) : tab.id === "gallery" ? (
              <Images className="pro-inspector-tab-icon" aria-hidden="true" />
            ) : (
              <RotateCcw className="pro-inspector-tab-icon" aria-hidden="true" />
            )}
            <span className="pro-inspector-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
      {/*
        显式收放按钮。
        原本右栏只能靠「点左栏里任意按钮」这种隐式手势收起，用户根本猜不到；
        收起后也没有任何可见的把手能再展开。放在 tablist 外面，
        因为 role="tablist" 里不能塞非 tab 的按钮。
      */}
      <button
        type="button"
        className="pro-inspector-collapse"
        aria-expanded={inspectorExpanded}
        aria-label={inspectorExpanded ? "收起右栏" : "展开右栏"}
        title={inspectorExpanded ? "收起右栏" : "展开右栏"}
        onClick={() => setInspectorExpanded((current) => !current)}
      >
        {inspectorExpanded ? (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      <p className="pro-panel-hint">{activeInspectorTabHint}</p>

      {inspectorTab === "queue" && (
        <div
          className="pro-panel-stack"
          role="tabpanel"
          id="pro-inspector-panel-queue"
          aria-labelledby="pro-inspector-tab-queue"
        >
          <details
            className="pro-accordion"
            open={sectionOpen.queue}
            onToggle={(event) => toggleSection("queue", event.currentTarget.open)}
          >
            <summary>
              <span className="pro-panel-title">
                <Gauge className="h-4 w-4" />
                队列
              </span>
            </summary>
            {/*
              队列里也放一条进度：数字格子只说「进行中 3」，不说「3 还要多久」。
            */}
            {(isLoading || runningSlots > 0) && (
              <div className="pro-run-progress" role="status" aria-live="polite">
                <div
                  className="pro-run-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={runTotal}
                  aria-valuenow={runSettled}
                  aria-label="生成进度"
                >
                  <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
                </div>
                <p>
                  {runSettled} / {runTotal} 已落地
                  {runEtaLabel ? ` · 预计还需 ${runEtaLabel}` : ""}
                </p>
              </div>
            )}
            <div className="pro-metric-grid">
              <div className="pro-metric-card">
                <span>任务</span>
                <strong>{tasks.length || copies}</strong>
              </div>
              <div className="pro-metric-card">
                <span>进行中</span>
                <strong>{runningSlots}</strong>
              </div>
              <div className="pro-metric-card">
                <span>已完成</span>
                <strong>{completedSlots}</strong>
              </div>
              <div className="pro-metric-card">
                <span>失败</span>
                <strong>{failedSlots}</strong>
              </div>
            </div>
            <QueueSlotList slots={slotItems} onSelect={openTaskSlot} onRetry={retrySlot} />
            {/* 重试走失败任务自带的配置，与编辑器当前有没有提示词无关，所以不看 canRun */}
            <button
              type="button"
              onClick={() => firstFailedTask ? retryTask(firstFailedTask) : run(Math.max(1, failedSlotCount))}
              disabled={isLoading || failedSlotCount === 0}
              title={failedSlotCount ? `用当前配置重新生成 ${failedSlotCount} 个失败任务` : "没有失败任务"}
              className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-ios-xl bg-white/45 px-3 py-2 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/70 disabled:text-foreground/45"
            >
              <RotateCcw className="h-3 w-3" />
              重试失败任务
            </button>
          </details>

        </div>
      )}

      {inspectorTab === "gallery" && (
        <div
          className="pro-panel-stack"
          role="tabpanel"
          id="pro-inspector-panel-gallery"
          aria-labelledby="pro-inspector-tab-gallery"
        >
          <details
            className="pro-accordion"
            open={sectionOpen.gallery}
            onToggle={(event) => toggleSection("gallery", event.currentTarget.open)}
          >
            <summary>
              <span className="pro-panel-title">
                <Images className="h-4 w-4" />
                图库
              </span>
            </summary>
            <div className="pro-gallery-toolbar">
              <button type="button" onClick={() => setInspectorGalleryMode("images")} className={cn(inspectorGalleryMode === "images" && "is-active")}>
                成片
              </button>
              <button type="button" onClick={() => setInspectorGalleryMode("assets")} className={cn(inspectorGalleryMode === "assets" && "is-active")}>
                参考图
              </button>
              <button type="button" onClick={() => setInspectorGalleryMode("boards")} className={cn(inspectorGalleryMode === "boards" && "is-active")}>
                文件夹
              </button>
            </div>
            {inspectorGalleryMode === "boards" ? renderBoardsPanel() : (
            <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1">
              {inspectorGalleryMode === "images" && allResults.map((image, index) => (
                <div key={image.resultId ?? image.slotId ?? index} className={cn("pro-provenance-card", (image.resultId ?? image.slotId) === selectedSlotId && "is-selected")}>
                  <div className={cn("aspect-square overflow-hidden rounded-ios-xl bg-white/40", !image.image && !image.imageUrl && !image.videoUrl && "flex items-center justify-center")}>
                    {image.image || image.imageUrl || image.videoUrl ? (
                      image.mediaType === "video" && image.videoUrl ? (
                        <video src={image.videoUrl} muted playsInline className="h-full w-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={resultSrc(image)} alt="生成结果" className="h-full w-full object-cover" />
                      )
                    ) : (
                      <Bot className="h-5 w-5 text-foreground/45" />
                    )}
                  </div>
                  <div className="mt-2 space-y-1 text-ios-caption2 font-semibold text-foreground/45">
                    <div className="flex items-center gap-1">
                      <Clipboard className="h-3 w-3" />
                      <span className="truncate">生成信息</span>
                    </div>
                    <p className="truncate">{image.workflow?.workflowPresetLabel ?? activePresetLabel}</p>
                    <p className="truncate">{formatPublicGenerationSummary(image)}</p>
                    <p className="truncate">{image.referenceImageNames?.join("、") || "未使用参考图"}</p>
                    <div className="grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() => openResultOnCanvas(image)}
                        disabled={!image.image && !image.imageUrl && !image.videoUrl}
                        className="mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-white/45 px-2 py-1 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/70 disabled:text-foreground/45"
                      >
                        打开
                      </button>
                      <button
                        type="button"
                        onClick={() => copyProvenanceConfig(image)}
                        className="mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-white/45 px-2 py-1 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/70"
                      >
                        <Clipboard className="h-3 w-3" />
                        复制配置
                      </button>
                      <button
                        type="button"
                        onClick={() => saveResultToBoard(image)}
                        disabled={!image.image && !image.imageUrl && !image.videoUrl || image.mediaType === "video"}
                        title="保存到文件夹"
                        className="col-span-2 mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-white/45 px-2 py-1 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/70 disabled:text-foreground/45"
                      >
                        <FolderOpen className="h-3 w-3" />
                        存入文件夹
                      </button>
                      {/* 模板捕获器入口：任何一次成功出图都可沉淀为具名模板（玻璃 icon button） */}
                      <button
                        type="button"
                        onClick={() => onSaveAsTemplate(image)}
                        title="把这张成片的完整配方存为我的模板"
                        className="col-span-2 mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-white/45 px-2 py-1 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/70"
                      >
                        <BookmarkPlus className="h-3 w-3" />
                        存为模板
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {inspectorGalleryMode === "assets" && referenceImages.map((image) => (
                <div key={image.id} className="pro-provenance-card">
                  <div className="aspect-square overflow-hidden rounded-ios-xl bg-white/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
                  </div>
                  <div className="mt-2 space-y-1 text-ios-caption2 font-semibold text-foreground/45">
                    <p className="truncate">参考图</p>
                    <p className="truncate">{image.name}</p>
                    <p className="truncate">
                      {REFERENCE_IMAGE_ROLES.find((role) => role.id === (image.role ?? "general"))?.label} · 强度 {image.strength ?? 80}%
                    </p>
                  </div>
                </div>
              ))}
            </div>
            )}
            {((inspectorGalleryMode === "images" && allResults.length === 0) || (inspectorGalleryMode === "assets" && referenceImages.length === 0)) && (
              <div className="mt-2 rounded-ios-2xl bg-white/35 px-3 py-3 text-ios-caption2 font-medium leading-relaxed text-foreground/45">
                <RotateCcw className="mr-1.5 inline h-3 w-3" />
                {inspectorGalleryMode === "images" ? "生成后，这里会显示模型、参数和可导入配置。" : "添加参考图后，这里会显示素材。"}
              </div>
            )}
          </details>
        </div>
      )}

      {inspectorTab === "history" && (
        <div
          className="pro-panel-stack"
          role="tabpanel"
          id="pro-inspector-panel-history"
          aria-labelledby="pro-inspector-tab-history"
        >
          <details
            className="pro-accordion"
            open={sectionOpen.history}
            onToggle={(event) => toggleSection("history", event.currentTarget.open)}
          >
            <summary>
              <span className="pro-panel-title">
                <RotateCcw className="h-4 w-4" />
                最近任务
              </span>
            </summary>
            <p className="pro-section-note">点击记录，恢复当时的提示词和参数。</p>
            {/*
              历史面板订阅的是 /history 页同一个共享 store，
              所以在这里收藏一张图，已打开的历史页会立刻跟着变。
              restoreHistoryEntry 接受的 PersistedGenerationEntry 与统一模型
              HistoryEntry 字段兼容（后者多了 quota / starred / modelId 等可选项）。
            */}
            <HistoryInspectorPanel
              onRestore={restoreHistoryEntry}
              onUseAsReference={useHistoryEntryAsReference}
              fallbackEntries={recentWorkflows}
            />
          </details>

          <details
            className="pro-accordion"
            open={sectionOpen.recall}
            onToggle={(event) => toggleSection("recall", event.currentTarget.open)}
          >
            <summary>
              <span className="pro-panel-title">
                <FileJson className="h-4 w-4" />
                导入配置
              </span>
            </summary>
            <p className="pro-section-note">粘贴从“复制配置”得到的内容，恢复提示词和参数。</p>
            <textarea
              value={restoreConfigText}
              onChange={(event) => setRestoreConfigText(event.target.value)}
              placeholder='{"prompt": "...", "workflowPreset": "product-shot", ...}'
              className="min-h-[82px] w-full resize-none rounded-ios-2xl border-0 bg-white/40 px-3.5 py-3 text-ios-caption2 text-muted-foreground outline-none ring-0 transition-all focus:bg-white/60 focus:ring-2 focus:ring-ios-blue/15"
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={restoreProvenanceConfig}
                className="inline-flex items-center justify-center gap-1.5 rounded-ios-xl bg-white/50 px-3 py-2 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/75"
              >
                <FileJson className="h-3 w-3" />
                导入
              </button>
              <button
                type="button"
                onClick={() => copyProvenanceConfig(visibleResult)}
                className="inline-flex items-center justify-center gap-1.5 rounded-ios-xl bg-white/50 px-3 py-2 text-ios-caption2 font-bold text-muted-foreground transition-colors hover:bg-white/75"
              >
                <Clipboard className="h-3 w-3" />
                复制当前配置
              </button>
            </div>
            {restoreConfigMessage && (
              <p className="mt-2 truncate text-ios-caption2 font-semibold text-foreground/45">{restoreConfigMessage}</p>
            )}
          </details>
        </div>
      )}
    </aside>
  );
});
