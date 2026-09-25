// opencode 全量歷史 → AgentTranscriptItem[] 的歸一化（純函數）。
//
// 為什麼要這層：「回到歷史會話」改由 GET /api/agent/sessions/[id] 的全量
// 歷史重建 transcript，不再依賴網關 1000 幀 ring buffer 回放（長會話會被
// 截斷成空白）。opencode 的 messages 是 [{info:{id,role,time,tokens},parts:[...]}]
// 的原始 shape，與前端渲染模型（AgentTranscriptItem）不同構，中間需要一個
// 忠實且防炸的映射層。
//
// 紀律：
//   - 純函數：不碰 React / DOM / Date.now / Math.random，同輸入同輸出，
//     `npx tsx --test` 直接測。
//   - 結構規則忠實對齊 agent-chat-reducer：
//       * assistant 文字條目 streaming=false（歷史已定案，不詐尸流式）；
//       * image/video/audio 的 seq 是「該 kind 會話內展示序號」（鏡像
//         image.done 的 imageSeq 語義），錨定文案「第 N 張」直接唼它；
//         user/assistant/tool 的 seq 用全局遞增的合成游標（嚴格遞增）；
//       * id 用 `<kind>-<全局序>`，全陣列唯一，且與 SSE 事件的
//         `<kind>-<event_id>` 命名空間文字上不撞（合成游標帶 h 前綴）。
//   - 產出的每個 item 必須能過 persistence.ts 的 sanitizeItemsForStorage
//     白名單（ITEM_KINDS）：只會產出 user/assistant/tool/image/video/audio
//     /subagent_result，不產 director/subagent/notice。附件 url 只收
//     http(s)（data: 的 base64 嚴禁進 localStorage）。
//   - 未知 part / 髒資料一律跳過不炸，丟棄計進 droppedParts 統計。

import type {
  AgentAttachmentRef,
  AgentAssistantTextItem,
  AgentImageItem,
  AgentAudioItem,
  AgentSubagentReportItem,
  AgentToolCallItem,
  AgentTranscriptItem,
  AgentUserTurnItem,
  AgentVideoItem,
  OpenCodeMessage,
} from "./agent-chat-types";

/** 歸一化結果：items 供 restore；dropped 統計供排觀（測試斷言用）。 */
export interface NormalizeHistoryResult {
  items: AgentTranscriptItem[];
  /** 被丟棄的 part 總數（未知型別、無公網 URL 的媒體、髒 tool 等）。 */
  droppedParts: number;
  /** 丟棄原因分桶，key 為 part 型別或歸類標籤。 */
  droppedByType: Record<string, number>;
}

// ─────────────────────────── 判型小工具

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 只認公網 http(s) URL：data: URI 是 base64，落存檔會撐爆 localStorage。 */
function isPublicUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)([?#]|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)([?#]|$)/i;

/** 依 mime（優先）與副檔名判媒體三類；判不出回 null。 */
function mediaKind(mime: string | undefined, name: string | undefined, url: string): "image" | "video" | "audio" | null {
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
  }
  for (const probe of [name, url]) {
    if (!probe) continue;
    if (IMAGE_EXT.test(probe)) return "image";
    if (VIDEO_EXT.test(probe)) return "video";
    if (AUDIO_EXT.test(probe)) return "audio";
  }
  return null;
}

/** 附件 kind 對齊 client 的 toAgentAttachmentRef：image/→image，video/→video，其餘→document（副檔名兜底）。 */
function attachmentKind(mime: string | undefined, name: string | undefined, url: string): AgentAttachmentRef["kind"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  const probe = mediaKind(undefined, name, url);
  if (probe === "image" || probe === "video") return probe;
  return "document";
}

/** opencode tool part 的 state.status → 前端狀態枚舉；判不了回 null（丟棄）。 */
function toolStatus(raw: unknown): AgentToolCallItem["status"] | null {
  switch (raw) {
    case "completed":
      return "ok";
    case "error":
      return "failed";
    case "running":
    case "pending":
      return "running";
    default:
      return null;
  }
}

/** 工具參數摘要：字串直用，其餘 JSON 化並截斷（存檔瘦身，也與 live 的 args_summary 同量級）。 */
function argsSummary(input: unknown): string | undefined {
  if (typeof input === "string") return input.length > 200 ? `${input.slice(0, 200)}…` : input;
  if (input === null || input === undefined) return undefined;
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return undefined;
  }
}

