/**
 * 助理起手模板——執行 payload 入口（2026-09-12 首屏減重拆分，2026-09-20 逐模板拆檔）。
 *
 * 本目錄是大段 prompt 文案（slots 六槽、initialPrompt、directive、步驟
 * promptNotes/deliverable/inputFrom/gate/requiredTools）的唯一真源；每個模板
 * 一個檔（`<slug>.ts`），改一條流水線只動一個檔。
 * 客戶端禁止對本目錄做模組頂層靜態 import——會把 11.9 萬中文字元再灌回
 * app/page chunk；動態 import 落點在使用處/回調（ImagePlayground
 * handleUseAgentTemplate、SSR 路由與 node tools 可直接靜態 import）。
 * 新增/增刪步驟必須與顯示檔（agent-templates/）同序同數，hydrateAgentTemplate
 * 防呆會拋錯。
 */

import type { AgentPipelineStepFull, AgentTemplateFull, AgentTemplatePayload } from "./types";
import { AGENT_TEMPLATES } from "../agent-templates";
import type { AgentTemplate } from "../agent-templates";
import { artCurationSeriesPayload } from "./art-curation-series";
import { artStyleImmersionPayload } from "./art-style-immersion";
import { ecommerceLaunchPackPayload } from "./ecommerce-launch-pack";
import { ecommerceModelGridPayload } from "./ecommerce-model-grid";
import { novelFilmPipelinePayload } from "./novel-film-pipeline";
import { novelIpVisualPackPayload } from "./novel-ip-visual-pack";
import { shortdramaPosterLinePayload } from "./shortdrama-poster-line";
import { shortdramaVisualAssetsPayload } from "./shortdrama-visual-assets";

export type {
  AgentPipelineFull,
  AgentPipelineStepFull,
  AgentPipelineStepPayload,
  AgentPipelineToolRequirement,
  AgentTemplateFull,
  AgentTemplatePayload,
} from "./types";

export {
  artCurationSeriesPayload,
  artStyleImmersionPayload,
  ecommerceLaunchPackPayload,
  ecommerceModelGridPayload,
  novelFilmPipelinePayload,
  novelIpVisualPackPayload,
  shortdramaPosterLinePayload,
  shortdramaVisualAssetsPayload,
};

/** 模板 id → 執行 payload。新增模板時這裡加一行（與顯示檔 id 對齊）。 */
export const AGENT_TEMPLATE_PAYLOADS: Record<string, AgentTemplatePayload> = {
  "agent-novel-film-pipeline": novelFilmPipelinePayload,
  "agent-novel-ip-visual-pack": novelIpVisualPackPayload,
  "agent-ecommerce-launch-pack": ecommerceLaunchPackPayload,
  "agent-ecommerce-model-grid": ecommerceModelGridPayload,
  "agent-shortdrama-visual-assets": shortdramaVisualAssetsPayload,
  "agent-shortdrama-poster-line": shortdramaPosterLinePayload,
  "agent-art-curation-series": artCurationSeriesPayload,
  "agent-art-style-immersion": artStyleImmersionPayload,
};

/**
 * 顯示卡 + payload → 執行完整模板。缺 payload 或步數漂移立即拋錯——
 * 寧可點擊報錯，也不許模板文案憑空消失或錯位（誠實原則）。
 */
export function hydrateAgentTemplate(card: AgentTemplate): AgentTemplateFull {
  const payload = AGENT_TEMPLATE_PAYLOADS[card.id];
  if (!payload) throw new Error(`模板 ${card.id} 缺少執行 payload（agent-templates-payload/）`);
  if (payload.steps.length !== card.pipeline.steps.length) {
    throw new Error(
      `模板 ${card.id} 步驟數漂移：顯示 ${card.pipeline.steps.length} vs payload ${payload.steps.length}`,
    );
  }
  const steps = card.pipeline.steps.map((step, i) => ({ ...step, ...payload.steps[i] }));
  return {
    ...card,
    slots: payload.slots,
    initialPrompt: payload.initialPrompt,
    directive: payload.directive,
    pipeline: { summary: card.pipeline.summary, steps },
  };
}

/** 按 id 取執行完整模板（SSR/tools 入口）。 */
export function getAgentTemplateFull(id: string): AgentTemplateFull {
  const card = AGENT_TEMPLATES.find((t) => t.id === id);
  if (!card) throw new Error(`未知模板 id: ${id}`);
  return hydrateAgentTemplate(card);
}

/** 執行側全量清單：節點工具/SSR 用；客戶端組件請用 hydrate 單筆动态載入。 */
export const AGENT_TEMPLATES_FULL: AgentTemplateFull[] = AGENT_TEMPLATES.map(hydrateAgentTemplate);

/**
 * 按选中环节裁剪模板：只保留选中 steps，initialPrompt/directive 追加执行范围说明；全选时原样返回（零改动）。
 * - selectedIndices 升序去重；空数组或覆盖全部步骤 → 视为全选，返回原对象。
 * - 裁剪后 pipeline.steps 只含选中步骤，pipeline.summary 不动。
 */
export function cropTemplate(template: AgentTemplateFull, selectedIndices: number[]): AgentTemplateFull {
  if (selectedIndices.length === 0) return template;
  const indices = [...new Set(selectedIndices)].sort((a, b) => a - b);
  if (indices.length >= template.pipeline.steps.length) return template;
  const steps = indices
    .map((i) => template.pipeline.steps[i])
    .filter((step): step is AgentPipelineStepFull => Boolean(step));
  const shortNames = steps.map((s) => s.shortName);
  return {
    ...template,
    initialPrompt: `${template.initialPrompt}\n本次只执行这些环节：${shortNames.join("、")}。`,
    directive: `${template.directive}\n本次执行范围已裁剪：只做 ${shortNames.join("、")}，不要碰未选中的环节。`,
    pipeline: { ...template.pipeline, steps },
  };
}