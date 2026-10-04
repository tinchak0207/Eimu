// opencode 全量历史 → AgentTranscriptItem[] 的归一化（纯函数）。
//
// 为什么要这层：「回到历史会话」改由 GET /api/agent/sessions/[id] 的全量
// 历史重建 transcript，不再依赖网关 1000 帧 ring buffer 回放（长会话会被
// 截断成空白）。opencode 的 messages 是 [{info:{id,role,time,tokens},parts:[...]}]
// 的原始 shape，与前端渲染模型（AgentTranscriptItem）不同构，中间需要一个
// 忠实且防炸的映射层。
//
// 纪律：
//   - 纯函数：不碰 React / DOM / Date.now / Math.random，同输入同输出，
//     `npx tsx --test` 直接测。
//   - 结构规则忠实对齐 agent-chat-reducer：
//       * assistant 文字条目 streaming=false（历史已定案，不诈尸流式）；
//       * image/video/audio 的 seq 是「该 kind 会话内展示序号」（镜像
//         image.done 的 imageSeq 语义），锚定文案「第 N 张」直接唼它；
//         user/assistant/tool 的 seq 用全局递增的合成游标（严格递增）；
//       * id 用 `<kind>-<全局序>`，全阵列唯一，且与 SSE 事件的
//         `<kind>-<event_id>` 命名空间文字上不撞（合成游标带 h 前缀）。
//   - 产出的每个 item 必须能过 persistence.ts 的 sanitizeItemsForStorage
//     白名单（ITEM_KINDS）：只会产出 user/assistant/tool/image/video/audio
//     /subagent_result，不产 director/subagent/notice。附件 url 只收
//     http(s)（data: 的 base64 严禁进 localStorage）。
//   - 未知 part / 脏资料一律跳过不炸，丢弃计进 droppedParts 统计。

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

/** 归一化结果：items 供 restore；dropped 统计供排观（测试断言用）。 */
export interface NormalizeHistoryResult {
  items: AgentTranscriptItem[];
  /** 被丢弃的 part 总数（未知型别、无公网 URL 的媒体、脏 tool 等）。 */
  droppedParts: number;
  /** 丢弃原因分桶，key 为 part 型别或归类标签。 */
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

/** 只认公网 http(s) URL：data: URI 是 base64，落存档会撑爆 localStorage。 */
function isPublicUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)([?#]|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)([?#]|$)/i;

/** 依 mime（优先）与副档名判媒体三类；判不出回 null。 */
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

/** 附件 kind 对齐 client 的 toAgentAttachmentRef：image/→image，video/→video，其余→document（副档名兜底）。 */
function attachmentKind(mime: string | undefined, name: string | undefined, url: string): AgentAttachmentRef["kind"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  const probe = mediaKind(undefined, name, url);
  if (probe === "image" || probe === "video") return probe;
  return "document";
}

/** opencode tool part 的 state.status → 前端状态枚举；判不了回 null（丢弃）。 */
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

/** 工具参数摘要：字串直用，其余 JSON 化并截断（存档瘦身，也与 live 的 args_summary 同量级）。 */
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

/** 失败原因：opencode 的 state.error 多为字串；物件退而取 message，再退 JSON。 */
function toolErrorText(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  const rec = asRecord(raw);
  if (rec) {
    const msg = asString(rec.message);
    if (msg) return msg;
  }
  return undefined;
}

// ─────────────────────────── 系统注入讯息识别（归因错觉病灶）

// gateway 机制上必须以 user role 注入会话的三类讯息（唤醒/重试提示/召回前缀），
// 历史路径若一律画成用户气泡，用户事后翻记录会看到自己「说过」从没说过的话。
// 识别标记全部对齐后端真源（deploy-staging/gateway）：index.ts wakeSessionForSubagent、
// opencode-event-handler.ts turn failover、memory-recall.ts renderRecallPrefix。

/** 子代理唤醒讯息骨架（真源 gateway/index.ts wakeSessionForSubagent，勿改后端）。 */
const SUBAGENT_WAKE_RE =
  /^【子代理(完成|失败)·系统自动唤醒】subagent\s+([0-9A-Za-z]+)（label="([^"]*)"）已(?:完成|失败)。(?:结果摘要|失败原因)：/;