/** 失敗原因：opencode 的 state.error 多為字串；物件退而取 message，再退 JSON。 */
function toolErrorText(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  const rec = asRecord(raw);
  if (rec) {
    const msg = asString(rec.message);
    if (msg) return msg;
  }
  return undefined;
}

// ─────────────────────────── 系統注入訊息識別（歸因錯覺病灶）

// gateway 機制上必須以 user role 注入會話的三類訊息（喚醒/重試提示/召回前綴），
// 歷史路徑若一律畫成用戶氣泡，用戶事後翻記錄會看到自己「說過」從沒說過的話。
// 識別標記全部對齊後端真源（deploy-staging/gateway）：index.ts wakeSessionForSubagent、
// opencode-event-handler.ts turn failover、memory-recall.ts renderRecallPrefix。

/** 子代理喚醒訊息骨架（真源 gateway/index.ts wakeSessionForSubagent，勿改後端）。 */
const SUBAGENT_WAKE_RE =
  /^【子代理(完成|失败)·系统自动唤醒】subagent\s+([0-9A-Za-z]+)（label="([^"]*)"）已(?:完成|失败)。(?:结果摘要|失败原因)：/;

/** 喚醒訊息尾部固定的續跑指令行（給模型的指令，不是產出內容）。 */
const SUBAGENT_WAKE_TAIL = "请基于以上真实结果继续推进";

/**
 * 解析子代理喚醒訊息。命中回 {status, subagentId, label, text(產出正文)}；
 * 標記對但骨架漂移（label 含引號等）走兜底盡力提取——總之絕不冒充用戶氣泡。
 */
function parseSubagentWake(text: string): { status: "ok" | "error"; subagentId: string; label: string; text: string } | null {
  if (!text.startsWith("【子代理完成·系统自动唤醒】") && !text.startsWith("【子代理失败·系统自动唤醒】")) return null;
  const m = SUBAGENT_WAKE_RE.exec(text);
  if (m === null) {
    const status: "ok" | "error" = text.startsWith("【子代理失败") ? "error" : "ok";
    const subagentId = /subagent\s+([0-9A-Za-z]+)/.exec(text)?.[1] ?? "";
    const label = /label="([^"]*)"/.exec(text)?.[1] ?? "";
    return { status, subagentId, label, text };
  }
  const status: "ok" | "error" = m[1] === "完成" ? "ok" : "error";
  let body = text.slice(m[0].length);
  const cut = body.indexOf(SUBAGENT_WAKE_TAIL);
  if (cut >= 0) body = body.slice(0, cut);
  return { status, subagentId: m[2] ?? "", label: m[3] ?? "", text: body.trim() };
}

/** 記憶召回知識塊標記行開頭（真源 gateway/memory-recall.ts RECALL_HEADER）。 */
const RECALL_BLOCK_MARKER = "[相關領域知識";

/** 知識塊內容行：`- [domain] slug` 條目行或縮兩格的 body 延續行。 */
function isRecallBodyLine(l: string): boolean {
  return /^- \[[^\]]*\]\s*\S/.test(l) || /^ {2,}\S/.test(l);
}

/**
 * 從用戶文本剝離 gateway 注入的記憶召回知識塊。位置無關（頭/尾皆處理）：
 * messages-gw.ts 現場實際是前綴注入（`prefix + "\n\n" + 用戶正文`），
 * 舊規格描述的「尾部追加」也一併覆蓋。找不到標記原樣返回。
 * 塊 = 標記行 + 若干條目/body 行，直到空行接非塊內容或文本結束。
 */
