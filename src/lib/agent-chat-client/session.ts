import type { AgentAttachmentRef, AgentQuotaState } from "../agent-chat-types/types-core";
import type { AgentSessionHistoryResponse, AgentSubagentRunSummary, AgentSubagentTranscriptEntry, AgentSubagentTranscriptPage, OpenCodeMessage } from "../agent-chat-types/types-agent";
import type { AgentQuotaWire, AgentSessionInfo, AgentSessionSummary, DirectSendContext, SendAgentMessageOptions } from "./types";
import { AgentChatError } from "./types";
import { agentFetch, authHeaders, extractMessage, fallbackMessage, mapErrorCode, mapHttpStatus } from "./auth";
import { attemptDirectSend, collectClientEnvironment, deriveMessagesUrl, directSendEligible } from "./transport";
import { UploadAbortedError, xhrUploadForm } from "../agent-uploads";
import { getDeviceBridgeApi, isDeviceBridgeApi, type LocalFileMode } from "../device-bridge-display";
/** 会话记忆补注：resume/switch 的老会话补上帐户画像（best-effort，失败不打扰）。 */
export async function patchAgentSessionMemory(sessionId: string): Promise<void> {
  try {
    await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/memory`, { method: "POST" });
  } catch {
    // 补不上就算了：下一次建新会话时记忆仍会正常注入。
  }
}
/** 列出当前用户的历史会话（按 updated_at 降序）。 */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  const data = await agentFetch('/api/agent/sessions', { method: 'GET' });
  const sessions = (data as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(
    (it): it is AgentSessionSummary =>
      typeof it === 'object' && it !== null && typeof (it as AgentSessionSummary).session_id === 'string',
  );
}

/**
 * 列出某会话的子代理运行（网关 GET /agent/v1/sessions/:id/subagents 透传）。
 * 阵列形状不对时回空表（与 listAgentSessions 同语义），不把列表故障升级成聊天故障。
 */
export async function listAgentSubagents(sessionId: string): Promise<AgentSubagentRunSummary[]> {
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents`, {
    method: "GET",
  });
  const subagents = (data as { subagents?: unknown })?.subagents;
  if (!Array.isArray(subagents)) return [];
  return subagents.filter(
    (it): it is AgentSubagentRunSummary =>
      typeof it === "object" && it !== null && typeof (it as AgentSubagentRunSummary).id === "string",
  );
}

/**
 * 读一页子代理转录。offset 缺省从 0 开始；续拉只喂上一页的 next_offset。
 * 404 沿 agentFetch 既有 not_found 语义；entries 不是阵列＝契约破裂，丢 parse_error。
 */
export async function readAgentSubagentTranscript(
  sessionId: string,
  runId: string,
  offset?: number,
): Promise<AgentSubagentTranscriptPage> {
  const query =
    typeof offset === "number" && Number.isFinite(offset)
      ? `?offset=${Math.max(0, Math.floor(offset))}`
      : "";
  const data = await agentFetch(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(runId)}${query}`,
    { method: "GET" },
  );
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.entries)) {
    throw new AgentChatError("parse_error", "服务器未返回有效的子代理日志。");
  }
  const entries = d.entries as AgentSubagentTranscriptEntry[];
  const asNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const base = typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return {
    object: typeof d.object === "string" ? d.object : "",
    run_id: typeof d.run_id === "string" ? d.run_id : runId,
    entries,
    // next_offset 缺栏时按本页长度推进——否则轮询会在原地重读同一页。
    next_offset: asNumber(d.next_offset) ?? base + entries.length,
    truncated: d.truncated === true,
    eof: d.eof === true,
    size: asNumber(d.size) ?? 0,
  };
}

/**
 * 请求停止一个仍在运行的子代理。409 not_running 由调用端视为「已结束」，
 * 不当失败提示（网关契约：{ok:false,code:"not_running"}）。
 */
export async function stopAgentSubagent(sessionId: string, runId: string): Promise<void> {
  await agentFetch(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(runId)}/stop`,
    { method: "POST" },
  );
}

// ─────────────────────────── 公开 API


/** 建一个 agent 会话。 */
export async function createAgentSession(): Promise<AgentSessionInfo> {
  const data = await agentFetch("/api/agent/sessions", { method: "POST", body: "{}" });
  const sessionId = (data as AgentSessionInfo)?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new AgentChatError("parse_error", "服务器未返回有效的 session_id。");
  }
  return data as AgentSessionInfo;
}
/**
 * 送一条对话消息。网道回 202 即算已收。
 *
 * 09-12 起带可选第 4 参数 direct：有现任 SSE 票且未闩锁 → 先直连网关；
 * 票不可用/401/网路错/5xx → 落回原有 Vercel 中继路径（用户零感知）。
 * 不带 direct 时与旧行为逐字元等价（老呼叫点不用改）。
 */
