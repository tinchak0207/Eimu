/**
 * OpenUI 动作 → 聊天消息（纯函数，2026-10-18 从 AgentOpenUIBlock 抽出以便单测）。
 *
 * 回传路径：OpenUI 按钮 @ToAssistant → Renderer onAction(continue_conversation)
 *   → buildOpenUIActionMessage → AgentChatPanel.onSend（与输入框同一通道）。
 */

/** 与 @openuidev/react-lang 的 ActionEvent 同形（只取用到的字段，避免本档依赖运行时）。 */
export type OpenUIActionEventLike = {
  type: string;
  params?: Record<string, unknown>;
  humanFriendlyMessage?: string;
  formState?: unknown;
};

export const MAX_ACTION_MESSAGE = 4_000;
const TRUNCATION_MARK = "…（已截断）";
const MAX_FORM_FIELDS = 20;
const MAX_FIELD_VALUE = 200;
const MAX_CONTEXT = 1000;
const MAX_APPENDIX = 2_000;

type FieldWrapper = { value: unknown; componentType?: string };

function isFieldWrapper(value: unknown): value is FieldWrapper {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "value" in value;
}

function stringifyFieldValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    text = value.join("、");
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    // CheckBoxGroup：{ a: true, b: false } → 「a、…」只列选中项
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length && entries.every(([, v]) => typeof v === "boolean")) {
      text = entries.filter(([, v]) => v).map(([k]) => k).join("、") || "（未选）";
    } else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value);
      }
    }
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_FIELD_VALUE ? `${text.slice(0, MAX_FIELD_VALUE)}…` : text;
}

/**
 * formState 的形状（@openuidev/react-lang）：
 * - 表单内：{ [formName]: { [field]: { value, componentType } } }；
 * - 表单外 $binding：{ 变量名: { value, componentType } }。
 */
export function collectFormFields(formState: unknown): Array<[string, unknown]> {
  if (!formState || typeof formState !== "object" || Array.isArray(formState)) return [];
  const fields: Array<[string, unknown]> = [];
  for (const [key, raw] of Object.entries(formState as Record<string, unknown>)) {
    if (isFieldWrapper(raw)) {
      fields.push([key, raw.value]);
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [field, entry] of Object.entries(raw as Record<string, unknown>)) {
        fields.push([field, isFieldWrapper(entry) ? entry.value : entry]);
      }
    }
  }
  return fields;
}

/**
 * 附加数据必须带 CJK 前缀：网关 outbound 清洗会把「无中文且 ≥5 英文词」的整行
 * 当英文正文压制，纯 JSON 行会被静默吃掉。
 */
export function buildActionAppendix(event: OpenUIActionEventLike): string {
  const parts: string[] = [];
  const fields = collectFormFields(event.formState).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (fields.length > 0) {
    const rendered = fields
      .slice(0, MAX_FORM_FIELDS)
      .map(([name, value]) => `${name}=${stringifyFieldValue(value)}`)
      .join("；");
    parts.push(`当前表单取值：${rendered}`);
  }
  const context = event.params?.context;
  if (context !== undefined && context !== null) {
    let json: string;
    if (typeof context === "string") json = context;
    else {
      try {
        json = JSON.stringify(context) ?? String(context);
      } catch {
        json = String(context);
      }
    }
    if (json) parts.push(`补充数据：${json.length > MAX_CONTEXT ? `${json.slice(0, MAX_CONTEXT)}…` : json}`);
  }
  if (parts.length === 0) return "";
  const appendix = `\n${parts.join("\n")}`;
  return appendix.length > MAX_APPENDIX ? appendix.slice(0, MAX_APPENDIX) : appendix;
}

function capActionMessage(message: string): string {
  if (message.length <= MAX_ACTION_MESSAGE) return message;
  return `${message.slice(0, MAX_ACTION_MESSAGE - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

/** continue_conversation → 要发出的消息；无可发内容时回 null。其它动作类型回 null。 */
export function buildOpenUIActionMessage(event: OpenUIActionEventLike): string | null {
  if (event.type !== "continue_conversation") return null;
  const fromParams = typeof event.params?.message === "string" ? (event.params.message as string) : "";
  const text = event.humanFriendlyMessage || fromParams;
  const appendix = buildActionAppendix(event);
  const message = text.trim() ? `${text}${appendix}` : appendix.trimStart();
  return message.trim() ? capActionMessage(message) : null;
}

/** open_url 动作：只放行 http(s)。 */
export function safeOpenUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
