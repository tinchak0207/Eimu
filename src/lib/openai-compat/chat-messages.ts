// `/openai/v1/chat/completions` 的讯息解析与回覆拼装。
//
// 生图模型以对话形式被调用（SillyTavern / Cherry Studio / LobeChat 走这条），prompt 只能
// 从 messages 里取——这里负责把它取干净，并在客户端送来**我们不支援的输入**时诚实失败，
// 而不是静默丢掉后生一张不像的图（同 `/v1/images/generations` 对参考图的 fail-closed 惯例）。

export interface ChatTextPart {
  type?: unknown;
  text?: unknown;
}

export type ExtractPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromContent(content: unknown): { text: string; hasImageInput: boolean } {
  if (typeof content === "string") return { text: content, hasImageInput: false };
  if (!Array.isArray(content)) return { text: "", hasImageInput: false };

  const parts: string[] = [];
  let hasImageInput = false;
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" || type === "input_text") {
      if (typeof part.text === "string") parts.push(part.text);
      continue;
    }
    if (type === "image_url" || type === "input_image" || type === "image") hasImageInput = true;
  }
  return { text: parts.join("\n"), hasImageInput };
}

/**
 * 取最后一条 `role:"user"` 讯息的文字当 prompt。
 *
 * 没有 user 讯息 / 内容为空 → `invalid_request`；带了图片输入 → `image_input_not_supported`
 * （本层只做文生图；送图是要做图生图／编辑，silently 忽略等于欺骗）。
 */
export function extractLastUserPrompt(messages: unknown): ExtractPromptResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: "invalid_request", message: "缺少必填参数 messages（非空数组）。" };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const { text, hasImageInput } = textFromContent(message.content);
    if (hasImageInput) {
      return {
        ok: false,
        code: "image_input_not_supported",
        message: "当前仅支持文生图：请在 messages 里只发送文本内容（图片输入暂不支持）。",
      };
    }
    const prompt = text.trim();
    if (!prompt) {
      return { ok: false, code: "invalid_request", message: "最后一条 user 消息内容为空。" };
    }
    return { ok: true, prompt };
  }

  return { ok: false, code: "invalid_request", message: "messages 里没有 user 角色的消息。" };
}

/** 对话形式的生图回覆：标准 markdown 图片（客户端直接渲染）。 */
export function imageMarkdown(url: string): string {
  return `![image](${url})`;
}
