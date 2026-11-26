// D-19：参数卡片要摊开「agent 实际会用到的所有参数」，分两层——
// 常用层默认展开（模型/尺寸/张数/花费），进阶层默认收起（LoRA/权重/sampler/steps/seed）。
//
// 唯一的参数来源是 tool.invoke 的 args_summary，而网关只给一个字符串、
// 截到 500 字并补省略号（agent-chat-types.ts:47）。所以这里必须两条腿走路：
//   1. 是完整 JSON → 结构化成分层参数
//   2. 被截断 / 不是 JSON → 尽量捞出 key: value 对，捞不到就交回原文让 UI 退化显示
// 绝不假装解析成功：宁愿显示原文，也不能把半截 JSON 编成看起来完整的参数表。

export type ParamTier = "common" | "advanced";

export interface AgentParam {
  key: string;
  label: string;
  value: string;
  tier: ParamTier;
  /** prompt 这类长文本独占一行，不挤在两列网格里。 */
  wide?: boolean;
}

export interface ParsedToolParams {
  params: AgentParam[];
  /** 原文。params 为空时 UI 退回显示它。 */
  raw: string;
  /** 上游截断过 → 参数可能不全，UI 要说出来而不是装作完整。 */
  truncated: boolean;
}

/** 常用层：顺序即展示顺序。 */
const COMMON: Record<string, string> = {
  prompt: "画面描述",
  model: "模型",
  size: "尺寸",
  aspect_ratio: "比例",
  n: "张数",
  count: "张数",
  quality: "画质",
};

/** 进阶层：默认收起。 */
const ADVANCED: Record<string, string> = {
  negative_prompt: "负面描述",
  lora: "LoRA",
  lora_id: "LoRA",
  lora_weight: "LoRA 权重",
  weight: "权重",
  sampler: "采样器",
  sampling_method: "采样器",
  steps: "步数",
  cfg: "CFG",
  cfg_scale: "CFG",
  seed: "随机种子",
  scale: "放大倍率",
  media_id: "来源图",
  mediaId: "来源图",
  response_format: "返回格式",
  task_id: "任务号",
};

const COMMON_ORDER = Object.keys(COMMON);
const ADVANCED_ORDER = Object.keys(ADVANCED);

/** 长文本参数独占整行。 */
const WIDE_KEYS = new Set(["prompt", "negative_prompt"]);

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "开" : "关";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // 数组/对象（例如 lora 列表）压成紧凑 JSON，不换行撑破卡片
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function classify(key: string): { label: string; tier: ParamTier } {
  if (key in COMMON) return { label: COMMON[key], tier: "common" };
  if (key in ADVANCED) return { label: ADVANCED[key], tier: "advanced" };
  // 没见过的参数一律进阶层：agent 换了工具签名时不会凭空消失，
  // 也不会挤掉常用层那四项。
  return { label: key, tier: "advanced" };
}

function orderIndex(key: string, tier: ParamTier): number {
  const list = tier === "common" ? COMMON_ORDER : ADVANCED_ORDER;
  const i = list.indexOf(key);
  return i === -1 ? list.length : i;
}

function toParams(entries: Array<[string, unknown]>): AgentParam[] {
  const seen = new Set<string>();
  const out: AgentParam[] = [];
  for (const [key, value] of entries) {
    const text = stringifyValue(value).trim();
    if (!text) continue; // 空值不占位
    const { label, tier } = classify(key);
    // 同义键（n/count、lora/lora_id）只留第一个，避免「张数」出现两行
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ key, label, value: text, tier, wide: WIDE_KEYS.has(key) || text.length > 48 });
  }
  return out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "common" ? -1 : 1;
    return orderIndex(a.key, a.tier) - orderIndex(b.key, b.tier);
  });
}

/** 截断痕迹：网关补的省略号，或 JSON 括号收不了尾。 */
function looksTruncated(raw: string): boolean {
  if (/(\.\.\.|…)\s*$/.test(raw)) return true;
  const opens = (raw.match(/[{[]/g) ?? []).length;
  const closes = (raw.match(/[}\]]/g) ?? []).length;
  return opens > closes;
}

/**
 * 从 key: value / key=value 文本里捞参数。
 * 用在 JSON.parse 失败时（被截断、或上游本来就给的人话摘要）。
 */
function salvagePairs(raw: string): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  // "key": value  |  key: value  |  key=value
  const re = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|[^,;\n}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    let value = m[2].trim().replace(/,$/, "");
    if (value.startsWith('"')) {
      // 结尾引号可能被截掉，先补回再解析，解析不了就剥掉首引号用原文
      const candidate = value.endsWith('"') && value.length > 1 ? value : `${value}"`;
      try {
        value = JSON.parse(candidate) as string;
      } catch {
        value = value.slice(1);
      }
    }
    out.push([key, value]);
  }
  return out;
}

/**
 * 把 args_summary 解析成分层参数。
 * 返回 null 表示压根没参数可说（undefined / 空字符串）。
 */
export function parseToolParams(argsSummary: string | undefined): ParsedToolParams | null {
  if (argsSummary === undefined) return null;
  const raw = argsSummary.trim();
  if (!raw) return null;

  const truncated = looksTruncated(raw);

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { params: toParams(Object.entries(parsed as Record<string, unknown>)), raw, truncated };
    }
  } catch {
    // 落到捞取分支
  }

  const salvaged = salvagePairs(raw);
  // 只捞到一对且原文明显是句人话时，不硬凑参数表——交回原文更诚实
  if (salvaged.length === 0) return { params: [], raw, truncated };
  return { params: toParams(salvaged), raw, truncated };
}
