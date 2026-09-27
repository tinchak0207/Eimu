// `/openai/v1/chat/completions` 的訊息解析與回覆拼裝。
//
// 生圖模型以對話形式被調用（SillyTavern / Cherry Studio / LobeChat 走這條），prompt 只能
// 從 messages 裡取——這裡負責把它取乾淨，並在客戶端送來**我們不支援的輸入**時誠實失敗，
// 而不是靜默丟掉後生一張不像的圖（同 `/v1/images/generations` 對參考圖的 fail-closed 慣例）。

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
 * 取最後一條 `role:"user"` 訊息的文字當 prompt。
 *
 * 沒有 user 訊息 / 內容為空 → `invalid_request`；帶了圖片輸入 → `image_input_not_supported`
 * （本層只做文生圖；送圖是要做圖生圖／編輯，silently 忽略等於欺騙）。
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

/** 對話形式的生圖回覆：標準 markdown 圖片（客戶端直接渲染）。 */
export function imageMarkdown(url: string): string {
  return `![image](${url})`;
}