function stripRecallBlock(text: string): string {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.trim().startsWith(RECALL_BLOCK_MARKER));
  if (head < 0) return text;
  const out = lines.slice(0, head);
  let i = head + 1;
  for (; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    const next = lines[i + 1];
    const isBlockGap = l.length === 0 && next !== undefined && isRecallBodyLine(next);
    if (isRecallBodyLine(l) || isBlockGap) continue;
    break; // 塊結束：此行起屬於用戶正文（前綴注入的分隔空行也在此消掉）
  }
  // 尾部注入：塊吞到文本結束（或只剩殘留空行）→ 前文的收尾空行一併吃掉。
  const atTail = i >= lines.length || lines.slice(i).every((l) => l.trim().length === 0);
  if (i < lines.length && !atTail) out.push(...lines.slice(i));
  let res = out.join("\n");
  if (head === 0) res = res.replace(/^(?:[ \t]*\n)+/, ""); // 前綴剝離：吃掉殘留空行
  if (atTail) res = res.replace(/(?:[ \t]*\n)+$/, "");
  return res;
}

/** 內部框架段標題行（live 路徑真源 gateway/outbound-sanitize.ts + e2e 實錘的 Progress Summary）。 */
export const INTERNAL_SECTION_HEADING_RE =
  /^#{1,6}[ \t]*(?:objective|work state|next move|relevant files|important details|completed|active|blocked|progress summary)[ \t]*:?[ \t]*$/i;