export async function sendAgentMessage(
  sessionId: string,
  content: string,
  options?: SendAgentMessageOptions,
  direct?: DirectSendContext | null,
): Promise<void> {
  // 旧桌面停桥不会调用新权限端点；发送前以真实本机mode撤销云端残留full。
  const desktop = getDeviceBridgeApi();
  if (desktop) {
    if (!isDeviceBridgeApi(desktop)) {
      throw new AgentChatError("bad_request", "无法读取桌面权限，消息尚未发送，请更新桌面版后重试。");
    }
    const status = await desktop.bridge.status();
    if (!["off", "ask", "auto", "full"].includes(status.mode ?? "")) {
      throw new AgentChatError("bad_request", "无法确认桌面权限模式，消息尚未发送，请更新桌面版后重试。");
    }
    await syncDevicePermissionMode(status.mode as LocalFileMode);
  }
  // 中继路由会 trim 后才转发；直连自己先 trim，两条路径送到网关的 content 等价。
  const trimmed = content.trim();
  const body: Record<string, unknown> = { content: trimmed };
  if (options?.canvasState !== undefined && options.canvasState !== null) {
    body.canvas_state = options.canvasState;
  }
  if (typeof options?.sessionDirective === "string" && options.sessionDirective.trim().length > 0) {
    body.session_directive = options.sessionDirective;
  }
  // 客户端环境上报（本包）：与 content/canvas_state/session_directive 同一 payload，
  // 直连与中继两条腿共用同一 body，闸道据此生成环境段（栏位缺失时闸道行为不变）。
  body.client_environment = await collectClientEnvironment();
  if (direct && !direct.capability.rejected) {
    const messagesUrl = deriveMessagesUrl(direct.ticket.events_url);
    if (messagesUrl && directSendEligible(trimmed, options)) {
      const outcome = await attemptDirectSend(messagesUrl, body, direct.ticket.ticket, direct.capability);
      if (outcome === "sent") return;
      // fallback：继续往下走中继，仅此一次。
    }
  }
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 旧／新桌面共用已鉴权站点通路；成功才允许本机切档或发送新消息。 */
export async function syncDevicePermissionMode(mode: LocalFileMode): Promise<void> {
  const result = await agentFetch("/api/agent/device-permissions", {
    method: "POST",
    body: JSON.stringify({ mode }),
  }) as { success?: boolean; mode?: string };
  if (result?.success !== true || result.mode !== mode) {
    throw new AgentChatError("gateway_error", "权限模式未同步，当前选择未更改，消息尚未发送。请稍后重试。");
  }
}
/**
 * 网道附件清单：每个元素带 path/mime/size，直接转成 AgentAttachmentRef。
 * 依 mime 决定 kind：影像 → "image"，影片 → "video"，其余 → "document"。
 */
export interface AgentAttachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

/** 把网道回传的附件物件映射成前端 ref。 */
export function toAgentAttachmentRef(a: AgentAttachment): AgentAttachmentRef {
  const mime = a.mime ?? "";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "document";
  return { kind, path: a.path, name: a.name, mime, size: a.size };
}

/**
 * 上传一组附件。FormData 可带多个 `file` 栏位；站内代理原样透传给网道，
 * 网道回 `{ attachments: [...] }`。走的不是 agentFetch —— 它会把 body 当 JSON
 * 再盖 Content-Type，multipart 必须保留 boundary。
 */
export async function uploadAgentAttachments(
  sessionId: string,
  files: File[],
  opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<AgentAttachment[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);

  // 不设 Content-Type：FormData 要由浏览器补 multipart boundary。
  const headers = authHeaders("尚未登录，无法上传附件。");

  // 缺陷 A（2026-10-04）：改用带进度的 XHR（xhrUploadForm）而非裸 fetch——
  // 大档上传期间给得出真实字节进度，且能经 signal 取消。错误语义与旧 fetch 版逐条对齐。
  let status: number;
  let text: string;
  try {
    ({ status, text } = await xhrUploadForm(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments`,
      form,
      { headers, onProgress: opts.onProgress, signal: opts.signal },
    ));
  } catch (err) {
    if (err instanceof UploadAbortedError) throw err;
    throw new AgentChatError("network_error", "网络连接失败，请检查网络后再试。");
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (status < 200 || status >= 300) throw new AgentChatError(mapHttpStatus(status), fallbackMessage(status), status);
    throw new AgentChatError("parse_error", "服务器回应格式错误。", status);
  }

  if (status < 200 || status >= 300) {
    throw new AgentChatError(mapErrorCode(data, status), extractMessage(data, status), status);
  }
  const arr = (data as { attachments?: unknown })?.attachments;
  if (!Array.isArray(arr)) {
    throw new AgentChatError("parse_error", "服务器未返回有效的附件清单。");
  }
  return arr as AgentAttachment[];
}

/** 回复一次花费确认。 */
export async function resolveAgentConfirm(sessionId: string, requestId: string, approved: boolean): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, approved }),
  });
}

/** 回复一次 opencode question。answers 是依题目顺序的选中标签。 */
export async function replyAgentQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/question`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, answers }),
  });
}

