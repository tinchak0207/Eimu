/**
 * 助理起手模板——顯示層型別（2026-09-20 逐模板拆檔）。
 *
 * 型別單一真源；每個模板的卡面資料在同目錄 `<template-slug>.ts`，
 * 由 index.ts 匯總成 AGENT_TEMPLATES。改一個模板只動一個檔，
 * 平行修改不再互相衝突。
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
  /** 生成卡節點類型（2026-08-30）：該步產出的形態；缺省 image。
   *  與後端 novel_film 模板映射對齊：文本步=text、視頻步=video、配音=audio。
   *  2026-09-03 增 director：3D 白模预演步，生成卡鋪成導演台節點（CanvasNodeType.Director）。 */
  outputKind?: "image" | "text" | "video" | "audio" | "director";
}

/** 流水线蓝图（显示视角）：summary + 环节名；执行字段见 payload 档。 */
export interface AgentPipeline {
  /** 一句话概括整条链。 */
  summary: string;
  steps: AgentPipelineStep[];
}

/**
 * 助理起手模板（卡面顯示視角；2026-09-12 拆分）：原 RecipeTemplate（六槽配方）
 * 的 slots 與 initialPrompt/directive 等執行欄位移至 payload 檔，
 * 執行側完整形態見 AgentTemplateFull。
 */
export interface AgentTemplate {
  id: string;
  name: string;
  /** 一句话说明这个模板适合什么。 */
  note: string;
  domain: AgentTemplateDomain;
  /** 流水线级痛点（卡片副标题）。 */
  painPoint: string;
  /** 卡面海報區漸變（Tailwind 三色類，格式同 showcase-cases 的 gradient）。 */
  accent: string;
  /** 卡片居中时舞台环境光主色（hex，取 accent 中间档）。 */
  glow: string;
  /**
   * 模範級 AI 成片封面照（2026-08-26）：public/showcase/agent-templates/ 下的
   * 靜態 webp。來源 = 各領域模範 AI 生成成片的封面帧（獲獎/官方精選/高播放），
   * object-cover 鋪滿卡面、atc-info 自帶底部黑漸變保證文字可讀。缺席時退回純漸變。
   */
  showcaseImage?: string;
  /** 模範級 AI 成片影片：8 秒靜音循環 mp4。poster = showcaseImage。 */
  showcaseVideo?: string;
  /**
   * VPS agent-harness 後端已註冊的 workflow 模板 id（2026-08-27）。
   * 前端卡面 8 環承諾與後端 novel_film 模板對齊：劇本/分鏡=text、
   * 角色卡/美術卡/關鍵幀=image、視頻=video、配音=audio、成片=film。
   * agent 調 workflow_start 時應以此 id 啟動，而非即興拼節點。
   */
  harnessTemplateId?: string;
  /** 多步驟流水线蓝图（显示视角）。 */
  pipeline: AgentPipeline;
}