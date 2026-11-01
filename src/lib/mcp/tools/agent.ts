import { textResult, truncateToolText } from "../protocol";
import { AGENT_SESSIONS_PATH, AGENT_SETTINGS_PATH, RUN_AGENT_DEFAULT_TIMEOUT_SECONDS, RUN_AGENT_MAX_TIMEOUT_SECONDS, RUN_AGENT_POLL_INTERVAL_MS } from "./constants";
import { compact, pickString } from "./helpers";
import type { McpDispatchResponse, McpToolCallResult, McpToolContext } from "./types";
import { isPlainObject } from "./validation";

// ─────────────────────────────────────────── Eimu agent 闸道（B 端密钥 → /api/agent/biz 代理）
//
// 这条线早已存在：`/api/agent/biz/[...path]` 用**呼叫者自己的 B 端密钥**鉴权，换发成业主派生 key
// 后转发 VPS 闸道 `/agent/v1/<subPath>`，身分空间与网页版 AI 助理完全相同（同 settings、
// 同 orchestrator、beast_mode 为帐号级设定）。本节只把它投影到工具面，不重写任何业务。
// 硬限制：该代理的 JSON 路径有 10s 逾时（`BIZ_PROXY_JSON_TIMEOUT_MS`），故 `run_agent`
// 必须「送一轮快回、之后反覆轮询」，绝不能在一个请求里等完整回合。

export function agentSessionPath(sessionId: string, suffix = ""): string {
  return `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}${suffix}`;
}

/** 预设睡眠（测试以 `ctx.sleep` 注入 no-op，不真的等秒）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 上游非 2xx：与 `runForward` 同语义的工具错误（附已消毒原文）。 */
function agentUpstreamFailure(method: string, path: string, response: McpDispatchResponse): McpToolCallResult {
  return textResult(
    `上游 ${method} ${path} 回应 HTTP ${response.status}：\n${truncateToolText(response.text)}`,
    true,
  );
}

/** 从 POST /sessions 回包取 `session_id`（形状未实测：容忍顶层与 `session.session_id`，取不到回 undefined）。 */
function extractSessionId(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  const direct = payload.session_id;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const nested = payload.session;
  if (isPlainObject(nested)) {
    const id = nested.session_id;
    if (typeof id === "string" && id.trim() !== "") return id.trim();
  }
  return undefined;
}

interface AgentMessage {
  role: string;
  text: string;
  created_at?: unknown;
}

/** 简化 transcript 的 `messages`（非阵列/非物件一律略过，不假装有内容）。 */
function readAgentMessages(payload: unknown): AgentMessage[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.messages)) return [];
  const out: AgentMessage[] = [];
  for (const entry of payload.messages) {
    if (!isPlainObject(entry)) continue;
    out.push({
      role: typeof entry.role === "string" ? entry.role : "",
      text: typeof entry.text === "string" ? entry.text : "",
      ...(entry.created_at !== undefined ? { created_at: entry.created_at } : {}),
    });
  }
  return out;
}

/** 上游 `message_count`（缺栏位回 null，由呼叫方回退成 `messages.length`）。 */
function readAgentMessageCount(payload: unknown): number | null {
  if (!isPlainObject(payload)) return null;
  const count = payload.message_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

// ── artifacts 抽取（「透传」的核心）：抽媒体 URL 的同时保留原文 reply ──

const ARTIFACT_IMAGE_EXTENSION = /\.(webp|png|jpe?g)(?:[?#]|$)/i;
const ARTIFACT_VIDEO_EXTENSION = /\.(mp4|webm|mov)(?:[?#]|$)/i;
const ARTIFACT_AUDIO_EXTENSION = /\.(mp3|wav|flac|m4a)(?:[?#]|$)/i;
/** 非 ASCII（全形标点／中文）一律视为 URL 边界：回覆常写「…/a.png（2.31 MB）」，不截会把「（2.31」吞进 URL（2026-11-01 生产实测）。合法 URL 的非 ASCII 字元应已 percent-encode。 */
const ARTIFACT_URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}\u0080-\uFFFF]+/g;
const ARTIFACT_MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s\u0080-\uFFFF]+)\s*\)/g;
/** 既知媒体目录：即使无副档名也当产物（kind=file）。 */
const ARTIFACT_MEDIA_PATH = "/image-data/files/";

export type AgentArtifactKind = "image" | "video" | "audio" | "file";

function artifactKind(url: string): AgentArtifactKind {
  if (ARTIFACT_VIDEO_EXTENSION.test(url)) return "video";
  if (ARTIFACT_AUDIO_EXTENSION.test(url)) return "audio";
  if (ARTIFACT_IMAGE_EXTENSION.test(url)) return "image";
  return "file";
}

export function guessArtifactMime(url: string, kind: AgentArtifactKind): string {
  const lower = url.toLowerCase();
  if (lower.includes(".webm")) return "video/webm";
  if (lower.includes(".mov")) return "video/quicktime";
  if (lower.includes(".mp4")) return "video/mp4";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".mp3")) return "audio/mpeg";
  if (lower.includes(".wav")) return "audio/wav";
  if (lower.includes(".flac")) return "audio/flac";
  if (lower.includes(".m4a")) return "audio/mp4";
  if (kind === "video") return "video/mp4";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "image") return "image/png";
  return "application/octet-stream";
}

