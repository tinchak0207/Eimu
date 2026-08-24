"use client";

import { memo } from "react";
import { Images, LayoutTemplate, Library, Palette, Plus, SlidersHorizontal, Sparkles, Wand2 } from "lucide-react";
import { ReferenceImageUpload } from "@/components/ReferenceImageUpload";
import { cn } from "@/lib/utils";
import type { BrandKit } from "@/lib/brand-kit";
import { hasBrandKit } from "@/lib/brand-kit";
import type { ScenarioTemplate } from "@/lib/scenario-templates";
import type { CreatorResource } from "@/lib/creator-resource-library";
import type { StyleTemplate } from "@/lib/style-library";
import type { ReferenceImage } from "@/lib/image-types";
import type { RegionalPromptItem, NoticeLevel, LeftPanelTab } from "../workstation-constants";
import { CREATIVE_TEMPLATE_COUNT } from "../workstation-constants";
import { CreatorResourcePanel, TemplatePanel, StyleGrid } from "../workstation-subcomponents";
import { RecipeTemplateSection } from "../RecipeTemplateSection";
import type { UserRecipeTemplateItem } from "../use-recipe-templates";
import type { WorkflowRecallConfig } from "@/lib/workflow-recall";

export interface LeftPromptTabProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  referenceImages: ReferenceImage[];
  onReferenceImagesChange: (images: ReferenceImage[]) => void;
  onWorkflowDetected: (workflowJson: string) => void;
  promptStats: { chars: number; estimatedTokens: number; state: string };
  onSetLeftPanelTab: (tab: LeftPanelTab) => void;
  sectionOpen: Record<string, boolean>;
  toggleSection: (key: string, open: boolean) => void;
  onApplyResource: (resource: CreatorResource) => void;
  onApplyScenario: (scenario: ScenarioTemplate) => void;
  /** 配方模板（六槽具名 profile）：确认卡先行，套用后摊开可改。 */
  isLoggedIn: boolean;
  userRecipeTemplates: UserRecipeTemplateItem[];
  userRecipeTemplatesLoading: boolean;
  onApplyRecipeTemplate: (config: WorkflowRecallConfig & { modelId?: string }, label: string) => void;
  onDeleteUserRecipeTemplate: (id: string) => void;
  templateUndoLabel: string | undefined;
  onUndo: () => void;
  token: string | null;
  onTemplateResult?: (resultUrl: string) => void;
  setCanvasNotice: (text: string, level?: NoticeLevel) => void;
  styleCategory: string;
  onStyleCategoryChange: (category: string) => void;
  styleTemplateId: string | null;
  onToggleStyle: (id: string) => void;
  activeStyle: StyleTemplate | undefined;
  onClearStyle: () => void;
  contextPrompt: string;
  onContextPromptChange: (value: string) => void;
  negativePrompt: string;
  onNegativePromptChange: (value: string) => void;
  regionalPrompts: RegionalPromptItem[];
  onAddRegionalPrompt: (initialText?: string) => void;
  onUpdateRegionalPrompt: (id: string, patch: Partial<RegionalPromptItem>) => void;
  onRemoveRegionalPrompt: (id: string) => void;
  activeRegionalPrompts: Array<{ id: string; text: string; enabled: boolean }>;
  brandKit: BrandKit;
  onBrandKitChange: React.Dispatch<React.SetStateAction<BrandKit>>;
  onSaveBrandKit: () => void;
  onClearBrandKit: () => void;
  brandKitMessage: string;
}

/**
 * 左栏「提示词」tab（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 画面描述 / 创作模板 / 配方模板 / 模板出图 / 风格 / 更多要求六个手风琴；纯 props 驱动。
 */
