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
import { cn } from "@/lib/utils";

type TemplateFilter = "all" | "scenario" | CreatorResourceModelId;
type CreativeTemplate =
  | { kind: "scenario"; key: string; scenario: ScenarioTemplate }
  | { kind: "resource"; key: string; resource: CreatorResource };

const TEMPLATE_FILTERS: Array<{ id: TemplateFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "scenario", label: "场景" },
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana Pro" },
];

function templateTitle(template: CreativeTemplate) {
  return template.kind === "scenario" ? template.scenario.name : template.resource.title;
}

function templateDescription(template: CreativeTemplate) {
  return template.kind === "scenario" ? template.scenario.description : template.resource.description;
}

function templateSearchText(template: CreativeTemplate) {
  if (template.kind === "scenario") {
    return `${template.scenario.name} ${template.scenario.description} 场景`;
  }
  return `${template.resource.title} ${template.resource.category} ${template.resource.description} ${template.resource.useWhen}`;
}

function templateChanges(template: CreativeTemplate) {
  return template.kind === "scenario"
    ? ["项目上下文", "避免内容", "风格", "尺寸", "质量", "数量"]
    : ["模型", "画面描述", "避免内容", "尺寸", "数量"];
}

/** 场景与模型配方共享一个入口，套用动作仍由父组件统一修改工作站状态。 */
const CreatorResourcePanel = memo(function CreatorResourcePanel({
  onApplyResource,
  onApplyScenario,
  undoLabel,
  onUndo,
}: {
  onApplyResource: (resource: CreatorResource) => void;
  onApplyScenario: (scenario: ScenarioTemplate) => void;
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
    return [...scenarios, ...resources]
      .filter((template) => {
        const matchesFilter = filter === "all"
          || (filter === "scenario" && template.kind === "scenario")
          || (template.kind === "resource" && template.resource.modelId === filter);
        return matchesFilter && (!normalizedQuery || templateSearchText(template).toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => Number(favorites.includes(right.key)) - Number(favorites.includes(left.key)));
  }, [favorites, filter, query]);

  const confirmApply = () => {
    if (!pending) return;
    if (pending.kind === "scenario") onApplyScenario(pending.scenario);
    else onApplyResource(pending.resource);
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
          const title = templateTitle(template);
          const description = templateDescription(template);
          const resource = template.kind === "resource" ? template.resource : null;
          return (
            <article key={template.key} className="pro-resource-card">
              <div className="pro-resource-card-head">
                <span className={cn(
                  "pro-resource-model",
                  isScenario && "is-scenario",
                  resource?.modelId === "gemini-3.1-flash-image" && "is-nano",
                )}>
                  {isScenario ? "场景模板" : resource?.modelLabel}
                </span>
                <div className="pro-resource-card-actions">
                  <span className="pro-resource-category">{isScenario ? "完整配置" : resource?.category}</span>
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
              <small>{isScenario ? "自动配置风格、尺寸、质量与避免内容" : resource?.useWhen}</small>
              <div className="pro-resource-card-footer">
                {resource ? (
                  <a href={resource.sourceUrl} target="_blank" rel="noreferrer" title={`${resource.sourceName} · ${resource.license}`}>
                    GitHub · {resource.license}<ArrowUpRight className="h-3 w-3" />
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
