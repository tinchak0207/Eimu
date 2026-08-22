"use client";

import { memo } from "react";
import { Gauge, Play, SlidersHorizontal, Sparkles } from "lucide-react";
import { LoraLibraryPanel, type SelectedLora } from "@/components/pro-workstation/LoraLibraryPanel";
import { defaultDuration, modelBaseName, modelDurations, modelSupportsAudio, generationModel } from "@/lib/generation-model-catalog";
import { cn } from "@/lib/utils";
import { PRODUCTION_INTENT_OPTIONS } from "../workstation-constants";

export interface LeftSettingsTabProps {
  modelId: string;
  isVideoModel: boolean;
  isPixaiModel: boolean;
  sectionOpen: Record<string, boolean>;
  toggleSection: (key: string, open: boolean) => void;
  sizeOptions: Array<{ id: string; label: string; usage: string }>;
  toggleImageSize: (id: string) => void;
  imageSizes: string[];
  durationSeconds: number | undefined;
  setDurationSeconds: (seconds: number) => void;
  generateAudio: boolean;
  setGenerateAudio: (enabled: boolean) => void;
  loraPanelOpen: boolean;
  setLoraPanelOpen: (open: boolean) => void;
  setInspectorExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  selectedLora: SelectedLora | null;
  setSelectedLora: React.Dispatch<React.SetStateAction<SelectedLora | null>>;
  qualityProfile: string;
  setQualityProfile: (profile: string) => void;
  qualityOptions: Array<{ id: string; label: string }>;
  productionIntent: string;
  setProductionIntent: (intent: string) => void;
  seedHint: string;
  setSeedHint: (hint: string) => void;
  copies: number;
  setCopies: (copies: number) => void;
  concurrency: number;
  setConcurrency: (concurrency: number) => void;
  runUnit: string;
  totalCoins: number;
  imageSizeLabel: string;
}

/**
 * 左栏「参数」tab（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 尺寸 / 视频时长音效 / LoRA / 质量 / 用途 / 批次备注 / 数量七个手风琴字段。
 */
