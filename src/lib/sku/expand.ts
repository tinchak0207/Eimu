// SKU 输入验证与镜头计划展开——纯函数，不吃 DB/env/时钟。
//
// 这是 SKU 引擎的核心确定性契约：同一份 SKU 定义 + 同一份输入，永远展开出
// 逐字节相同的镜头计划（prompt、顺序、数量）。B 端的重放、对账、diff 都建立在
// 这条性质上；任何「润色一下」的随机性都禁止进入这条路径。

import type {
  ExpandedSkuShot,
  MarketingSku,
  SkuFieldSchema,
  SkuInputIssue,
  SkuInputValidation,
} from "./types";

/** 与 /v1/images/generations 对齐的单条 prompt 上限。 */
export const MAX_SKU_PROMPT_LENGTH = 4_000;
/** 单个字符串栏位的长度上限（模板会拼接多个栏位，单栏位先挡一道）。 */
const MAX_FIELD_LENGTH = 1_500;
/** string_list 每条的长度上限。 */
const MAX_LIST_ITEM_LENGTH = 500;

function issue(code: SkuInputIssue["code"], param: string, message: string): SkuInputIssue {
  return { code, param, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按栏位 schema 逐项校验与规范化。
 * 未知栏位忽略（向前兼容：目录加栏位不会炸老客户的请求）。
 */
export function validateSkuInput(sku: MarketingSku, raw: unknown): SkuInputValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      normalized: {},
      issues: [issue("invalid_field", "input", "SKU 输入必须是 JSON 物件。")],
    };
  }
  const issues: SkuInputIssue[] = [];
  const normalized: Record<string, string | number | string[]> = {};

  for (const field of sku.inputSchema) {
    const value = raw[field.key];

    if (value === undefined || value === null || value === "") {
      if (field.required) {
        issues.push(issue("missing_field", field.key, `缺少必填栏位 ${field.key}（${field.label}）。`));
      }
      continue;
    }

    if (field.type === "string" || field.type === "url") {
      if (typeof value !== "string") {
        issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 需为字符串。`));
        continue;
      }
      const text = value.trim();
      if (!text) {
        if (field.required) {
          issues.push(issue("missing_field", field.key, `栏位 ${field.key} 不能为空。`));
        }
        continue;
      }
      if (text.length > MAX_FIELD_LENGTH) {
        issues.push(issue("field_too_long", field.key, `栏位 ${field.key} 长度不能超过 ${MAX_FIELD_LENGTH} 字符。`));
        continue;
      }
      if (field.type === "url" && !/^https?:\/\//i.test(text)) {
        issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 需为 http(s) URL。`));
        continue;
      }
      normalized[field.key] = text;
      continue;
    }

    if (field.type === "string_list") {
      const list = Array.isArray(value) ? value : [value];
      const cleaned = list
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0);
      if (cleaned.length === 0) {
        if (field.required) {
          issues.push(issue("missing_field", field.key, `栏位 ${field.key} 至少需要 ${field.minItems ?? 1} 条。`));
        }
        continue;
      }
      if (field.minItems !== undefined && cleaned.length < field.minItems) {
        issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 至少需要 ${field.minItems} 条，当前 ${cleaned.length} 条。`));
        continue;
      }
      const maxItems = field.maxItems ?? 8;
      if (cleaned.length > maxItems) {
        issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 最多 ${maxItems} 条，当前 ${cleaned.length} 条。`));
        continue;
      }
      if (cleaned.some((item) => item.length > MAX_LIST_ITEM_LENGTH)) {
        issues.push(issue("field_too_long", field.key, `栏位 ${field.key} 单条长度不能超过 ${MAX_LIST_ITEM_LENGTH} 字符。`));
        continue;
      }
      normalized[field.key] = cleaned;
      continue;
    }

    // integer
    const num = Number(value);
    if (!Number.isInteger(num)) {
      issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 需为整数。`));
      continue;
    }
    if (field.min !== undefined && num < field.min) {
      issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 不能小于 ${field.min}。`));
      continue;
    }
    if (field.max !== undefined && num > field.max) {
      issues.push(issue("invalid_field", field.key, `栏位 ${field.key} 不能大于 ${field.max}。`));
      continue;
    }
    normalized[field.key] = num;
  }

  if (issues.length > 0) return { ok: false, normalized, issues };
  return { ok: true, normalized, issues: [] };
}