/** 唤醒讯息尾部固定的续跑指令行（给模型的指令，不是产出内容）。 */
const SUBAGENT_WAKE_TAIL = "请基于以上真实结果继续推进";

/**
 * 解析子代理唤醒讯息。命中回 {status, subagentId, label, text(产出正文)}；
 * 标记对但骨架漂移（label 含引号等）走兜底尽力提取——总之绝不冒充用户气泡。
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

/** 记忆召回知识块标记行开头（真源 gateway/memory-recall.ts RECALL_HEADER）。 */
const RECALL_BLOCK_MARKER = "[相关领域知识";

/** 知识块内容行：`- [domain] slug` 条目行或缩两格的 body 延续行。 */
function isRecallBodyLine(l: string): boolean {
  return /^- \[[^\]]*\]\s*\S/.test(l) || /^ {2,}\S/.test(l);
}

/**
 * 从用户文本剥离 gateway 注入的记忆召回知识块。位置无关（头/尾皆处理）：
 * messages-gw.ts 现场实际是前缀注入（`prefix + "\n\n" + 用户正文`），
 * 旧规格描述的「尾部追加」也一并覆盖。找不到标记原样返回。
 * 块 = 标记行 + 若干条目/body 行，直到空行接非块内容或文本结束。
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
    break; // 块结束：此行起属于用户正文（前缀注入的分隔空行也在此消掉）
  }
  // 尾部注入：块吞到文本结束（或只剩残留空行）→ 前文的收尾空行一并吃掉。
  const atTail = i >= lines.length || lines.slice(i).every((l) => l.trim().length === 0);
  if (i < lines.length && !atTail) out.push(...lines.slice(i));
  let res = out.join("\n");
  if (head === 0) res = res.replace(/^(?:[ \t]*\n)+/, ""); // 前缀剥离：吃掉残留空行
  if (atTail) res = res.replace(/(?:[ \t]*\n)+$/, "");
  return res;
}

/** 内部框架段标题行（live 路径真源 gateway/outbound-sanitize.ts + e2e 实锤的 Progress Summary）。 */
export const INTERNAL_SECTION_HEADING_RE =
  /^#{1,6}[ \t]*(?:objective|work state|next move|relevant files|important details|completed|active|blocked|progress summary)[ \t]*:?[ \t]*$/i;