export const LeftSettingsTab = memo(function LeftSettingsTab({
  modelId,
  isVideoModel,
  isPixaiModel,
  sectionOpen,
  toggleSection,
  sizeOptions,
  toggleImageSize,
  imageSizes,
  durationSeconds,
  setDurationSeconds,
  generateAudio,
  setGenerateAudio,
  loraPanelOpen,
  setLoraPanelOpen,
  setInspectorExpanded,
  selectedLora,
  setSelectedLora,
  qualityProfile,
  setQualityProfile,
  qualityOptions,
  productionIntent,
  setProductionIntent,
  seedHint,
  setSeedHint,
  copies,
  setCopies,
  concurrency,
  setConcurrency,
  runUnit,
  totalCoins,
  imageSizeLabel,
}: LeftSettingsTabProps) {
  return (
    <div
      className="pro-panel-stack"
      role="tabpanel"
      id="pro-left-panel-settings"
      aria-labelledby="pro-left-tab-settings"
    >
      <details
        className="pro-accordion"
        open={sectionOpen.size}
        onToggle={(event) => toggleSection("size", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <SlidersHorizontal className="h-4 w-4" />
            尺寸
          </span>
        </summary>
        <p className="pro-section-note">
          {isVideoModel
            ? `影片按模型默认画幅生成（${generationModel(modelId)?.aspectRatios.slice(0, 3).join(" / ")}）。`
            : "选择一个或多个版位。多选时，每张图会轮流使用不同尺寸。"}
        </p>
        {!isVideoModel && (
        <div className="pro-size-options">
          {sizeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => toggleImageSize(option.id)}
              className={cn(imageSizes.includes(option.id) && "is-active")}
              title={option.usage}
            >
              <strong>{option.label}</strong>
              <small>{option.usage}</small>
            </button>
          ))}
        </div>
        )}
        {/* 模型选择已上移到左栏常驻顶栏（.pro-model-row）：
            它决定了这一页每一个可选项，藏在第三个 tab 的手风琴里没有道理。
            这里不再放第二个 ModelPicker —— 两个实例共用 modelMenuOpen，
            会同时展开成两张下拉。 */}
        {isVideoModel && (
          <>
            {modelDurations(modelId).length > 0 && (
              <label className="pro-control-row">
                <span>时长</span>
                <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))}>
                  {modelDurations(modelId).map((seconds) => (
                    <option key={seconds} value={seconds}>{seconds} 秒</option>
                  ))}
                </select>
              </label>
            )}
            {modelSupportsAudio(modelId) && (
              <label className="pro-control-row">
                <span>音效</span>
                <select value={generateAudio ? "1" : "0"} onChange={(event) => setGenerateAudio(event.target.value === "1")}>
                  <option value="0">关闭</option>
                  <option value="1">开启</option>
                </select>
              </label>
            )}
          </>
        )}
        {isPixaiModel && (
          <details
            id="pro-tour-lora-section"
            className="pro-accordion pro-collapsed-mobile min-w-0 max-w-full overflow-hidden"
            open={loraPanelOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setLoraPanelOpen(open);
              if (open) setInspectorExpanded(false);
            }}
          >
            <summary>
              <span className="pro-panel-title">
                <Sparkles className="h-4 w-4" />
                LoRA 风格
                {selectedLora && <em className="pro-title-count">已选</em>}
              </span>
            </summary>
            <p className="pro-section-note">叠加 LoRA 模型改变画风。仅 PixAI 模型支持。</p>
            <LoraLibraryPanel value={selectedLora} onChange={setSelectedLora} />
          </details>
        )}
        <label className="pro-control-row">
          <span>质量</span>
          <select value={qualityProfile} onChange={(event) => setQualityProfile(event.target.value)}>
            {qualityOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="pro-control-row">
          <span>用途</span>
          <select value={productionIntent} onChange={(event) => setProductionIntent(event.target.value)}>
            {PRODUCTION_INTENT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        {/*
          这个字段从来不是「随机种子」。

          它最终只会作为 `Seed hint: xxx` 一行追加进提示词（见 generation-workflow
          的 buildWorkflowPromptSection），上游 API 根本没有暴露 seed 参数。
          旧版 placeholder 写「固定随机种子」——用户填了以为两次出图会一致，
          结果完全不同，只会怀疑是系统坏了。这里改成它真实的作用：批次备注。
        */}
        <label className="pro-control-row pro-control-row--stack">
          <span>批次备注</span>
          <input
            value={seedHint}
            onChange={(event) => setSeedHint(event.target.value)}
            placeholder="例如 618-主图-v3，会写入提示词便于复现"
          />
        </label>
        <p className="pro-section-note">备注会附在提示词末尾一起提交，方便日后按批次检索。上游模型不支持固定种子，两次生成不会完全一致。</p>
      </details>

      <details
        className="pro-accordion"
        open={sectionOpen.count}
        onToggle={(event) => toggleSection("count", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <Gauge className="h-4 w-4" />
            数量
          </span>
        </summary>
        <label className="pro-control-row pro-range-control">
          <span>张数</span>
          <input id="pro-copies" min={1} max={8} type="range" value={copies} aria-valuetext={`${copies} 张`} onChange={(event) => setCopies(Number(event.target.value))} />
          <output htmlFor="pro-copies">{copies} 张</output>
        </label>
        <label className="pro-control-row pro-range-control">
          <span>并行</span>
          <input id="pro-concurrency" min={1} max={4} type="range" value={concurrency} aria-valuetext={`${concurrency} 个任务`} onChange={(event) => setConcurrency(Number(event.target.value))} />
          <output htmlFor="pro-concurrency">{concurrency}</output>
        </label>
        <div className="mt-3 rounded-ios-2xl bg-white/40 px-3 py-2 text-ios-caption1 font-semibold text-muted-foreground">
          预计 {copies} {runUnit} · {totalCoins} 币 · {isVideoModel
            ? `${durationSeconds ?? defaultDuration(modelId)} 秒${generateAudio ? " · 含音效" : ""}`
            : imageSizeLabel}
        </div>
      </details>

    </div>
  );
});

export interface WorkstationRunBarProps {
  modelId: string;
  isVideoModel: boolean;
  durationSeconds: number | undefined;
  imageSizeLabel: string;
  copies: number;
  runUnit: string;
  totalCoins: number;
  handleRunClick: () => void;
  isLoading: boolean;
  canRun: boolean;
}

/**
 * 左栏底部运行条（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 与 LeftSettingsTab 同檔：原始行域 L2807-2994 到左栏末尾，运行条在其间；
 * 拆到本檔也保证了模块拼接序列中 run-bar 位于 prompt-input 之后。
 */
export const WorkstationRunBar = memo(function WorkstationRunBar({
  modelId,
  isVideoModel,
  durationSeconds,
  imageSizeLabel,
  copies,
  runUnit,
  totalCoins,
  handleRunClick,
  isLoading,
  canRun,
}: WorkstationRunBarProps) {
  return (
    <div className="pro-run-bar">
      <div className="pro-run-summary">
        <span>{modelBaseName(modelId)}</span>
        <span>{isVideoModel ? `${durationSeconds ?? defaultDuration(modelId)} 秒` : imageSizeLabel}</span>
        <span>{copies} {runUnit}</span>
        <strong>{totalCoins} 币</strong>
      </div>
      <button
        type="button"
        onClick={handleRunClick}
        aria-label={isLoading ? "正在生成" : `生成 ${copies} ${runUnit}`}
        title={canRun ? "生成（⌘ Enter）" : isLoading ? "正在生成" : "先写画面描述"}
        className="pro-run-primary"
        data-disabled={!canRun || undefined}
      >
        <Play className="h-4 w-4" />
        {isLoading ? (
          "正在生成…"
        ) : (
          <>
            生成
            {/* 张数与总币单独成节点：窄栏下先收这一段，「生成」二字永远留在按钮上 */}
            <span className="pro-run-count"> {copies} {runUnit} · {totalCoins} 币</span>
          </>
        )}
      </button>
    </div>
  );
});