/**
 * 模板变量展开：把 {{var}} 替换为变量值。
 * 模板里引用了未提供的变量 → 缺变量错误（宁可失败也不留 {{...}} 进生成 prompt）。
 */
export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): { prompt: string } | { error: string } {
  const provided = new Set(Object.keys(variables));
  const missing = new Set<string>();
  const prompt = template.replace(/{{([a-zA-Z0-9_]+)}}/g, (_match, name: string) => {
    if (provided.has(name)) return variables[name];
    missing.add(name);
    return _match;
  });
  if (missing.size > 0) {
    return { error: `模板变量未提供：${[...missing].sort().join(", ")}` };
  }
  return { prompt };
}

/**
 * SKU 展开主入口：输入 → 镜头计划（prompt 已渲染完成）。
 * 全程确定性；任何非确定性扩展不得进入此函数。
 */
export function expandSkuShots(sku: MarketingSku, rawInput: unknown): {
  ok: true;
  shots: ExpandedSkuShot[];
} | {
  ok: false;
  issues: SkuInputIssue[];
} {
  const validation = validateSkuInput(sku, rawInput);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const plan = sku.buildShotPlan(validation.normalized);
  const shots: ExpandedSkuShot[] = [];
  const issues: SkuInputIssue[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    const template = plan[index];
    const variables = deriveTemplateVariables(sku, validation.normalized, template);
    const rendered = renderPromptTemplate(template.promptTemplate, variables);
    if ("error" in rendered) {
      issues.push(issue("invalid_field", template.id, `镜头 ${template.id} 展开失败：${rendered.error}`));
      continue;
    }
    if (rendered.prompt.length > MAX_SKU_PROMPT_LENGTH) {
      issues.push(issue("field_too_long", template.id, `镜头 ${template.id} 的 prompt 展开后超过 ${MAX_SKU_PROMPT_LENGTH} 字符，请缩短输入。`));
      continue;
    }
    shots.push({
      index,
      shotId: template.id,
      label: template.label,
      kind: template.kind,
      prompt: rendered.prompt,
      aspectRatio: template.aspectRatio ?? sku.outputSpec.aspectRatio,
      resolution: sku.outputSpec.resolution,
      ...(template.durationSeconds !== undefined ? { durationSeconds: template.durationSeconds } : {}),
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  if (shots.length === 0) {
    return { ok: false, issues: [issue("invalid_field", "shots", "镜头计划为空，请检查输入。")] };
  }
  return { ok: true, shots };
}

/**
 * 为单个镜头模板派生可用变量：规范化输入的字段直接可用；
 * string_list 字段额外展开 {{key_1}}、{{key_2}}…（1 起）。
 */
export function deriveTemplateVariables(
  _sku: MarketingSku,
  normalized: Record<string, string | number | string[]>,
  _template: { promptTemplate: string },
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string") {
      variables[key] = value;
    } else if (typeof value === "number") {
      variables[key] = String(value);
    } else {
      value.forEach((item, i) => {
        variables[`${key}_${i + 1}`] = item;
      });
      // 语义化别名：selling_points 列表同时派生单数形式 selling_point_1…
      // （模板变量按业务语义命名，与输入栏位的存储键名解耦。）
      const singular = key.endsWith("s") ? key.slice(0, -1) : null;
      if (singular) {
        value.forEach((item, i) => {
          variables[`${singular}_${i + 1}`] = item;
        });
      }
    }
  }
  return variables;
}

/** 目录栏位描述（GET /v1/skus 直接返回；客户系统可编程对接）。 */
export function fieldSchemaView(field: SkuFieldSchema): Record<string, unknown> {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    description: field.description,
    ...(field.minItems !== undefined ? { min_items: field.minItems } : {}),
    ...(field.maxItems !== undefined ? { max_items: field.maxItems } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.example !== undefined ? { example: field.example } : {}),
  };
}
