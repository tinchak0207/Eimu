import { createHash } from "node:crypto";
import { MAX_TOOL_TEXT_LENGTH, redactSecrets } from "../protocol";
import { extractAgentArtifacts } from "./agent";
import { isPlainObject } from "./validation";

/** Bound the serialized envelope, rather than cutting a serialized JSON value. */
export function projectAgentSession(payload: unknown, args: Record<string, unknown>): unknown {
  const source = redactSecrets(JSON.stringify(payload));
  if (JSON.stringify(JSON.parse(source), null, 2).length <= MAX_TOOL_TEXT_LENGTH && args.cursor === undefined && args.limit === undefined) {
    return JSON.parse(source);
  }
  const snapshot = createHash("sha256").update(source).digest("hex");
  const limit = typeof args.limit === "number" ? args.limit : 8_000;
  let end = source.length;
  if (typeof args.cursor === "string") {
    const [version, offset, ...extra] = args.cursor.split(":");
    if (extra.length || version !== snapshot || !/^\d+$/.test(offset ?? "")) {
      return { error: { code: "session_cursor_stale", message: "会话内容已变化或游标无效，请不带 cursor 重读最新页。" }, snapshot };
    }
    end = Number(offset);
    if (!Number.isSafeInteger(end) || end > source.length) {
      return { error: { code: "invalid_session_cursor", message: "游标超出会话范围。" } };
    }
  }

  // Read message fields structurally. No keyword-based removal of system/context text.
  const messages = isPlainObject(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  const assistant = messages.filter((entry) => isPlainObject(entry) && entry.role === "assistant");
  const textOf = (entry: unknown): string => {
    if (!isPlainObject(entry)) return "";
    if (typeof entry.text === "string") return entry.text;
    if (typeof entry.content === "string") return entry.content;
    if (!Array.isArray(entry.parts)) return "";
    return entry.parts.filter(isPlainObject).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  };
  // 只取有正文的 assistant 条目：纯工具调用／空 text 的条目不占 latest_messages 名额（P2 2026-11-01）。
  const latest = assistant.filter((entry) => textOf(entry).trim() !== "").slice(-2).map((entry) => {
    const text = redactSecrets(textOf(entry));
    return { role: "assistant", text: text.slice(-700), text_chars: text.length, truncated: text.length > 700 };
  });
  const allArtifacts = extractAgentArtifacts(assistant.map(textOf).join("\n"));
  // Artifacts outside this preview remain recoverable in the complete source pages.
  const artifacts: typeof allArtifacts = [];
  for (const item of allArtifacts.slice(-10).reverse()) {
    const safe = { ...item, url: redactSecrets(item.url) };
    if (JSON.stringify([...artifacts, safe]).length <= 2000) artifacts.unshift(safe);
  }
  const base = {
    session_id: args.session_id,
    view: args.view ?? "summary",
    latest_messages: latest,
    artifacts,
    artifacts_total: allArtifacts.length,
    artifacts_preview_truncated: allArtifacts.length > artifacts.length,
  };
  const envelope = (start: number) => ({
    ...base,
    source_json_fragment: source.slice(start, end),
    pagination: {
      snapshot,
      unit: "utf16_code_units",
      order: "newest_first",
      start,
      end,
      total_chars: source.length,
      truncated: start > 0 || end < source.length,
      next_cursor: start > 0 ? `${snapshot}:${start}` : null,
      recovery: "按 start 升序拼接各页 source_json_fragment，再 JSON.parse；cursor 对应同一 snapshot，变化时重读。",
    },
  });
  let start = Math.max(0, end - limit);
  // JSON escaping can expand one source character to six characters. Measure output.
  while (JSON.stringify(envelope(start), null, 2).length > MAX_TOOL_TEXT_LENGTH && start < end) {
    start += Math.max(1, Math.ceil((end - start) / 2));
  }
  return envelope(start);
}
