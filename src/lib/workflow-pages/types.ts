/**
 * 产线落地页（/workflows/<slug>）文案型别（2026-09-27 SEO 重构）。
 *
 * 分工：卡面名称、环节名（pipeline.steps）、展示媒体一律从
 * src/lib/agent-templates/<slug>.ts 读取，本目录只写落地页专属文案，
 * 避免双份真源。steps 阵列按索引与 pipeline.steps 对齐，index.ts 会在
 * 模组载入时校验步数，漂移即抛错（build 期就挡住）。
 *
 * 文案事实来源：src/lib/agent-templates-payload/<slug>.ts（每步
 * deliverable / gate / promptNotes）。不得写 payload 与共用简报以外的数字。
 */

/** 单个环节的落地页说明（与 pipeline.steps 同索引）。 */
export interface WorkflowStepDetail {
  /** 这一环实际在做什么。 */
  does: string;
  /** 这一环吃进什么。 */
  input: string;
  /** 这一环交付什么。 */
  output: string;
  /** 人工确认点 / 门禁；这一环没有就省略。 */
  checkpoint?: string;
  /** 常见翻车点与对策。 */
  pitfall?: string;
}

export interface WorkflowFaq {
  question: string;
  answer: string;
}

/** 「和手工流程比，省在哪里」的一条（定性，不写无据数字）。 */
export interface WorkflowSaving {
  title: string;
  body: string;
}

/** 相关行业枢纽页（/use-cases/<slug>）。 */
export interface WorkflowRelatedHub {
  slug: string;
  label: string;
  /** 一句话说明为什么相关。 */
  reason: string;
}

export interface WorkflowPage {
  /** = agent-templates 档名。 */
  slug: string;
  /** 主搜索词。 */
  keyword: string;
  /** 真实搜索说法变体。 */
  searchVariants: string[];
  /** ≤30 字、含主搜索词；不拼「| Eimu」，layout 的 title template 会补。 */
  title: string;
  /** 70–110 字。 */
  description: string;
  h1: string;
  /** 导语两段：这条产线解决谁的什么问题。 */
  intro: [string, string];
  /** 展示媒体的写实 alt 与说明文字。 */
  media: { alt: string; caption: string };
  steps: WorkflowStepDetail[];
  fitFor: string[];
  notFitFor: string[];
  /** 目前的能力边界（照实写）。 */
  limits: string[];
  /** 怎么开始 3–5 步。 */
  start: string[];
  /** 示范愿望 2–3 条。 */
  sampleWishes: string[];
  savings: WorkflowSaving[];
  faqs: WorkflowFaq[];
  /** 相关产线 slug。 */
  relatedWorkflows: string[];
  relatedHubs: WorkflowRelatedHub[];
}