/**
 * 导演产物分类（film / storyboard / brief / bible / keyframes / stills / audio）。
 * keyframes 只承接首尾帧／镜头帧语义；非分镜板的成品静帧（电商主图、卖点、细节、包装等）进 stills。
 */
export type DirectorArtifactCategory = "film" | "storyboard" | "brief" | "bible" | "keyframes" | "stills" | "audio";

export const DIRECTOR_ARTIFACT_CATEGORIES: readonly DirectorArtifactCategory[] = [
  "film",
  "storyboard",
  "brief",
  "bible",
  "keyframes",
  "stills",
  "audio",
];

export interface ClassifiedArtifact {
  url: string;
  mime: string;
  /** 回覆里贴着该 URL 的标签（markdown alt／同行前缀，如「主图」「卖点2」）；抽不到时回落为分类名。 */
  label: string;
  kind: AgentArtifactKind;
  category: DirectorArtifactCategory;
}

/** 明确的首尾帧／关键帧语义（URL 或标签）。 */
const KEYFRAME_STRONG = /keyframe|key.?frame|first.?frame|last.?frame|end.?frame|start.?frame|首帧|尾帧|末帧|关键帧|起始帧|结束帧|起幅|落幅/;
/** 弱镜头帧线索：仅 URL 命名或「镜头N」标签，排在电商词之后。 */
const KEYFRAME_WEAK_URL = /shot[-_]|frame[-_]/;
const KEYFRAME_WEAK_LABEL = /镜头|第\s*\d+\s*镜|\bshot\s*\d/;
const STORYBOARD_URL = /storyboard|story-board|story_board|board\b|panel/;
const STORYBOARD_LABEL = /storyboard|分镜|故事板/;
/** 电商／成品静帧词：标签中文词，或 URL 里较不歧义的英文 slug。 */
const STILLS_LABEL = /主图|副图|卖点|细节|特写|包装|尺寸|场景图|白底|详情|套图|海报|商品|产品图|模特|上身|平铺|kv\b|banner|hero|detail|packag|lifestyle|product/;
const STILLS_URL = /hero|main[-_]?image|detail|packag|lifestyle|white[-_]?bg|ecom|product|poster|banner/;
const BIBLE_LABEL = /设定集|世界观|美术设定|角色设定|角色卡|风格指南/;

export function classifyArtifactCategory(url: string, kind: AgentArtifactKind, label = ""): DirectorArtifactCategory {
  const u = url.toLowerCase();
  const l = label.toLowerCase();
  if (kind === "audio" || ARTIFACT_AUDIO_EXTENSION.test(url)) return "audio";
  if (kind === "video" || ARTIFACT_VIDEO_EXTENSION.test(url)) {
    if (/storyboard|story-board|story_board/.test(u) || STORYBOARD_LABEL.test(l)) return "storyboard";
    return "film";
  }
  if (/\bbrief\b|treatment|synopsis/.test(u)) return "brief";
  if (/bible|world.?build|lore|art.?direction|character.?sheet|style.?guide/.test(u) || BIBLE_LABEL.test(l)) return "bible";
  if (STORYBOARD_URL.test(u)) return "storyboard";
  if (KEYFRAME_STRONG.test(u) || KEYFRAME_STRONG.test(l)) return "keyframes";
  if (STORYBOARD_LABEL.test(l)) return "storyboard";
  if (STILLS_LABEL.test(l) || STILLS_URL.test(u)) return "stills";
  if (KEYFRAME_WEAK_URL.test(u) || KEYFRAME_WEAK_LABEL.test(l)) return "keyframes";
  if (kind === "image") return "stills";
  return "brief";
}