/** 删掉会话，释放上游资源。 */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/**
 * 拉一个会话的全量聊天历史（opencode 原始讯息 + 游标元数据）。
 *
 * 站内中继 GET /api/agent/sessions/[id] 转发网关 /agent/v1/sessions/:id/messages，
 * 契约：{ messages, event_counter, replay_first_id, fallback?:"replay_only" }。
 * 「回到历史会话」由这个端点重建 transcript，SSE 只接 event_counter 之后的增量，
 * 不再依赖 1000 帧 ring buffer 回放（长会话会被截断）。
 *
 * 错误沿 agentFetch 既有语义：404 → not_found、非 JSON → parse_error。
 * 这里只补契约级校验（messages 必为阵列、event_counter 必为有限非负数），
 * 校验失败丢 parse_error 让调用方走降级路径；逐 part 防呆归归一化层。
 */
export async function fetchAgentSessionMessages(sessionId: string): Promise<AgentSessionHistoryResponse> {
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.messages)) {
    throw new AgentChatError("parse_error", "服务器未返回有效的历史消息列表。");
  }
  const counter = d.event_counter;
  if (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0) {
    throw new AgentChatError("parse_error", "服务器未返回有效的事件游标。");
  }
  const replayFirst = d.replay_first_id;
  const fallback = d.fallback === "replay_only" ? ("replay_only" as const) : undefined;
  return {
    messages: d.messages as OpenCodeMessage[],
    event_counter: counter,
    replay_first_id: typeof replayFirst === "number" && Number.isFinite(replayFirst) ? replayFirst : null,
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * REQ-D2：回合中追加一条指引（steer）。
 *
 * 语义与 sendAgentMessage 刻意分开：不终止当前回合、不另起一条用户消息。
 * 回传的 status 是网关的诚实判定——
 *   "injected"：回合卡在 question 断点，这条已注入当前回合（applied_in_turn=true）
 *   "queued"：  当前回合跑着但没有可注入的断点 → 已排队，本回合结束后生效
 * 前端据此显示状态，绝不把 queued 当 injected 用。
 *
 * steer_id 由本端生成（乐观插入的条目要立刻有 id 可以挂状态帧；网关会回显同一个）。
 */
export type AgentSteerAck =
  | { status: "injected"; steer_id: string; injected_into?: string[] }
  | { status: "queued"; steer_id: string; position?: number; deduped?: boolean };

export interface AgentSteerOptions {
  /** 本端生成并上送；非法时网关自行铸号（回传值才是权威）。 */
  steerId?: string;
}

export async function steerAgentSession(
  sessionId: string,
  content: string,
  options?: AgentSteerOptions,
): Promise<AgentSteerAck> {
  const body: Record<string, unknown> = { content: content.trim() };
  if (options?.steerId) body.steer_id = options.steerId;
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const d = (data ?? {}) as Record<string, unknown>;
  const steerId = typeof d.steer_id === "string" ? d.steer_id : (options?.steerId ?? "");
  if (d.status === "injected") {
    const into = Array.isArray(d.injected_into)
      ? d.injected_into.filter((x): x is string => typeof x === "string")
      : undefined;
    return { status: "injected", steer_id: steerId, ...(into ? { injected_into: into } : {}) };
  }
  if (d.status === "queued") {
    const position = typeof d.position === "number" && Number.isFinite(d.position) ? d.position : undefined;
    return {
      status: "queued",
      steer_id: steerId,
      ...(typeof position === "number" ? { position } : {}),
      ...(d.deduped === true ? { deduped: true } : {}),
    };
  }
  // 认不得的回应＝契约破裂，照实抛错让调用方显示「未能提交」，不假装成功。
  throw new AgentChatError("parse_error", "服务器未返回有效的引导状态。");
}

/**
 * 强制中止当下这轮生成（系统层取消，不是发 prompt 软停）。
 * 网道转发到 opencode 的 /session/:id/abort，正在跑的 assistant turn 立刻终止。
 */
export async function abortAgentSession(sessionId: string): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
}

/** 查额度，回传已对齐 AgentQuotaState 形状的结果（reducer 的 applyQuotaSnapshot 直接吃）。 */
export async function fetchAgentQuota(): Promise<AgentQuotaState> {
  const data = await agentFetch("/api/agent/quota");
  const d = (data ?? {}) as AgentQuotaWire;
  return {
    balanceCoins:
      typeof d.balance_coins === "number" && Number.isFinite(d.balance_coins) ? (d.balance_coins as number) : null,
    currency: typeof d.currency === "string" ? (d.currency as string) : "coins",
    available: d.available === true,
    ...(typeof d.spendable === "boolean" ? { spendable: d.spendable as boolean } : {}),
    reason: typeof d.reason === "string" ? (d.reason as string) : undefined,
  };
}
