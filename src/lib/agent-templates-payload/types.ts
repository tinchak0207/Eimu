/**
 * 助理起手模板——執行 payload 型別（2026-09-20 逐模板拆檔）。
 *
 * 型別單一真源；每個模板的執行文案（slots/initialPrompt/directive/steps）
 * 在同目錄 `<template-slug>.ts`，由 index.ts 匯總成 AGENT_TEMPLATE_PAYLOADS。
 */

import type { AgentPipelineStep, AgentTemplate } from "../agent-templates";
import type { RecipeTemplate, RecipeTemplateSlots } from "../recipe-templates";

/** 單步工具需求：輸入、輸出、門禁、能力邊界一次講清。 */
export interface AgentPipelineToolRequirement {
  id: string;
  input?: string;
  output?: string;
  gate?: string;
  unsupported?: boolean;
  requiredCapability?: string;
  canvasMetadata?: readonly string[];
}

/**
 * 步骤执行字段：该步真正要喂给 agent 的合同与提示词。
 * 与原 agent-templates.ts 的 AgentPipelineStep 字段逐字一致（2026-09-12 拆分）。
 */
export interface AgentPipelineStepPayload {
  /** 该步的可落盘产物。 */
  deliverable: string;
  /** 上一步产出如何喂进来：JSON 注入 / cref 参考图 / sref 锚 / 门禁放行。 */
  inputFrom: string;
  /** 该步提示词与执行要点（含一致性技术）。 */
  promptNotes: string[];
  /** 品质门禁：验收什么、不达标怎么办；无门禁则为空。 */
  gate?: string;
  /**
   * 工具链要求（2026-08-25，2026-08-31 誠實稽核改真源）：该步真正可调用的 harness 工具。
   * 每个 id 必须存在於 harness 真实工具面（harness-tool-registry.ts 的
   * HARNESS_TOOL_IDS，真源 = VPS /opt/agent-harness/workspace/.opencode/tools/）；
   * unsupported=true 表示 harness 尚無 upstream，agent 須明說不可用，
   * 禁止用 prompt 冒充工具成功。
   */
  requiredTools?: AgentPipelineToolRequirement[];
}

/** 顯示 step + 執行字段的完整步驟（畫布鋪法/生成卡 metadata 消費形態）。 */
export interface AgentPipelineStepFull extends AgentPipelineStep, AgentPipelineStepPayload {}

/** 完整流水線藍圖（執行視角）。 */
export interface AgentPipelineFull {
  summary: string;
  steps: AgentPipelineStepFull[];
}

/** 模板級執行欄位（步驟按索引與顯示檔 pipeline.steps 對齊）。 */
export interface AgentTemplatePayload {
  /** 六槽配方（流水线首步）。 */
  slots: RecipeTemplateSlots;
  /** 点卡即注入给 agent 的初始提示词（启动整条流水线的用户第一条消息）。 */
  initialPrompt: string;
  /**
   * 隱形引導詞（2026-08-25）：點卡後隨首條訊息的 system 欄位注入給 agent，
   * 用戶不可見、不進輸入框、不進 transcript。內容 = 這條流水線的正確跑法
   * 與對用戶的引導方式（先把缺的關鍵信息問齊，不要一上來就瘋狂生成）。
   */
  directive: string;
  steps: AgentPipelineStepPayload[];
}

/** 執行側完整模板：顯示卡 + payload 合併形態（也是原 RecipeTemplate 形状）。 */
export interface AgentTemplateFull extends AgentTemplate, RecipeTemplate {
  initialPrompt: string;
  directive: string;
  pipeline: AgentPipelineFull;
}