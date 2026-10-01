"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowUpRight, RotateCcw, Search, Star } from "lucide-react";
import {
  CREATOR_RESOURCES,
  type CreatorResource,
  type CreatorResourceModelId,
} from "@/lib/creator-resource-library";
import { SCENARIO_TEMPLATES, type ScenarioTemplate } from "@/lib/scenario-templates";
import {
  KUNPENG_STYLE_ASSETS,
  KUNPENG_STYLE_CATEGORY_LABELS,
  KUNPENG_SOURCE,
  kunpengStyleSummary,
  type KunpengStyleAsset,
} from "@/lib/kunpeng-style-assets";
import {
  KUNPENG_PROMPT_TEMPLATES,
  type KunpengPromptTemplate,
} from "@/lib/kunpeng-prompt-templates";
import { cn } from "@/lib/utils";

type TemplateFilter = "all" | "scenario" | CreatorResourceModelId | "kunpeng-style" | "kunpeng-prompt";
type CreativeTemplate =
  | { kind: "scenario"; key: string; scenario: ScenarioTemplate }
  | { kind: "resource"; key: string; resource: CreatorResource }
  | { kind: "kunpeng-style"; key: string; style: KunpengStyleAsset }
  | { kind: "kunpeng-prompt"; key: string; template: KunpengPromptTemplate };

const TEMPLATE_FILTERS: Array<{ id: TemplateFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "scenario", label: "场景" },
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana Pro" },
  { id: "kunpeng-style", label: "风格库" },
  { id: "kunpeng-prompt", label: "提示词模板" },
];

function templateTitle(template: CreativeTemplate) {
  switch (template.kind) {
    case "scenario":
      return template.scenario.name;
    case "resource":
      return template.resource.title;
    case "kunpeng-style":
      return template.style.name;
    case "kunpeng-prompt":
      return template.template.title;
  }
}

function templateDescription(template: CreativeTemplate) {
  switch (template.kind) {
    case "scenario":
      return template.scenario.description;
    case "resource":
      return template.resource.description;
    case "kunpeng-style":
      return kunpengStyleSummary(template.style);
    case "kunpeng-prompt":
      return template.template.description;
  }
}

function templateSearchText(template: CreativeTemplate) {
  switch (template.kind) {
    case "scenario":
      return `${template.scenario.name} ${template.scenario.description} 场景`;
    case "resource":
      return `${template.resource.title} ${template.resource.category} ${template.resource.description} ${template.resource.useWhen}`;
    case "kunpeng-style":
      return `${template.style.name} ${KUNPENG_STYLE_CATEGORY_LABELS[template.style.category] ?? template.style.category} ${template.style.promptSuffix} ${template.style.visualDNA}`;
    case "kunpeng-prompt":
      return `${template.template.title} ${template.template.description} ${template.template.body}`;
  }
}

function templateChanges(template: CreativeTemplate) {
  switch (template.kind) {
    case "scenario":
      return ["项目上下文", "避免内容", "风格", "尺寸", "质量", "数量"];
    case "resource":
      return ["模型", "画面描述", "避免内容", "尺寸", "数量"];
    case "kunpeng-style":
      return ["画面描述（追加风格块）"];
    case "kunpeng-prompt":
      return ["画面描述（注入模板骨架）"];
  }
}