const ANY_HEADING_RE = /^#{1,6}[ \t]/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * assistant 历史文本的内部框架段剥离（live 路径 gateway 出站已剥、历史路径漏）：
 * `## Objective` 等标题行起吞到下一个非内部 markdown 标题或文本结束；
 * 代码栅栏（``` / ~~~）内容直通不判。无内部段时原样返回（零改动）。
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
      // 内部段到下一个「非内部」标题为止；下一个内部段标题继续吞。
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

// ─────────────────────────── 归一化主体

/**
 * 把 opencode 原始讯息阵列重建为前端 transcript。
 *
 * 映射表（part.type → item）：
 *   user.text      → 拼接进该轮 user item 的 text
 *   user.file      → user item 的 attachments（仅 http(s) URL；镜像 live 上传语义）
 *   assistant.text → 顺次累积进当前 assistant item（工具/媒体卡会切断段落）
 *   assistant.reasoning → 并入 assistant item 的 reasoning 栏位（型别有承载，不丢）
 *   assistant.tool → tool item（completed→ok / error→failed / running、pending→running）
 *   assistant.file → image/video/audio item（按 mime/副档名；判不出或无公网 URL 丢弃计数）
 *   其余（step-start/patch/…）→ 跳过并计数
 */
export function normalizeOpenCodeMessages(messages: OpenCodeMessage[]): NormalizeHistoryResult {
  const items: AgentTranscriptItem[] = [];
  const droppedByType: Record<string, number> = {};
  let droppedParts = 0;
  const drop = (type: string): void => {
    droppedParts += 1;
    droppedByType[type] = (droppedByType[type] ?? 0) + 1;
  };

  // 全局序：id 后缀（h 前缀隔开 SSE 的 <kind>-<event_id> 命名空间）；
  // 同时是 user/assistant/tool 的 seq（严格递增）。
  let order = 0;
  // 媒体 seq：该 kind 会话内展示序号（镜像 reducer 的 imageSeq 语义）。
  let imageSeq = 0;
  let videoSeq = 0;
  let audioSeq = 0;
  let userCount = 0;
  // 同 kind 同 url 去重（镜像 reducer 的 exists 守卫：重复完成幰不刷两张卡）。
  const seenMedia = new Set<string>();

  for (const rawMsg of Array.isArray(messages) ? messages : []) {
    const msg = asRecord(rawMsg);
    const info = asRecord(msg?.info);
    const role = asString(info?.role);
    const parts = Array.isArray(msg?.parts) ? (msg.parts as unknown[]) : null;
    if (!parts) {
      // 整则讯息不可用：无 part 可逐个计，算一个 message 级丢弃。
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
          // 使用者上传附件镜像 live 语义：挂在 user item 的 attachments 上，
          // 不是漂浮的媒体卡；只收公网 URL（data: base64 严禁进存档）。
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

      // ① 子代理唤醒讯息：机制上必须走 user role，但它是系统注入，不是用户
      // 说的话——渲染成 subagent_result 产出卡（前端已有
      // AgentSubagentReportCard），绝不画成用户气泡。占 order seq 保时序，
      // 不占 userCount（不是用户轮，user id 续号不受污染）。
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

      // ② 系统重试提示（上游错误后 gateway 的续跑指令）：整条不显示。
      const trimmed = text.trim();
      if (trimmed.startsWith("（系统提示：") && trimmed.endsWith("）")) {
        drop("system-hint");
        continue;
      }

      // ③ 记忆召回知识块（gateway 每回合注入的语料前缀）：从用户文本剥掉，
      // 只留用户真正说的话。剥完空文本且无附件 → 整条不留。
      const userText = stripRecallBlock(text);
      if (userText !== text && userText.trim().length === 0 && attachments.length === 0) {
        drop("recall-block");
        continue;
      }
      if (userText.length === 0 && attachments.length === 0) continue; // 全丢光的空轮不留言
      order += 1;
      userCount += 1;
      const item: AgentUserTurnItem = {
        kind: "user",
        // user id 镜像 reducer 的 `user-<该 kind 已有条目数>`：后续乐观
        // 插入沿同一计数续号，不撞 React key。
        id: `user-${userCount - 1}`,
        seq: order,
        text: userText,
      };
      if (attachments.length > 0) item.attachments = attachments;
      items.push(item);
      continue;
    }

    if (role !== "assistant") {
      // 未知角色（脏资料）：整则跳过，逐 part 计数留痕。
      for (let i = 0; i < parts.length; i += 1) drop("unknown-role");
      continue;
    }

    // assistant：text/reasoning 顺次累积；遇到 tool/file 先打断成卡，
    // 保持「文字→工具→文字→图」的原始时序。
    let pendingText: string[] = [];
    let pendingReasoning: string[] = [];
    const flush = (): void => {
      // 内部框架段剥离（live 路径 gateway 出站已剥、历史路径此前漏）：
      // `## Objective` 等模型工作状态骨架不得当正文渲染。
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
        // 历史已定案：false，让后续增量的 message.delta 开新条目而不是
        // 往僵尸气泡里续字。（进行中 turn 的尾巴由 SSE 增量重开新泡，
        // 代价是气泡分裂，好过诈尸流式。）
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
        // 媒体卡会切断文字段落（同 tool 的处理）：否则卡在先、其前面的
        // 文字在讯息尾声才 flush，时序就颠倒了。
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
        if (seenMedia.has(dedupeKey)) continue; // 镜像 reducer 的同 url 去重守卫
        seenMedia.add(dedupeKey);
        order += 1;
        if (kind === "image") {
          imageSeq += 1;
          const item: AgentImageItem = { kind: "image", id: `image-h${order}`, seq: imageSeq, url: part.url };
          items.push(item);
        } else if (kind === "video") {
          videoSeq += 1;
          // mediaKind 栏位（"film"/"video"）历史无从判定，缺省按 "video" 展示。
          const item: AgentVideoItem = { kind: "video", id: `video-h${order}`, seq: videoSeq, url: part.url };
          items.push(item);
        } else {
          audioSeq += 1;
          const item: AgentAudioItem = { kind: "audio", id: `audio-h${order}`, seq: audioSeq, url: part.url };
          items.push(item);
        }
        continue;
      }
      // step-start / step-finish / patch / snapshot 等 opencode 内部片段：跳过计数。
      drop(type);
    }
    flush();
  }

  return { items, droppedParts, droppedByType };
}