const ANY_HEADING_RE = /^#{1,6}[ \t]/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * assistant 歷史文本的內部框架段剝離（live 路徑 gateway 出站已剝、歷史路徑漏）：
 * `## Objective` 等標題行起吞到下一個非內部 markdown 標題或文本結束；
 * 代碼柵欄（``` / ~~~）內容直通不判。無內部段時原樣返回（零改動）。
 */
export function stripInternalSections(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (!lines.some((l) => INTERNAL_SECTION_HEADING_RE.test(l))) return text;
  const out: string[] = [];
  let suppress = false;
  let fence = false;
  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (FENCE_RE.test(line)) fence = false;
      continue;
    }
    if (FENCE_RE.test(line)) {
      fence = true;
      out.push(line);
      continue;
    }
    if (suppress) {
      // 內部段到下一個「非內部」標題為止；下一個內部段標題繼續吞。
      if (ANY_HEADING_RE.test(line) && !INTERNAL_SECTION_HEADING_RE.test(line)) {
        suppress = false;
        out.push(line);
      }
      continue;
    }
    if (INTERNAL_SECTION_HEADING_RE.test(line)) {
      suppress = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─────────────────────────── 歸一化主體

/**
 * 把 opencode 原始訊息陣列重建為前端 transcript。
 *
 * 映射表（part.type → item）：
 *   user.text      → 拼接進該輪 user item 的 text
 *   user.file      → user item 的 attachments（僅 http(s) URL；鏡像 live 上傳語義）
 *   assistant.text → 順次累積進當前 assistant item（工具/媒體卡會切斷段落）
 *   assistant.reasoning → 併入 assistant item 的 reasoning 欄位（型別有承載，不丟）
 *   assistant.tool → tool item（completed→ok / error→failed / running、pending→running）
 *   assistant.file → image/video/audio item（按 mime/副檔名；判不出或無公網 URL 丟棄計數）
 *   其餘（step-start/patch/…）→ 跳過並計數
 */
export function normalizeOpenCodeMessages(messages: OpenCodeMessage[]): NormalizeHistoryResult {
  const items: AgentTranscriptItem[] = [];
  const droppedByType: Record<string, number> = {};
  let droppedParts = 0;
  const drop = (type: string): void => {
    droppedParts += 1;
    droppedByType[type] = (droppedByType[type] ?? 0) + 1;
  };

  // 全局序：id 後綴（h 前綴隔開 SSE 的 <kind>-<event_id> 命名空間）；
  // 同時是 user/assistant/tool 的 seq（嚴格遞增）。
  let order = 0;
  // 媒體 seq：該 kind 會話內展示序號（鏡像 reducer 的 imageSeq 語義）。
  let imageSeq = 0;
  let videoSeq = 0;
  let audioSeq = 0;
  let userCount = 0;
  // 同 kind 同 url 去重（鏡像 reducer 的 exists 守衛：重複完成幰不刷兩張卡）。
  const seenMedia = new Set<string>();

  for (const rawMsg of Array.isArray(messages) ? messages : []) {
    const msg = asRecord(rawMsg);
    const info = asRecord(msg?.info);
    const role = asString(info?.role);
    const parts = Array.isArray(msg?.parts) ? (msg.parts as unknown[]) : null;
    if (!parts) {
      // 整則訊息不可用：無 part 可逐個計，算一個 message 級丟棄。
      drop("message");
      continue;
    }

    if (role === "user") {
      const texts: string[] = [];
      const attachments: AgentAttachmentRef[] = [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        const type = asString(part?.type) ?? "malformed";
        if (!part) {
          drop(type);
          continue;
        }
        if (type === "text") {
          const t = asString(part.text);
          if (t && t.trim().length > 0) texts.push(t);
          continue;
        }
        if (type === "file") {
          // 使用者上傳附件鏡像 live 語義：掛在 user item 的 attachments 上，
          // 不是漂浮的媒體卡；只收公網 URL（data: base64 嚴禁進存檔）。
          if (!isPublicUrl(part.url)) {
            drop("file-no-public-url");
            continue;
          }
          const mime = asString(part.mime);
          const filename = asString(part.filename);
          const ref: AgentAttachmentRef = {
            kind: attachmentKind(mime, filename, part.url),
            url: part.url,
            ...(filename ? { name: filename } : {}),
            ...(mime ? { mime } : {}),
            ...(typeof part.size === "number" && Number.isFinite(part.size) ? { size: part.size } : {}),
          };
          attachments.push(ref);
          continue;
        }
        drop(type);
      }
      const text = texts.join("\n");

      // ① 子代理喚醒訊息：機制上必須走 user role，但它是系統注入，不是用戶
      // 說的話——渲染成 subagent_result 產出卡（前端已有
      // AgentSubagentReportCard），絕不畫成用戶氣泡。佔 order seq 保時序，
      // 不佔 userCount（不是用戶輪，user id 續號不受污染）。
      const wake = parseSubagentWake(text);
      if (wake !== null) {
        order += 1;
        const item: AgentSubagentReportItem = {
          kind: "subagent_result",
          id: `subagent-report-h${order}`,
          seq: order,
          subagentId: wake.subagentId,
          label: wake.label,
          status: wake.status,
          text: wake.text,
        };
        items.push(item);
        continue;
      }

      // ② 系統重試提示（上游錯誤後 gateway 的續跑指令）：整條不顯示。
      const trimmed = text.trim();
      if (trimmed.startsWith("（系统提示：") && trimmed.endsWith("）")) {
        drop("system-hint");
        continue;
      }

      // ③ 記憶召回知識塊（gateway 每回合注入的語料前綴）：從用戶文本剝掉，
      // 只留用戶真正說的話。剝完空文本且無附件 → 整條不留。
      const userText = stripRecallBlock(text);
      if (userText !== text && userText.trim().length === 0 && attachments.length === 0) {
        drop("recall-block");
        continue;
      }
      if (userText.length === 0 && attachments.length === 0) continue; // 全丟光的空輪不留言
      order += 1;
      userCount += 1;
      const item: AgentUserTurnItem = {
        kind: "user",
        // user id 鏡像 reducer 的 `user-<該 kind 已有條目數>`：後續樂觀
        // 插入沿同一計數續號，不撞 React key。
        id: `user-${userCount - 1}`,
        seq: order,
        text: userText,
      };
      if (attachments.length > 0) item.attachments = attachments;
      items.push(item);
      continue;
    }

    if (role !== "assistant") {
      // 未知角色（髒資料）：整則跳過，逐 part 計數留痕。
      for (let i = 0; i < parts.length; i += 1) drop("unknown-role");
      continue;
    }

    // assistant：text/reasoning 順次累積；遇到 tool/file 先打斷成卡，
    // 保持「文字→工具→文字→圖」的原始時序。
    let pendingText: string[] = [];
    let pendingReasoning: string[] = [];
    const flush = (): void => {
      // 內部框架段剝離（live 路徑 gateway 出站已剝、歷史路徑此前漏）：
      // `## Objective` 等模型工作狀態骨架不得當正文渲染。
      const text = stripInternalSections(pendingText.join("\n"));
      const reasoning = pendingReasoning.join("\n");
      pendingText = [];
      pendingReasoning = [];
      if (text.length === 0 && reasoning.length === 0) return;
      order += 1;
      const item: AgentAssistantTextItem = {
        kind: "assistant",
        id: `assistant-h${order}`,
        seq: order,
        text,
        // 歷史已定案：false，讓後續增量的 message.delta 開新條目而不是
        // 往殭屍氣泡裡續字。（進行中 turn 的尾巴由 SSE 增量重開新泡，
        // 代價是氣泡分裂，好過詐尸流式。）
        streaming: false,
      };
      if (reasoning.length > 0) item.reasoning = reasoning;
      items.push(item);
    };

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      const type = asString(part?.type) ?? "malformed";
      if (!part) {
        drop(type);
        continue;
      }
      if (type === "text") {
        const t = asString(part.text);
        if (t && t.trim().length > 0) pendingText.push(t);
        continue;
      }
      if (type === "reasoning") {
        const t = asString(part.text);
        if (t && t.trim().length > 0) pendingReasoning.push(t);
        continue;
      }
      if (type === "tool") {
        flush();
        const st = asRecord(part.state);
        const status = toolStatus(st?.status);
        const tool = asString(part.tool) ?? asString(part.name);
        if (!st || status === null || !tool) {
          drop("tool");
          continue;
        }
        order += 1;
        const item: AgentToolCallItem = {
          kind: "tool",
          id: `tool-h${order}`,
          seq: order,
          tool,
          status,
        };
        const summary = argsSummary(st.input);
        if (summary !== undefined) item.argsSummary = summary;
        if (status === "failed") {
          const err = toolErrorText(st.error);
          if (err !== undefined) item.error = err;
        }
        items.push(item);
        continue;
      }
      if (type === "file") {
        // 媒體卡會切斷文字段落（同 tool 的處理）：否則卡在先、其前面的
        // 文字在訊息尾聲才 flush，時序就顛倒了。
        flush();
        if (!isPublicUrl(part.url)) {
          drop("file-no-public-url");
          continue;
        }
        const mime = asString(part.mime);
        const filename = asString(part.filename);
        const kind = mediaKind(mime, filename, part.url);
        if (kind === null) {
          drop("media-unknown-kind");
          continue;
        }
        const dedupeKey = `${kind}:${part.url}`;
        if (seenMedia.has(dedupeKey)) continue; // 鏡像 reducer 的同 url 去重守衛
        seenMedia.add(dedupeKey);
        order += 1;
        if (kind === "image") {
          imageSeq += 1;
          const item: AgentImageItem = { kind: "image", id: `image-h${order}`, seq: imageSeq, url: part.url };
          items.push(item);
        } else if (kind === "video") {
          videoSeq += 1;
          // mediaKind 欄位（"film"/"video"）歷史無從判定，缺省按 "video" 展示。
          const item: AgentVideoItem = { kind: "video", id: `video-h${order}`, seq: videoSeq, url: part.url };
          items.push(item);
        } else {
          audioSeq += 1;
          const item: AgentAudioItem = { kind: "audio", id: `audio-h${order}`, seq: audioSeq, url: part.url };
          items.push(item);
        }
        continue;
      }
      // step-start / step-finish / patch / snapshot 等 opencode 內部片段：跳過計數。
      drop(type);
    }
    flush();
  }

  return { items, droppedParts, droppedByType };
}