export const LeftPromptTab = memo(function LeftPromptTab({
  prompt,
  onPromptChange,
  referenceImages,
  onReferenceImagesChange,
  onWorkflowDetected,
  promptStats,
  onSetLeftPanelTab,
  sectionOpen,
  toggleSection,
  onApplyResource,
  onApplyScenario,
  isLoggedIn,
  userRecipeTemplates,
  userRecipeTemplatesLoading,
  onApplyRecipeTemplate,
  onDeleteUserRecipeTemplate,
  templateUndoLabel,
  onUndo,
  token,
  onTemplateResult,
  setCanvasNotice,
  styleCategory,
  onStyleCategoryChange,
  styleTemplateId,
  onToggleStyle,
  activeStyle,
  onClearStyle,
  contextPrompt,
  onContextPromptChange,
  negativePrompt,
  onNegativePromptChange,
  regionalPrompts,
  onAddRegionalPrompt,
  onUpdateRegionalPrompt,
  onRemoveRegionalPrompt,
  activeRegionalPrompts,
  brandKit,
  onBrandKitChange,
  onSaveBrandKit,
  onClearBrandKit,
  brandKitMessage,
}: LeftPromptTabProps) {
  return (
    <div
      className="pro-panel-stack"
      role="tabpanel"
      id="pro-left-panel-prompt"
      aria-labelledby="pro-left-tab-prompt"
    >
      <div className="pro-accordion" id="pro-tour-prompt">
        <span className="pro-panel-title">
          <Sparkles className="h-4 w-4" />
          画面描述
          <button type="button" className="pro-inline-panel-link" onClick={() => onSetLeftPanelTab("assets")}>
            <Images className="h-3.5 w-3.5" />
            参考图
            <em>{referenceImages.length}</em>
          </button>
        </span>
        <div className="relative">
          {/*
            id 必须留在这块「画面描述」上：`/` 热键与空态 CTA 都是
            document.querySelector("#pro-prompt-input").focus()，旧版这个 id 挂在
            下面折叠起来的「补充说明」里 —— 按 `/` 会展开一个用户没想写的框，
            真正要写的主输入框反而没拿到焦点。
            resize-y + 200px 起高：一段完整的商品描述在 128px 里只能看到 4 行。
          */}
          <textarea
            id="pro-prompt-input"
            aria-label="画面描述"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder="例如：奶白色护肤精华放在哑光石台上，柔和晨光，背景虚化。"
            className="min-h-[200px] w-full resize-y rounded-ios-2xl border-0 bg-white/40 px-3.5 py-3 pb-12 text-ios-footnote text-foreground outline-none ring-0 transition-all focus:bg-white/65 focus:ring-2 focus:ring-ios-blue/20"
          />
          <ReferenceImageUpload variant="prompt" value={referenceImages} onChange={onReferenceImagesChange} onWorkflowDetected={onWorkflowDetected} />
        </div>
        <div className="pro-prompt-meter">
          {promptStats.chars ? (
            <>
              <span>{promptStats.chars} 字</span>
              <strong>{promptStats.state}</strong>
            </>
          ) : (
            <span>尚未输入</span>
          )}
        </div>
      </div>

      <details
        className="pro-accordion"
        id="pro-tour-resources"
        open={sectionOpen.resources}
        onToggle={(event) => toggleSection("resources", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <Library className="h-4 w-4" />
            创作模板
            <em className="pro-title-count">{CREATIVE_TEMPLATE_COUNT}</em>
          </span>
        </summary>
        <p className="pro-section-note">场景与模型配方统一管理；套用前会列出被替换的字段。</p>
        <CreatorResourcePanel
          onApplyResource={onApplyResource}
          onApplyScenario={onApplyScenario}
          undoLabel={templateUndoLabel}
          onUndo={onUndo}
        />
      </details>

      {/*
        配方模板（六槽具名 profile）：点击先出确认卡，套用后六槽摊开在
        画面描述/更多要求里可改 —— 模板不是黑盒，是「填进表单的一组值」。
      */}
      <details
        className="pro-accordion"
        open={sectionOpen.recipeTemplates}
        onToggle={(event) => toggleSection("recipeTemplates", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <LayoutTemplate className="h-4 w-4" />
            配方模板
            {userRecipeTemplates.length > 0 && <em className="pro-title-count">{userRecipeTemplates.length}</em>}
          </span>
        </summary>
        <RecipeTemplateSection
          isLoggedIn={isLoggedIn}
          userTemplates={userRecipeTemplates}
          userTemplatesLoading={userRecipeTemplatesLoading}
          onApplyTemplate={onApplyRecipeTemplate}
          onDeleteUserTemplate={onDeleteUserRecipeTemplate}
        />
      </details>

      {/*
        服务端配方（/v1/templates）：选好就直接提交，走自己的计价与队列，
        不经过左栏的提示词与运行条。上面那节是「填进当前表单」，这节是「直接出图」，
        两者的区别写在小字里，避免用户以为重复。
      */}
      <details
        className="pro-accordion"
        open={sectionOpen.presets}
        onToggle={(event) => toggleSection("presets", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <Wand2 className="h-4 w-4" />
            模板出图
          </span>
        </summary>
        <p className="pro-section-note">选好配方直接提交，独立计价，不改动当前表单。</p>
        <TemplatePanel
          token={token}
          onSubmit={(config, resultUrl) => {
            if (resultUrl) onTemplateResult?.(resultUrl);
            else setCanvasNotice("模板生成已提交；结果稍后出现在成片墙。", "info");
          }}
        />
      </details>

      <details
        className="pro-accordion"
        open={sectionOpen.style}
        onToggle={(event) => toggleSection("style", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <Palette className="h-4 w-4" />
            风格
            {activeStyle && <em className="pro-title-count">{activeStyle.name}</em>}
          </span>
        </summary>
        <p className="pro-section-note">选择风格后，生成时会加入对应提示词。</p>
        <StyleGrid
          category={styleCategory}
          selectedId={styleTemplateId}
          onCategoryChange={onStyleCategoryChange}
          onToggle={onToggleStyle}
        />
        {activeStyle && (
          <button type="button" onClick={onClearStyle} className="pro-add-row-button">
            取消风格「{activeStyle.name}」
          </button>
        )}
      </details>

      <details
        className="pro-accordion pro-collapsed-mobile"
        open={sectionOpen.more}
        onToggle={(event) => toggleSection("more", event.currentTarget.open)}
      >
        <summary>
          <span className="pro-panel-title">
            <SlidersHorizontal className="h-4 w-4" />
            更多要求
            {(activeRegionalPrompts.length > 0 || contextPrompt.trim() || negativePrompt.trim() || hasBrandKit(brandKit)) && (
              <em className="pro-title-count">已设置</em>
            )}
          </span>
        </summary>
        <p className="pro-section-note">仅在需要精细控制时填写；留空不会影响生成。</p>

        <section className="pro-requirement-group">
          <div className="pro-requirement-heading">
            <span>构图要求</span>
            {activeRegionalPrompts.length > 0 && <em>{activeRegionalPrompts.length}</em>}
          </div>
          <p>补充留白、位置或主体大小，不模拟不存在的区域蒙版。</p>
          <div className="pro-regional-list">
            {regionalPrompts.map((item) => (
              <div key={item.id} className={cn("pro-regional-row", !item.enabled && "is-muted")}>
                <button
                  type="button"
                  onClick={() => onUpdateRegionalPrompt(item.id, { enabled: !item.enabled })}
                  className={cn("pro-layer-toggle", item.enabled && "is-active")}
                  title={item.enabled ? "停用这条要求（不发送）" : "启用这条要求"}
                  aria-label={item.enabled ? "停用这条要求" : "启用这条要求"}
                />
                <input
                  value={item.text}
                  onChange={(event) => onUpdateRegionalPrompt(item.id, { text: event.target.value })}
                  placeholder="例如：左上角留出干净的文案空间"
                  className="w-full rounded-ios-xl border-0 bg-white/40 px-2.5 py-1.5 text-ios-caption2 font-semibold text-muted-foreground outline-none transition-all focus:bg-white/60 focus:ring-2 focus:ring-ios-blue/15"
                />
                <button type="button" onClick={() => onRemoveRegionalPrompt(item.id)} className="pro-layer-remove">移除</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => onAddRegionalPrompt()} className="pro-add-row-button">
            <Plus className="h-3 w-3" />
            添加构图要求
          </button>
        </section>

        <section className="pro-requirement-group">
          <div className="pro-requirement-heading">
            <span>项目与品牌</span>
            {hasBrandKit(brandKit) && <em>已保存</em>}
          </div>
          <textarea
            id="pro-context-input"
            value={contextPrompt}
            onChange={(event) => onContextPromptChange(event.target.value)}
            placeholder="项目背景、受众、投放渠道或画面限制"
            className="min-h-[88px] w-full resize-none rounded-ios-2xl border-0 bg-white/40 px-3.5 py-3 text-ios-footnote text-muted-foreground outline-none ring-0 transition-all focus:bg-white/60 focus:ring-2 focus:ring-ios-blue/15"
          />
          <div className="pro-brand-form">
            <input value={brandKit.brandName} onChange={(event) => onBrandKitChange((current) => ({ ...current, brandName: event.target.value }))} placeholder="品牌名称" />
            <input value={brandKit.colors} onChange={(event) => onBrandKitChange((current) => ({ ...current, colors: event.target.value }))} placeholder="品牌主色" />
            <input value={brandKit.tone} onChange={(event) => onBrandKitChange((current) => ({ ...current, tone: event.target.value }))} placeholder="品牌语气" />
            <input value={brandKit.bannedWords} onChange={(event) => onBrandKitChange((current) => ({ ...current, bannedWords: event.target.value }))} placeholder="品牌禁用元素" />
          </div>
          <div className="pro-requirement-actions">
            <button type="button" onClick={onSaveBrandKit}>保存品牌</button>
            <button type="button" onClick={onClearBrandKit}>清空</button>
          </div>
          {brandKitMessage && <p className="pro-requirement-message">{brandKitMessage}</p>}
        </section>

        <section className="pro-requirement-group">
          <div className="pro-requirement-heading"><span>避免内容</span></div>
          <textarea
            value={negativePrompt}
            onChange={(event) => onNegativePromptChange(event.target.value)}
            placeholder="例如：水印、畸形手指、文字乱码、低清晰度"
            className="min-h-[80px] w-full resize-none rounded-ios-2xl border-0 bg-white/40 px-3.5 py-3 text-ios-footnote text-muted-foreground outline-none ring-0 transition-all focus:bg-white/60 focus:ring-2 focus:ring-ios-blue/15"
          />
        </section>
      </details>
    </div>
  );
});