/** 场景、模型配方与鲲鹏资产共享一个入口，套用动作仍由父组件统一修改工作站状态。 */
const CreatorResourcePanel = memo(function CreatorResourcePanel({
  onApplyResource,
  onApplyScenario,
  onApplyKunpengStyle,
  onApplyKunpengPromptTemplate,
  undoLabel,
  onUndo,
}: {
  onApplyResource: (resource: CreatorResource) => void;
  onApplyScenario: (scenario: ScenarioTemplate) => void;
  onApplyKunpengStyle: (style: KunpengStyleAsset) => void;
  onApplyKunpengPromptTemplate: (template: KunpengPromptTemplate) => void;
  undoLabel?: string;
  onUndo: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TemplateFilter>("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [pending, setPending] = useState<CreativeTemplate | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("creator-resource-favorites");
      const resourceIds = stored ? JSON.parse(stored) : [];
      if (Array.isArray(resourceIds)) setFavorites(resourceIds.filter((id): id is string => typeof id === "string"));
    } catch {
      setFavorites([]);
    }
  }, []);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      window.localStorage.setItem("creator-resource-favorites", JSON.stringify(next));
      return next;
    });
  }, []);

  const templates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const scenarios: CreativeTemplate[] = SCENARIO_TEMPLATES.map((scenario) => ({
      kind: "scenario",
      key: `scenario:${scenario.id}`,
      scenario,
    }));
    const resources: CreativeTemplate[] = CREATOR_RESOURCES.map((resource) => ({
      kind: "resource",
      key: `resource:${resource.id}`,
      resource,
    }));
    const kunpengStyles: CreativeTemplate[] = KUNPENG_STYLE_ASSETS.map((style) => ({
      kind: "kunpeng-style",
      key: `kunpeng-style:${style.id}`,
      style,
    }));
    const kunpengPrompts: CreativeTemplate[] = KUNPENG_PROMPT_TEMPLATES.map((template) => ({
      kind: "kunpeng-prompt",
      key: `kunpeng-prompt:${template.id}`,
      template,
    }));
    return [...scenarios, ...resources, ...kunpengStyles, ...kunpengPrompts]
      .filter((template) => {
        const matchesFilter = filter === "all"
          || (filter === "scenario" && template.kind === "scenario")
          || (template.kind === "resource" && template.resource.modelId === filter)
          || (filter === "kunpeng-style" && template.kind === "kunpeng-style")
          || (filter === "kunpeng-prompt" && template.kind === "kunpeng-prompt");
        return matchesFilter && (!normalizedQuery || templateSearchText(template).toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => Number(favorites.includes(right.key)) - Number(favorites.includes(left.key)));
  }, [favorites, filter, query]);

  const confirmApply = () => {
    if (!pending) return;
    switch (pending.kind) {
      case "scenario":
        onApplyScenario(pending.scenario);
        break;
      case "resource":
        onApplyResource(pending.resource);
        break;
      case "kunpeng-style":
        onApplyKunpengStyle(pending.style);
        break;
      case "kunpeng-prompt":
        onApplyKunpengPromptTemplate(pending.template);
        break;
    }
    setPending(null);
  };

  return (
    <div className="pro-resource-library">
      <div className="pro-resource-toolbar">
        <label className="pro-resource-search">
          <Search className="h-3.5 w-3.5" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索创作模板" aria-label="搜索创作模板" />
        </label>
        <div className="pro-resource-filter" role="group" aria-label="模板筛选">
          {TEMPLATE_FILTERS.map((item) => (
            <button key={item.id} type="button" className={cn(filter === item.id && "is-active")} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {pending && (
        <div className="pro-template-confirm" role="alert" aria-live="polite">
          <div>
            <span>确认套用</span>
            <strong>{templateTitle(pending)}</strong>
          </div>
          <p>将替换以下字段：</p>
          <div className="pro-template-impact">
            {templateChanges(pending).map((change) => <span key={change}>{change}</span>)}
          </div>
          <div className="pro-template-confirm-actions">
            <button type="button" onClick={() => setPending(null)}>取消</button>
            <button type="button" className="is-primary" onClick={confirmApply}>确认套用</button>
          </div>
        </div>
      )}

      {!pending && undoLabel && (
        <button type="button" className="pro-template-undo" onClick={onUndo}>
          <RotateCcw className="h-3.5 w-3.5" />
          撤销“{undoLabel}”
        </button>
      )}

      <div className="pro-resource-list">
        {templates.map((template) => {
          const isScenario = template.kind === "scenario";
          const isKunpeng = template.kind === "kunpeng-style" || template.kind === "kunpeng-prompt";
          const title = templateTitle(template);
          const description = templateDescription(template);
          const resource = template.kind === "resource" ? template.resource : null;
          const kunpengCategory = template.kind === "kunpeng-style"
            ? (KUNPENG_STYLE_CATEGORY_LABELS[template.style.category] ?? template.style.category)
            : template.kind === "kunpeng-prompt" ? "提示词骨架" : null;
          return (
            <article key={template.key} className="pro-resource-card">
              <div className="pro-resource-card-head">
                <span className={cn(
                  "pro-resource-model",
                  isScenario && "is-scenario",
                  isKunpeng && "is-scenario",
                  resource?.modelId === "gemini-3.1-flash-image" && "is-nano",
                )}>
                  {isScenario ? "场景模板" : isKunpeng ? "鲲鹏资产" : resource?.modelLabel}
                </span>
                <div className="pro-resource-card-actions">
                  <span className="pro-resource-category">{isScenario ? "完整配置" : kunpengCategory ?? resource?.category}</span>
                  <button
                    type="button"
                    className={cn("pro-resource-favorite", favorites.includes(template.key) && "is-active")}
                    onClick={() => toggleFavorite(template.key)}
                    aria-label={favorites.includes(template.key) ? `取消收藏 ${title}` : `收藏 ${title}`}
                    title={favorites.includes(template.key) ? "取消收藏" : "收藏"}
                  >
                    <Star className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                </div>
              </div>
              {resource?.previewImageUrl && (
                <Image
                  className="pro-resource-preview"
                  src={resource.previewImageUrl}
                  alt={`${title} 效果预览`}
                  width={680}
                  height={396}
                  sizes="(max-width: 1023px) 100vw, 280px"
                />
              )}
              <h4>{title}</h4>
              <p>{description}</p>
              <small>
                {isScenario
                  ? "自动配置风格、尺寸、质量与避免内容"
                  : template.kind === "kunpeng-style"
                    ? `${kunpengCategory} · 套用后追加到画面描述末尾`
                    : template.kind === "kunpeng-prompt"
                      ? "套用后注入模板骨架，替换花括号内容即可"
                      : resource?.useWhen}
              </small>
              <div className="pro-resource-card-footer">
                {resource ? (
                  <a href={resource.sourceUrl} target="_blank" rel="noreferrer" title={`${resource.sourceName} · ${resource.license}`}>
                    GitHub · {resource.license}<ArrowUpRight className="h-3 w-3" />
                  </a>
                ) : isKunpeng ? (
                  <a href={KUNPENG_SOURCE.sourceUrl} target="_blank" rel="noreferrer" title={`${KUNPENG_SOURCE.sourceName} · ${KUNPENG_SOURCE.license}`}>
                    GitHub · {KUNPENG_SOURCE.license}<ArrowUpRight className="h-3 w-3" />
                  </a>
                ) : <span className="pro-template-source">内置场景</span>}
                <button type="button" onClick={() => setPending(template)}>套用</button>
              </div>
            </article>
          );
        })}
        {!templates.length && <p className="pro-resource-empty">没有匹配的模板</p>}
      </div>
    </div>
  );
});

export default CreatorResourcePanel;