export function classifyDirectorArtifacts(
  items: Array<{ url: string; kind: AgentArtifactKind; label?: string }>,
): Record<DirectorArtifactCategory, ClassifiedArtifact[]> {
  const buckets = Object.fromEntries(DIRECTOR_ARTIFACT_CATEGORIES.map((c) => [c, []])) as unknown as Record<
    DirectorArtifactCategory,
    ClassifiedArtifact[]
  >;
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const hint = item.label?.trim() ?? "";
    const category = classifyArtifactCategory(item.url, item.kind, hint);
    buckets[category].push({
      url: item.url,
      mime: guessArtifactMime(item.url, item.kind),
      label: hint || category,
      kind: item.kind,
      category,
    });
  }
  return buckets;
}

/**
 * URL 前同一行的短标签：取上一处 URL／换行之后、最后一个句读之后的片段，去掉 markdown 记号与尾冒号。
 * 例：「- **主图（白底）**：https://…」→「主图（白底）」；「（2.31 MB），成片：https://…」→「成片」。
 */
function labelBefore(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let seg = text.slice(lineStart, index);
  const prevUrl = seg.search(/https?:\/\/\S*$/) >= 0 ? -1 : seg.lastIndexOf("http");
  if (prevUrl >= 0) seg = seg.slice(prevUrl).replace(/^https?:\/\/[^\s\u0080-\uFFFF]*/, "");
  const parts = seg.split(/[，。；;,|]|\s[-–—]\s/);
  let tail = "";
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const cleaned = parts[i]
      .replace(/[!*_`#>[\]()]/g, "")
      .replace(/^\s*(?:[-+]|\d+[.)、])\s*/, "")
      .replace(/[\s:：=→\-–—]+$/, "")
      .trim();
    if (cleaned) {
      tail = cleaned;
      break;
    }
  }
  return tail.length > 40 ? tail.slice(-40) : tail;
}

/**
 * 从回覆文字抽出成品媒体 URL：图片／影片／音频（mp3/wav/flac/m4a），以及 markdown 图片
 * `![alt](url)`。非媒体的普通连结不列入。保持出现顺序、同 URL 去重，
 * kind 以「更明确者优先」（image/video/audio 不被 file 覆盖）。
 * 对外形状维持 { url, kind }（get_agent_session 等既有契约）；带标签版见 extractLabeledAgentArtifacts。
 */
export function extractAgentArtifacts(text: string): Array<{ url: string; kind: AgentArtifactKind }> {
  return extractLabeledAgentArtifacts(text).map(({ url, kind }) => ({ url, kind }));
}

/** 同 extractAgentArtifacts，另带 label：markdown alt 优先，否则取同行前缀（导演分类用）。 */
export function extractLabeledAgentArtifacts(text: string): Array<{ url: string; kind: AgentArtifactKind; label?: string }> {
  const found = new Map<string, { kind: AgentArtifactKind; label: string }>();
  const consider = (raw: string, viaMarkdownImage: boolean, label: string) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(url)) return;
    const kind = artifactKind(url);
    // 原始 URL 只收媒体（已知副档名或 /image-data/files/）；markdown 图片一律收。
    if (!viaMarkdownImage && kind === "file" && !url.includes(ARTIFACT_MEDIA_PATH)) return;
    const resolved = viaMarkdownImage && kind === "file" ? "image" : kind;
    const existing = found.get(url);
    if (existing) {
      if (!existing.label && label) existing.label = label;
      if (existing.kind === "image" || existing.kind === "video" || existing.kind === "audio") return;
      existing.kind = resolved;
      return;
    }
    found.set(url, { kind: resolved, label });
  };
  for (const match of text.matchAll(ARTIFACT_MARKDOWN_IMAGE_PATTERN)) {
    const alt = (match[0].match(/^!\[([^\]]*)\]/)?.[1] ?? "").trim();
    consider(match[1], true, alt || labelBefore(text, match.index ?? 0));
  }
  for (const match of text.matchAll(ARTIFACT_URL_PATTERN)) consider(match[0], false, labelBefore(text, match.index ?? 0));
  return [...found.entries()].map(([url, v]) => (v.label ? { url, kind: v.kind, label: v.label } : { url, kind: v.kind }));
}

/** 从多段文字合并抽产物并分类。 */
export function collectClassifiedArtifacts(texts: string[]): Record<DirectorArtifactCategory, ClassifiedArtifact[]> {
  const merged: Array<{ url: string; kind: AgentArtifactKind; label?: string }> = [];
  for (const text of texts) merged.push(...extractLabeledAgentArtifacts(text));
  return classifyDirectorArtifacts(merged);
}

/**
 * 把任务交给 Eimu 的 agent orchestrator，并以**反覆轮询**取回覆（单次请求一律 <10s）。
 *
 * 完成判准：基线（送讯息前的 `message_count`）之后出现 role=assistant 且 text 非空的讯息。
 * （规格里的判准②「`/sessions` 列表 status=idle 且已有新 assistant 讯息」与①等价——
 * 两者都要求「已有新 assistant 讯息」，故以①为单一判准，不多打一次列表请求。）
 *
 * 逾时不丢错：回 status:"running" 与目前最后一则回覆，让呼叫方自行用 `get_agent_session` 续查。
 */
export async function runAgent(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult> {
  const prompt = pickString(args, "prompt") ?? "";
  const directive = pickString(args, "session_directive");
  const requestedTimeout =
    typeof args.timeout_seconds === "number" ? args.timeout_seconds : RUN_AGENT_DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Math.min(Math.max(1, requestedTimeout), RUN_AGENT_MAX_TIMEOUT_SECONDS);
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const startedAt = now();
  const deadlineAt = startedAt + timeoutSeconds * 1000;

  let sessionId = pickString(args, "session_id") ?? "";
  if (!sessionId) {
    const created = await ctx.dispatcher({
      method: "POST",
      path: AGENT_SESSIONS_PATH,
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "run_agent",
      body: {},
    });
    if (created.status < 200 || created.status >= 300) {
      return agentUpstreamFailure("POST", AGENT_SESSIONS_PATH, created);
    }
    sessionId = extractSessionId(parseJsonLoose(created.text)) ?? "";
    if (!sessionId) {
      throw new Error("建立 agent 会话失败：上游回包没有 session_id（可用 list_agent_sessions 确认会话列表）。");
    }
  }

  // 基线：送讯息前的 message_count（判准靠它区分新旧回覆；读不到就退回 0）。
  const before = await ctx.dispatcher({
    method: "GET",
    path: agentSessionPath(sessionId),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "run_agent",
  });
  const baselinePayload = before.status >= 200 && before.status < 300 ? parseJsonLoose(before.text) : undefined;
  const baseline = readAgentMessageCount(baselinePayload) ?? readAgentMessages(baselinePayload).length;

  // 送一轮（快回 accepted；确切 status/body 未实测，容忍 2xx 空 body）。
  const sent = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(sessionId, "/messages"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "run_agent",
    body: compact({ content: prompt, session_directive: directive }),
  });
  if (sent.status < 200 || sent.status >= 300) {
    return agentUpstreamFailure("POST", agentSessionPath(sessionId, "/messages"), sent);
  }

  // 轮询：每 2s 一次简化端点（绝不用 /messages——回包大又不保证 <10s）。
  let reply = "";
  let fresh: AgentMessage[] = [];
  for (;;) {
    const detail = await ctx.dispatcher({
      method: "GET",
      path: agentSessionPath(sessionId),
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "run_agent",
    });
    if (detail.status >= 200 && detail.status < 300) {
      const messages = readAgentMessages(parseJsonLoose(detail.text));
      fresh = baseline < messages.length ? messages.slice(baseline) : [];
      const assistant = fresh.filter((message) => message.role === "assistant" && message.text.trim() !== "");
      if (assistant.length > 0) {
        reply = assistant[assistant.length - 1].text;
        break;
      }
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) break;
    await sleep(Math.min(RUN_AGENT_POLL_INTERVAL_MS, remaining));
  }

  const completed = reply !== "";
  return textResult(
    JSON.stringify(
      {
        session_id: sessionId,
        status: completed ? "completed" : "running",
        reply,
        artifacts: extractAgentArtifacts(reply),
        ...(fresh.length > 0 ? { messages: fresh } : {}),
        elapsed_ms: now() - startedAt,
        ...(completed
          ? {}
          : {
              hint: `未在 ${timeoutSeconds}s 内等到回覆；任务可能仍在跑，用 get_agent_session（session_id=${sessionId}）续查。`,
            }),
      },
      null,
      2,
    ),
  );
}
