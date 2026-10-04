// 模板 SKU 引擎——自有 SKU 层的类型契约。
//
// 与 PixAI 代理模板（/v1/templates + /v1/template-generations，上游场景预设）是
// 两回事：SKU 是我们自有的「营销成片模板产品化」——一份输入 schema + 一组镜头
// prompt 模板 + 输出规格，客户一句话/一张表就能批量下单。PixAI 模板卖的是上游
// 的场景能力；SKU 卖的是人工编排（钩子结构、分镜节奏、投放渠道适配），这是
// B 端的价格锚点：按交付物计价，不是按模型单价。
//
// 确定性优先：镜头 prompt 是纯文本 + {{变量}}，展开不经过 LLM——同一份输入永远
// 得到同一份镜头计划（B 端要可预测、可对账、可重放）。需要 LLM 润色的路径属于
// 未来扩展（expansion: "llm_assisted"），必须显式标记为非确定性，v1 不提供。

/** 目标投放渠道：决定画幅建议与镜头节奏的叙事风格。 */
export type SkuChannel = "ecommerce" | "short_video";

/** 计价模式：per_shot = 逐镜头按模型价（v1 全部如此）；per_sku = 整包一口价（商业化定价待定）。 */
export type SkuPricingMode = "per_shot" | "per_sku";

/** 输入栏位的可编程描述——目录端点直接序列化给客户系统做表单/校验。 */
export interface SkuFieldSchema {
  key: string;
  label: string;
  type: "string" | "string_list" | "integer" | "url";
  required: boolean;
  description: string;
  /** string_list 的条数区间。 */
  minItems?: number;
  maxItems?: number;
  /** integer 的取值区间。 */
  min?: number;
  max?: number;
  example?: unknown;
}

/** 单个镜头的生成模板：kind 如实标注（没接 TTS/数字人就标 image，不假装成片）。 */
export interface SkuShotTemplate {
  id: string;
  label: string;
  kind: "image" | "video";
  /** 纯文本 + {{变量}}；展开是纯字符串替换，无 LLM。 */
  promptTemplate: string;
  /** 缺省沿用 SKU outputSpec 的 aspectRatio。 */
  aspectRatio?: string;
  /** 仅 video 镜头有意义。 */
  durationSeconds?: number;
}

export interface SkuOutputSpec {
  /** v1 SKU 全部镜头同 kind；混合 kind 的 SKU 留给未来。 */
  kind: "image" | "video";
  aspectRatio: string;
  resolution: "1k" | "2k" | "4k";
  /** 展开后的镜头数区间（随输入自适应，如卖点数）。 */
  shotCount: { min: number; max: number };
  /** 仅 video：单镜头建议时长。 */
  durationSeconds?: number;
}

/**
 * 镜头计划构建器：把规范化输入映射成有序镜头模板列表。
 * 纯函数（输入 → 输出，无副作用、无随机、无时钟）——单测直接锁行为。
 */
export type SkuShotPlanBuilder = (input: Record<string, string | number | string[]>) => SkuShotTemplate[];

export interface MarketingSku {
  id: string;
  name: string;
  tagline: string;
  channel: SkuChannel;
  version: number;
  pricingMode: SkuPricingMode;
  /** 该 SKU 的默认模型（客户可用 body.model 覆盖）。 */
  defaultModelId: string;
  /** v1 全部确定性展开；llm_assisted 保留给未来的非确定性润色路径。 */
  expansion: "deterministic" | "llm_assisted";
  inputSchema: SkuFieldSchema[];
  buildShotPlan: SkuShotPlanBuilder;
  outputSpec: SkuOutputSpec;
  /** 如实的能力边界声明（目录会原样返回，不夸大）。 */
  notes: string[];
}

// ─────────────────────────────────────────── 输入验证与展开结果

export interface SkuInputIssue {
  code: "missing_field" | "invalid_field" | "field_too_long";
  param: string;
  message: string;
}

export interface SkuInputValidation {
  ok: boolean;
  /** 规范化后的输入（trim、条数截断、默认值注入），仅 ok 时有意义。 */
  normalized: Record<string, string | number | string[]>;
  issues: SkuInputIssue[];
}

/** 展开后的单个镜头：已含最终 prompt，直接可喂提交管线。 */
export interface ExpandedSkuShot {
  index: number;
  shotId: string;
  label: string;
  kind: "image" | "video";
  prompt: string;
  aspectRatio: string;
  resolution: "1k" | "2k" | "4k";
  durationSeconds?: number;
}

export type SkuExpansionResult =
  | { ok: true; shots: ExpandedSkuShot[] }
  | { ok: false; issues: SkuInputIssue[] };
