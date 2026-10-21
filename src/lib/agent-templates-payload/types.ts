/**
 * 助理起手模板——执行 payload 型别（2026-09-20 逐模板拆档）。
 *
 * 型别单一真源；每个模板的执行文案（slots/initialPrompt/directive/steps）
 * 在同目录 `<template-slug>.ts`，由 index.ts 汇总成 AGENT_TEMPLATE_PAYLOADS。
 */

import type { AgentPipelineStep, AgentTemplate } from "../agent-templates";
import type { RecipeTemplate, RecipeTemplateSlots } from "../recipe-templates";

/** 单步工具需求：输入、输出、门禁、能力边界一次讲清。 */
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
   * 工具链要求（2026-08-25，2026-08-31 诚实稽核改真源）：该步真正可调用的 harness 工具。
   * 每个 id 必须存在于 harness 真实工具面（harness-tool-registry.ts 的
   * HARNESS_TOOL_IDS，真源 = VPS /opt/agent-harness/workspace/.opencode/tools/）；
   * unsupported=true 表示 harness 尚无 upstream，agent 须明说不可用，
   * 禁止用 prompt 冒充工具成功。
   */
  requiredTools?: AgentPipelineToolRequirement[];
}

/** 显示 step + 执行字段的完整步骤（画布铺法/生成卡 metadata 消费形态）。 */
export interface AgentPipelineStepFull extends AgentPipelineStep, AgentPipelineStepPayload {}

/** 完整流水线蓝图（执行视角）。 */
export interface AgentPipelineFull {
  summary: string;
  steps: AgentPipelineStepFull[];
}

/** 模板级执行栏位（步骤按索引与显示档 pipeline.steps 对齐）。 */
export interface AgentTemplatePayload {
  /** 六槽配方（流水线首步）。 */
  slots: RecipeTemplateSlots;
  /** 点卡即注入给 agent 的初始提示词（启动整条流水线的用户第一条消息）。 */
  initialPrompt: string;
  /**
   * 隐形引导词（2026-08-25）：点卡后随首条讯息的 system 栏位注入给 agent，
   * 用户不可见、不进输入框、不进 transcript。内容 = 这条流水线的正确跑法
   * 与对用户的引导方式（先把缺的关键信息问齐，不要一上来就疯狂生成）。
   */
  directive: string;
  steps: AgentPipelineStepPayload[];
}

/** 执行侧完整模板：显示卡 + payload 合并形态（也是原 RecipeTemplate 形状）。 */
export interface AgentTemplateFull extends AgentTemplate, RecipeTemplate {
  initialPrompt: string;
  directive: string;
  pipeline: AgentPipelineFull;
}