"use client";

import { useMemo } from "react";
import { ArrowUpRight, Bot, Pencil, X, ZoomIn } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { STYLE_PRESETS, type StylePreset } from "@/lib/prompt-enhancer";
import { cn } from "@/lib/utils";
import type { PromptInputMode } from "@/components/PromptInput";
import type { PixaiStage } from "@/components/prompt-input/use-pixai-tools-panel";

interface ActionRowProps {
  displayMode: PromptInputMode;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  fillAvailableHeight: boolean;
  stylePreset: StylePreset;
  /** 父层 handleStyleChange 原名下發：清除已套用风格走同一条写入路径。 */
  handleStyleChange: (preset: StylePreset) => void;
  /** 父层 handlePrimaryAction 原名下發：generate/edit/upscale 三模式共用一颗 CTA。 */
  handlePrimaryAction: () => void;
  /** 生成中的人工终止回调（generate 模式 isLoading 时显示「停止」次级按钮）。 */
  onCancelGenerate?: () => void;
  primaryDisabled: boolean | undefined;
  isLoading?: boolean;
  isVideo: boolean;
  editBusy: boolean;
  editStage: PixaiStage;
  upscaleBusy: boolean;
  upscaleStage: PixaiStage;
}

/**
 * 底部動作列（Task 9 自 PromptInput 抽出）：改图/放大/AI 助理三颗同语法 toggle、
 * 已套用风格 pill、CTA。agent 面无底行：收起/返回由聊天面
 * Header 的 onExit 按钮承担。
 * 不参与模式切换动画，始终原地不动（高度差由控件区 flex-1 吸收）。
 */
export function ActionRow({
  displayMode,
  mode,
  onModeChange,
  fillAvailableHeight,
  stylePreset,
  handleStyleChange,
  handlePrimaryAction,
  onCancelGenerate,
  primaryDisabled,
  isLoading,
  isVideo,
  editBusy,
  editStage,
  upscaleBusy,
  upscaleStage,
}: ActionRowProps) {
  const activeStyle = useMemo(
    () => STYLE_PRESETS.find((preset) => preset.key === stylePreset),
    [stylePreset],
  );

  // 2026-08-25 用户裁定：agent 面的「返回生成」底行是废层——聊天面 Header 已有
  // onExit 收起按钮做同一件事。这里直接不渲染，省下的高度由聊天区 flex-1 吃掉。
  if (displayMode === "agent") return null;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4",
        fillAvailableHeight && "border-t border-[rgba(0,0,0,0.06)] pt-3 pb-[env(safe-area-inset-bottom,12px)]",
      )}
    >
          {/* 改图 / 放大 快捷入口 — 左侧 */}
          <div className="flex items-center gap-1.5 shrink-0 self-start">
            <button
              type="button"
              onClick={() => onModeChange(mode === "edit" ? "generate" : "edit")}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "edit"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <Pencil className="h-3 w-3" />改图
            </button>
            <button
              type="button"
              onClick={() => onModeChange(mode === "upscale" ? "generate" : "upscale")}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "upscale"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <ZoomIn className="h-3 w-3" />放大
            </button>
            {/* Agent 入口（D-1 / D-24 状态B）：与改图、放大**完全同一颗按钮的语法**
                ——同样的 toggle、同样的选中态、同样只换中间控件区。
                D-24 状态B 写的是「改图/放大入口旁常驻可开关」，
                所以它没有自己的常亮蓝底，未选中时和邻居一样是灰的。
                承接半句话（D-24）由 initialPrompt 负责，不用重打一遍。 */}
            <button
              type="button"
              onClick={() => onModeChange(mode === "agent" ? "generate" : "agent")}
              aria-pressed={mode === "agent"}
              title="交给 AI 助理：说一句话，它自动选模型、风格、比例并出图"
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "agent"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <Bot className="h-3 w-3" />AI 助理
            </button>
          </div>

          {activeStyle ? (
            <div className="lg-tint-blue inline-flex h-9 min-w-0 max-w-full shrink-0 items-center gap-1 self-start rounded-full pl-3.5 pr-1 text-ios-footnote font-medium text-[#007AFF]">
              <span className="truncate">已套用 {activeStyle.label}</span>
              <button
                type="button"
                onClick={() => handleStyleChange("none")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full lg-transition hover:bg-[rgba(0,122,255,0.14)] cursor-pointer"
                aria-label={`清除${activeStyle.label}风格`}
                title="清除风格"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* Single CTA — elevated blue, strong shadow, scale on hover。
              改图／放大模式下，同一颗按钮承担对应动作。
              agent 模式下这颗按钮**不存在**：送出由聊天区自己的输入区负责，
              这里再摆一颗「开始创作」会有两个送出口，按哪个都说不清。 */}
          <button
            type="button"
            onClick={handlePrimaryAction}
            disabled={primaryDisabled}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-6 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.40),0_2px_8px_rgba(0,122,255,0.24)] transition-all duration-200 hover:bg-[#0066DD] hover:shadow-[0_10px_32px_rgba(0,122,255,0.52),0_4px_12px_rgba(0,122,255,0.30)] hover:scale-[1.025] active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none disabled:scale-100 cursor-pointer sm:w-auto"
          >
            {displayMode === "edit" ? (
              editBusy ? (
                <><Spinner className="h-4 w-4 text-white" />{editStage === "uploading" ? "上传中" : "改图中"}</>
              ) : (
                <><Pencil className="h-4 w-4" />开始改图<ArrowUpRight className="h-4 w-4" /></>
              )
            ) : displayMode === "upscale" ? (
              upscaleBusy ? (
                <><Spinner className="h-4 w-4 text-white" />{upscaleStage === "uploading" ? "上传中" : "放大中"}</>
              ) : (
                <><ZoomIn className="h-4 w-4" />开始放大<ArrowUpRight className="h-4 w-4" /></>
              )
            ) : (
              isLoading ? (
                <><Spinner className="h-4 w-4 text-white" />正在生成</>
              ) : (
                <>{isVideo ? "生成视频" : "开始创作"}<ArrowUpRight className="h-4 w-4" /></>
              )
            )}
          </button>
          {/* 人工终止：生成中在 CTA 旁提供可点的「停止」次级按钮
              （样式照抄本文件改图/放大入口的次级 pill class）。 */}
          {displayMode === "generate" && isLoading && onCancelGenerate ? (
            <button
              type="button"
              onClick={onCancelGenerate}
              className="inline-flex h-11 cursor-pointer shrink-0 items-center justify-center rounded-full px-5 text-[13px] font-medium transition-all duration-200 bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
            >
              停止
            </button>
          ) : null}
        </div>
  );
}
