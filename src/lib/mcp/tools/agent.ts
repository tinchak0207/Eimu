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
const ARTIFACT_URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]+/g;
const ARTIFACT_MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;
/** 既知媒体目录：即使无副档名也当产物（kind=file）。 */
const ARTIFACT_MEDIA_PATH = "/image-data/files/";

function artifactKind(url: string): "image" | "video" | "file" {
  if (ARTIFACT_VIDEO_EXTENSION.test(url)) return "video";
  if (ARTIFACT_IMAGE_EXTENSION.test(url)) return "image";
  return "file";
}

/**
 * 从回覆文字抽出成品媒体 URL：`/image-data/files/…` 的图片/影片，以及 markdown 图片
 * `![alt](url)`（作者已宣告是图）。非媒体的普通连结不列入。保持出现顺序、同 URL 去重，
 * kind 以「更明确者优先」（image/video 不被 file 覆盖）。
 */
function extractAgentArtifacts(text: string): Array<{ url: string; kind: "image" | "video" | "file" }> {
  const found = new Map<string, "image" | "video" | "file">();
  const consider = (raw: string, viaMarkdownImage: boolean) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(url)) return;
    const kind = artifactKind(url);
    // 原始 URL 只收媒体（已知副档名或 /image-data/files/）；markdown 图片一律收。
    if (!viaMarkdownImage && kind === "file" && !url.includes(ARTIFACT_MEDIA_PATH)) return;
    const resolved = viaMarkdownImage && kind === "file" ? "image" : kind;
    const existing = found.get(url);
    if (existing === "image" || existing === "video") return;
    found.set(url, resolved);
  };
  for (const match of text.matchAll(ARTIFACT_MARKDOWN_IMAGE_PATTERN)) consider(match[1], true);
  for (const match of text.matchAll(ARTIFACT_URL_PATTERN)) consider(match[0], false);
  return [...found.entries()].map(([url, kind]) => ({ url, kind }));
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
