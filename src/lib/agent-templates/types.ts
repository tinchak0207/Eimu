/**
 * 助理起手模板——显示层型别（2026-09-20 逐模板拆档）。
 *
 * 型别单一真源；每个模板的卡面资料在同目录 `<template-slug>.ts`，
 * 由 index.ts 汇总成 AGENT_TEMPLATES。改一个模板只动一个档，
 * 平行修改不再互相冲突。
 */

/**
 * 助理起手模板领域：每个领域精准对应一个小众强效痛点。
 * 助理初始右侧模板库按此分组展示。
 */
export type AgentTemplateDomain = "novel" | "ecommerce" | "shortdrama" | "art";

/**
 * 流水线单步蓝图（显示视角）：agent 按此推进多步生产。
 * name 是卡面步骤链与画布节点标题共用的展示名：短中文动词开头（拆/锁/定/出），
 * 读起来像一条生产指令，不是术语堆叠——用户不该先学会黑话才能看懂卡。
 * 执行字段（promptNotes/deliverable/inputFrom/gate/requiredTools）在
 * agent-templates-payload/ 的 AgentPipelineStepFull。
 */
export interface AgentPipelineStep {
  /** 步骤短名（行业黑话，如 Character Bible / Sketch-lock）。 */
  name: string;
  /** 环节短名（纯名字，2-3 字；圆环选择器/生成卡标题用）。 */
  shortName: string;
  /** 生成卡节点类型（2026-08-30）：该步产出的形态；缺省 image。
   *  与后端 novel_film 模板映射对齐：文本步=text、视频步=video、配音=audio。
   *  2026-09-03 增 director：3D 白模预演步，生成卡铺成导演台节点（CanvasNodeType.Director）。 */
  outputKind?: "image" | "text" | "video" | "audio" | "director";
}

/** 流水线蓝图（显示视角）：summary + 环节名；执行字段见 payload 档。 */
export interface AgentPipeline {
  /** 一句话概括整条链。 */
  summary: string;
  steps: AgentPipelineStep[];
}

/**
 * 助理起手模板（卡面显示视角；2026-09-12 拆分）：原 RecipeTemplate（六槽配方）
 * 的 slots 与 initialPrompt/directive 等执行栏位移至 payload 档，
 * 执行侧完整形态见 AgentTemplateFull。
 */
export interface AgentTemplate {
  id: string;
  name: string;
  /** 一句话说明这个模板适合什么。 */
  note: string;
  domain: AgentTemplateDomain;
  /** 流水线级痛点（卡片副标题）。 */
  painPoint: string;
  /** 卡面海报区渐变（Tailwind 三色类，格式同 showcase-cases 的 gradient）。 */
  accent: string;
  /** 卡片居中时舞台环境光主色（hex，取 accent 中间档）。 */
  glow: string;
  /**
   * 模范级 AI 成片封面照（2026-08-26）：public/showcase/agent-templates/ 下的
   * 静态 webp。来源 = 各领域模范 AI 生成成片的封面帧（获奖/官方精选/高播放），
   * object-cover 铺满卡面、atc-info 自带底部黑渐变保证文字可读。缺席时退回纯渐变。
   */
  showcaseImage?: string;
  /** 模范级 AI 成片影片：8 秒静音循环 mp4。poster = showcaseImage。 */
  showcaseVideo?: string;
  /**
   * VPS agent-harness 后端已注册的 workflow 模板 id（2026-08-27）。
   * 前端卡面 8 环承诺与后端 novel_film 模板对齐：剧本/分镜=text、
   * 角色卡/美术卡/关键帧=image、视频=video、配音=audio、成片=film。
   * agent 调 workflow_start 时应以此 id 启动，而非即兴拼节点。
   */
  harnessTemplateId?: string;
  /** 多步骤流水线蓝图（显示视角）。 */
  pipeline: AgentPipeline;
}