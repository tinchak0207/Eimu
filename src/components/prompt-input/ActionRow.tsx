"use client";

import { useMemo } from "react";
import { ArrowUpRight, Bot, ChevronLeft, Pencil, X, ZoomIn } from "lucide-react";
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
  isProfessionalMode: boolean;
  onToggleProfessionalMode: () => void;
  /** 父层 handlePrimaryAction 原名下發：generate/edit/upscale 三模式共用一颗 CTA。 */
  handlePrimaryAction: () => void;
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
 * 已套用风格 pill、专业控制 toggle、CTA。agent 面整排换成极简返回条。
 * 不参与模式切换动画，始终原地不动（高度差由控件区 flex-1 吸收）。
 */
export function ActionRow({
  displayMode,
  mode,
  onModeChange,
  fillAvailableHeight,
  stylePreset,
  handleStyleChange,
  isProfessionalMode,
  onToggleProfessionalMode,
  handlePrimaryAction,
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

  return (
    <>
        {displayMode === "agent" ? (
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onModeChange("generate")}
              title="返回生成模式"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-3.5 text-[13px] font-medium text-[rgba(0,0,0,0.55)] transition-all duration-200 hover:bg-[rgba(0,0,0,0.08)] hover:text-[rgba(0,0,0,0.75)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />返回生成
            </button>
            <span className="text-ios-caption1 text-foreground/45">改图 / 放大请先返回生成模式</span>
          </div>
        ) : (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4",
            fillAvailableHeight && "border-t border-[rgba(0,0,0,0.06)] pt-3 pb-[env(safe-area-inset-bottom,12px)]",
          )}
        >
          {/* 改图 / 放大 快捷入口 — 左侧，专业控制 toggle 左边 */}
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

          {/* 专业模式 toggle switch（agent 面不需要：工作站态已由 rails/面板承载切换，
              摆在这里会和 composer 抢底部空间；agent 態整排已被上面的三元換成返回條） */}
          <button
            type="button"
            onClick={onToggleProfessionalMode}
            aria-pressed={isProfessionalMode}
            title="打开专业工作站：多图队列、局部要求、项目信息"
            className={cn(
              "pro-mode-toggle self-start sm:ml-auto",
              isProfessionalMode && "active",
            )}
          >
            <span className="pro-mode-toggle-track" aria-hidden="true">
              <span className="pro-mode-toggle-thumb" />
            </span>
            <span className="pro-mode-toggle-label">专业控制</span>
          </button>

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
        </div>
        )}
    </>
  );
}
