"use client";

import { RefreshCw, Volume2, VolumeX } from "lucide-react";
import { StylePresets } from "@/components/StylePresets";
import { ModelPicker } from "@/components/ModelPicker";
import type { Suggestion } from "@/lib/suggestions";
import type { StylePreset } from "@/lib/prompt-enhancer";
import {
  generationCoins,
  generationModel,
  modelAspectRatios,
  modelDurations,
  modelResolutions,
  modelSupportsAudio,
  resolutionLabel,
  type AspectRatio,
  type ModelUsageTipParams,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { cn } from "@/lib/utils";
import { LABEL_CLASS, RAIL_CLASS, ROW_CLASS } from "@/components/prompt-input/rail-classes";

interface GenerateControlsProps {
  suggestions: Suggestion[];
  /** 父层 handler 原名下發（契约测试逐名断言，不得改名）。 */
  handleSuggestionSelect: (prompt: string) => void;
  updateSuggestions: () => void;
  models: string[];
  modelId: string;
  onModelChange: (modelId: string) => void;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  outputResolution: OutputResolution;
  onOutputResolutionChange: (resolution: OutputResolution) => void;
  durationSeconds?: number;
  onDurationChange: (duration: number) => void;
  generateAudio: boolean;
  onGenerateAudioChange: (enabled: boolean) => void;
  stylePreset: StylePreset;
  handleStyleChange: (preset: StylePreset) => void;
  onToggleProfessionalMode: () => void;
}

/**
 * generate 面設定 rails（Task 9 自 PromptInput 抽出）：示例／模型／比例／畫質／
 * 時長／音訊／風格七行。純 props 驅動；能力派生值（比例/畫質/時長/音訊）由
 * modelId 就地計算。DOM 結構與原內聯 JSX 完全一致（高度鎖測量不受影響）。
 */
export function GenerateControls({
  suggestions,
  handleSuggestionSelect,
  updateSuggestions,
  models,
  modelId,
  onModelChange,
  aspectRatio,
  onAspectRatioChange,
  outputResolution,
  onOutputResolutionChange,
  durationSeconds,
  onDurationChange,
  generateAudio,
  onGenerateAudioChange,
  stylePreset,
  handleStyleChange,
  onToggleProfessionalMode,
}: GenerateControlsProps) {
  const aspectRatios = modelAspectRatios(modelId);
  const resolutions = modelResolutions(modelId);
  const durations = modelDurations(modelId);
  const isVideo = generationModel(modelId)?.kind === "video";
  const supportsAudio = modelSupportsAudio(modelId);

  return (
    <>
              {/* ── 示例：紧跟描述框，因为它填的就是上面这个框 ── */}
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>示例</span>
                <div className={RAIL_CLASS}>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.text}
                      type="button"
                      onClick={() => handleSuggestionSelect(suggestion.prompt)}
                      title={suggestion.prompt}
                      className="style-chip"
                    >
                      {suggestion.text}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={updateSuggestions}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.72)] cursor-pointer"
                  aria-label="换一批示例"
                  title="换一批示例"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* ── 生成设置：模型 + 比例 + 清晰度 + 时长 + 风格，同一套胶囊语言。
                  与上方「写什么」的分组靠留白完成，不画分隔线——线只会加重分割感。 ── */}
              <div className="space-y-2.5 pt-1">
                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>模型</span>
                  <div className={RAIL_CLASS}>
                    <ModelPicker
                      models={models}
                      value={modelId}
                      onChange={onModelChange}
                      resolution={outputResolution}
                      durationSeconds={durationSeconds}
                      generateAudio={generateAudio}
                      onOpenProfessionalMode={onToggleProfessionalMode}
                      onApplyTipParams={(params: ModelUsageTipParams) => {
                        // 模型卡「一键带入」：建议参数回填本面板既有 setter。
                        if (params.aspectRatio) onAspectRatioChange(params.aspectRatio);
                        if (params.outputResolution) onOutputResolutionChange(params.outputResolution);
                        if (params.durationSeconds != null) onDurationChange(params.durationSeconds);
                        if (params.generateAudio != null) onGenerateAudioChange(params.generateAudio);
                      }}
                    />
                  </div>
                </div>

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>比例</span>
                  <div className={RAIL_CLASS}>
                    {aspectRatios.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => onAspectRatioChange(ratio)}
                        className={cn("style-chip", aspectRatio === ratio && "active")}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>画质</span>
                  <div className={RAIL_CLASS}>
                    {resolutions.map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        onClick={() => onOutputResolutionChange(resolution)}
                        className={cn("style-chip gap-1.5", outputResolution === resolution && "active")}
                      >
                        {resolutionLabel(resolution)}
                        <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                          · {generationCoins(modelId, { resolution, durationSeconds, generateAudio })} 币/张
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {isVideo && durations.length > 0 ? (
                  <div className={ROW_CLASS}>
                    <span className={LABEL_CLASS}>时长</span>
                    <div className={RAIL_CLASS}>
                      {durations.map((duration) => (
                        <button
                          key={duration}
                          type="button"
                          onClick={() => onDurationChange(duration)}
                          className={cn("style-chip gap-1.5", durationSeconds === duration && "active")}
                        >
                          {duration} 秒
                          <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                            {generationCoins(modelId, {
                              resolution: outputResolution,
                              durationSeconds: duration,
                              generateAudio,
                            })} 币
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {isVideo && supportsAudio ? (
                  <div className={ROW_CLASS}>
                    <span className={LABEL_CLASS}>音讯</span>
                    <div className={RAIL_CLASS}>
                      <button
                        type="button"
                        onClick={() => onGenerateAudioChange(!generateAudio)}
                        aria-pressed={generateAudio}
                        aria-label={generateAudio ? "关闭生成音讯" : "开启生成音讯"}
                        title={generateAudio ? "关闭生成音讯" : "开启生成音讯"}
                        className={cn("style-chip gap-1.5", generateAudio && "active")}
                      >
                        {generateAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                        生成音讯
                        <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                          {generationCoins(modelId, {
                            resolution: outputResolution,
                            durationSeconds,
                            generateAudio,
                          })} 币
                        </span>
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>风格</span>
                  {/* 无「默认」胶囊：全部未高亮即默认态。多一颗胶囊会把这一行挤到
                      换行，而清除入口已由下方「已套用 ✕」和再点一次选中项承担。 */}
                  <div className={RAIL_CLASS}>
                    <StylePresets value={stylePreset} onChange={handleStyleChange} inline />
                  </div>
                </div>
              </div>
    </>
  );
}
