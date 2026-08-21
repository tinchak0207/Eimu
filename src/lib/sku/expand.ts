// SKU 輸入驗證與鏡頭計劃展開——純函數，不吃 DB/env/時鐘。
//
// 這是 SKU 引擎的核心確定性契約：同一份 SKU 定義 + 同一份輸入，永遠展開出
// 逐字節相同的鏡頭計劃（prompt、順序、數量）。B 端的重放、對賬、diff 都建立在
// 這條性質上；任何「潤色一下」的隨機性都禁止進入這條路徑。

import type {
  ExpandedSkuShot,
  MarketingSku,
  SkuFieldSchema,
  SkuInputIssue,
  SkuInputValidation,
} from "./types";

/** 與 /v1/images/generations 對齊的單條 prompt 上限。 */
export const MAX_SKU_PROMPT_LENGTH = 4_000;
/** 單個字符串欄位的長度上限（模板會拼接多個欄位，單欄位先擋一道）。 */
const MAX_FIELD_LENGTH = 1_500;
/** string_list 每條的長度上限。 */
const MAX_LIST_ITEM_LENGTH = 500;

function issue(code: SkuInputIssue["code"], param: string, message: string): SkuInputIssue {
  return { code, param, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按欄位 schema 逐項校驗與規範化。
 * 未知欄位忽略（向前兼容：目錄加欄位不會炸老客戶的請求）。
 */
export function validateSkuInput(sku: MarketingSku, raw: unknown): SkuInputValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      normalized: {},
      issues: [issue("invalid_field", "input", "SKU 輸入必須是 JSON 物件。")],
    };
  }
  const issues: SkuInputIssue[] = [];
  const normalized: Record<string, string | number | string[]> = {};

  for (const field of sku.inputSchema) {
    const value = raw[field.key];

    if (value === undefined || value === null || value === "") {
      if (field.required) {
        issues.push(issue("missing_field", field.key, `缺少必填欄位 ${field.key}（${field.label}）。`));
      }
      continue;
    }

    if (field.type === "string" || field.type === "url") {
      if (typeof value !== "string") {
        issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 需為字符串。`));
        continue;
      }
      const text = value.trim();
      if (!text) {
        if (field.required) {
          issues.push(issue("missing_field", field.key, `欄位 ${field.key} 不能為空。`));
        }
        continue;
      }
      if (text.length > MAX_FIELD_LENGTH) {
        issues.push(issue("field_too_long", field.key, `欄位 ${field.key} 長度不能超過 ${MAX_FIELD_LENGTH} 字符。`));
        continue;
      }
      if (field.type === "url" && !/^https?:\/\//i.test(text)) {
        issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 需為 http(s) URL。`));
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
          issues.push(issue("missing_field", field.key, `欄位 ${field.key} 至少需要 ${field.minItems ?? 1} 條。`));
        }
        continue;
      }
      if (field.minItems !== undefined && cleaned.length < field.minItems) {
        issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 至少需要 ${field.minItems} 條，當前 ${cleaned.length} 條。`));
        continue;
      }
      const maxItems = field.maxItems ?? 8;
      if (cleaned.length > maxItems) {
        issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 最多 ${maxItems} 條，當前 ${cleaned.length} 條。`));
        continue;
      }
      if (cleaned.some((item) => item.length > MAX_LIST_ITEM_LENGTH)) {
        issues.push(issue("field_too_long", field.key, `欄位 ${field.key} 單條長度不能超過 ${MAX_LIST_ITEM_LENGTH} 字符。`));
        continue;
      }
      normalized[field.key] = cleaned;
      continue;
    }

    // integer
    const num = Number(value);
    if (!Number.isInteger(num)) {
      issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 需為整數。`));
      continue;
    }
    if (field.min !== undefined && num < field.min) {
      issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 不能小於 ${field.min}。`));
      continue;
    }
    if (field.max !== undefined && num > field.max) {
      issues.push(issue("invalid_field", field.key, `欄位 ${field.key} 不能大於 ${field.max}。`));
      continue;
    }
    normalized[field.key] = num;
  }

  if (issues.length > 0) return { ok: false, normalized, issues };
  return { ok: true, normalized, issues: [] };
}

/**
 * 模板變量展開：把 {{var}} 替換為變量值。
 * 模板裡引用了未提供的變量 → 缺變量錯誤（寧可失敗也不留 {{...}} 進生成 prompt）。
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
    return { error: `模板變量未提供：${[...missing].sort().join(", ")}` };
  }
  return { prompt };
}

/**
 * SKU 展開主入口：輸入 → 鏡頭計劃（prompt 已渲染完成）。
 * 全程確定性；任何非確定性擴展不得進入此函數。
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
      issues.push(issue("invalid_field", template.id, `鏡頭 ${template.id} 展開失敗：${rendered.error}`));
      continue;
    }
    if (rendered.prompt.length > MAX_SKU_PROMPT_LENGTH) {
      issues.push(issue("field_too_long", template.id, `鏡頭 ${template.id} 的 prompt 展開後超過 ${MAX_SKU_PROMPT_LENGTH} 字符，請縮短輸入。`));
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
    return { ok: false, issues: [issue("invalid_field", "shots", "鏡頭計劃為空，請檢查輸入。")] };
  }
  return { ok: true, shots };
}

/**
 * 為單個鏡頭模板派生可用變量：規範化輸入的字段直接可用；
 * string_list 字段額外展開 {{key_1}}、{{key_2}}…（1 起）。
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
      // 語義化別名：selling_points 列表同時派生單數形式 selling_point_1…
      // （模板變量按業務語義命名，與輸入欄位的存儲鍵名解耦。）
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

/** 目錄欄位描述（GET /v1/skus 直接返回；客戶系統可編程對接）。 */
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
