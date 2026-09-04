"use client";

/**
 * 配方模板区（吞併决策主线一第三件）：内置模板 chips + 我的模板列表。
 * 2026-08-27 自 pro-workstation/RecipeTemplateSection.tsx 逐檔複製遷入 canvas-
 * workstation（專業工作站入口移除）；交互逻辑、确认卡、模板摊开路径一行不改。
 *
 * 模板不是黑盒封装：点击 chip 先出确认卡（确认卡先行，列出将被替换的字段），
 * 确认后六槽摊开进表单可改。内置模板与用户模板走同一条 applyRecipeTemplate
 * 路径 —— 官方发的和用户捕获的都是「配方」，功能平等。
 */

import { memo, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_RECIPE_TEMPLATES, type RecipeTemplate } from "@/lib/recipe-templates";
import type { UserRecipeTemplateItem } from "./use-recipe-templates";

interface PendingTemplate {
  label: string;
  note: string;
  config: UserRecipeTemplateItem["config"];
  origin: "builtin" | "user";
}

/** 模板会替换的字段（确认卡如实列出，UI 宣称匹配真实能力）。 */
function templateImpactFields(config: UserRecipeTemplateItem["config"]): string[] {
  const fields: string[] = ["画面描述"];
  if (config.contextPrompt) fields.push("项目与品牌");
  if (config.regionalPrompts?.length || config.imageSize || config.imageSizes?.length) fields.push("构图与尺寸");
  if (config.negativePrompt) fields.push("避免内容");
  if (config.styleTemplate !== undefined) fields.push("风格");
  if (config.qualityProfile) fields.push("质量档");
  if (config.modelId) fields.push("模型");
  return fields;
}

export const RecipeTemplateSection = memo(function RecipeTemplateSection({
  isLoggedIn,
  userTemplates,
  userTemplatesLoading,
  onApplyTemplate,
  onDeleteUserTemplate,
}: {
  isLoggedIn: boolean;
  userTemplates: UserRecipeTemplateItem[];
  userTemplatesLoading: boolean;
  onApplyTemplate: (config: UserRecipeTemplateItem["config"], label: string) => void;
  onDeleteUserTemplate: (id: string) => void;
}) {
  const [pending, setPending] = useState<PendingTemplate | null>(null);

  const pickBuiltin = (template: RecipeTemplate) => {
    const config = { prompt: template.slots.prompt } as UserRecipeTemplateItem["config"];
    if (template.slots.contextPrompt) config.contextPrompt = template.slots.contextPrompt;
    if (template.slots.negativePrompt) config.negativePrompt = template.slots.negativePrompt;
    if (template.slots.composition?.length) {
      config.regionalPrompts = template.slots.composition.map((text) => ({ text }));
    }
    if (template.slots.styleTemplateId) config.styleTemplate = template.slots.styleTemplateId;
    else config.styleTemplate = ""; // 显式声明「风格槽=空」，套用时清空当前风格
    if (template.slots.qualityProfile) config.qualityProfile = template.slots.qualityProfile;
    setPending({ label: template.name, note: template.note, config, origin: "builtin" });
  };

  const pickUser = (item: UserRecipeTemplateItem) => {
    setPending({
      label: item.name,
      note: "你从一次出图捕获的配方，六槽原样摊开。",
      config: item.config,
      origin: "user",
    });
  };

  const confirmApply = () => {
    if (!pending) return;
    onApplyTemplate(pending.config, pending.label);
    setPending(null);
  };

  return (
    <div className="pro-recipe-templates">
      <p className="pro-section-note">点击即把六槽配方摊开进表单，可改可撤销，不会直接生成。</p>

      <div className="pro-chip-row" role="group" aria-label="内置配方模板">
        {BUILT_IN_RECIPE_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            title={template.note}
            onClick={() => pickBuiltin(template)}
          >
            {template.name}
          </button>
        ))}
      </div>

      {pending && (
        <div className="pro-template-confirm" role="alert" aria-live="polite">
          <div>
            <span>确认套用模板</span>
            <strong>{pending.label}</strong>
          </div>
          <p>{pending.note}</p>
          <p>套用后会替换以下字段（套用后每一槽都可以改）：</p>
          <div className="pro-template-impact">
            {templateImpactFields(pending.config).map((field) => <span key={field}>{field}</span>)}
          </div>
          <div className="pro-template-confirm-actions">
            <button type="button" onClick={() => setPending(null)}>取消</button>
            <button type="button" className="is-primary" onClick={confirmApply}>确认套用</button>
          </div>
        </div>
      )}

      <div className="pro-recipe-my-templates">
        <div className="pro-requirement-heading">
          <span>我的模板</span>
          {userTemplates.length > 0 && <em>{userTemplates.length}</em>}
        </div>
        {!isLoggedIn && (
          <p className="pro-resource-empty">登录后即可保存配方模板。</p>
        )}
        {isLoggedIn && userTemplatesLoading && (
          <p className="pro-resource-empty">
            <Loader2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
            正在加载我的模板…
          </p>
        )}
        {isLoggedIn && !userTemplatesLoading && userTemplates.length === 0 && (
          <p className="pro-resource-empty">还没有保存的模板。</p>
        )}
        {userTemplates.map((item) => (
          <div key={item.id} className={cn("pro-recipe-template-row", pending?.label === item.name && "is-active")}>
            <button
              type="button"
              className="pro-recipe-template-load"
              onClick={() => pickUser(item)}
              title="把这份配方摊开进表单"
            >
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.name}</span>
              <small className="shrink-0">{new Date(item.updatedAt).toLocaleDateString()}</small>
            </button>
            <button
              type="button"
              className="pro-recipe-template-delete"
              onClick={() => onDeleteUserTemplate(item.id)}
              aria-label={`删除模板 ${item.name}`}
              title="删除这个模板"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
});

export default RecipeTemplateSection;
