/**
 * 产线落地页汇总（/workflows 与 /workflows/<slug>）。
 *
 * 顺序跟随 AGENT_TEMPLATES（小说 → 电商 → 短剧 → 艺术）。每页的卡面资料
 * （名称/环节/展示媒体）由 getWorkflowCard 从 agent-templates 取，
 * 本目录只放落地页文案。模组载入时校验环节数与 slug，漂移直接拋错。
 */

import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import type { WorkflowPage } from "./types";
import { artCurationSeriesPage } from "./art-curation-series";
import { artStyleImmersionPage } from "./art-style-immersion";
import { ecommerceLaunchPackPage } from "./ecommerce-launch-pack";
import { ecommerceModelGridPage } from "./ecommerce-model-grid";
import { novelFilmPipelinePage } from "./novel-film-pipeline";
import { novelIpVisualPackPage } from "./novel-ip-visual-pack";
import { shortdramaPosterLinePage } from "./shortdrama-poster-line";
import { shortdramaVisualAssetsPage } from "./shortdrama-visual-assets";

export type {
  WorkflowPage,
  WorkflowStepDetail,
  WorkflowFaq,
  WorkflowSaving,
  WorkflowRelatedHub,
} from "./types";

const PAGE_BY_SLUG: Record<string, WorkflowPage> = Object.fromEntries(
  [
    novelFilmPipelinePage,
    novelIpVisualPackPage,
    ecommerceLaunchPackPage,
    ecommerceModelGridPage,
    shortdramaVisualAssetsPage,
    shortdramaPosterLinePage,
    artCurationSeriesPage,
    artStyleImmersionPage,
  ].map((page) => [page.slug, page]),
);

/** agent-templates 的 id 形如 `agent-<slug>`。 */
export function workflowSlugOf(card: AgentTemplate): string {
  return card.id.replace(/^agent-/, "");
}

export function getWorkflowCard(slug: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((card) => workflowSlugOf(card) === slug);
}

export const WORKFLOW_PAGES: WorkflowPage[] = AGENT_TEMPLATES.map((card) => {
  const slug = workflowSlugOf(card);
  const page = PAGE_BY_SLUG[slug];
  if (!page) throw new Error(`[workflow-pages] 缺少落地页文案：${slug}`);
  if (page.steps.length !== card.pipeline.steps.length) {
    throw new Error(
      `[workflow-pages] ${slug} 环节数漂移：文案 ${page.steps.length} 步，卡面 ${card.pipeline.steps.length} 步`,
    );
  }
  for (const related of page.relatedWorkflows) {
    if (!PAGE_BY_SLUG[related]) throw new Error(`[workflow-pages] ${slug} 的相关产线不存在：${related}`);
  }
  return page;
});

export function getWorkflowPage(slug: string): WorkflowPage | undefined {
  return WORKFLOW_PAGES.find((page) => page.slug === slug);
}
