// Agent 附件展示的票据层：给转录里的附件卡铸「读取票」并拼出网关直连 URL。
//
// 链路：浏览器 → 站内代理（POST /api/agent/sessions/:id/uploads-ticket，带用户
// 身份头）→ 代理换成服务端 B 端 key 打网关 → { ticket, expires_in_ms }（TTL 1h）。
// 之后 <img> 直连网关公网 origin（GET /agent/v1/uploads/<session>/<filename>?t=<ticket>），
// 图片字节流不在 Vercel 上二次过境；坏票网关回 404，调用方降级成文档卡。
//
// 身份头与 agent-chat-client.ts 的 authHeaders 同一套（token + x-user-id 成对送，
// 上游校验「令牌持有者 = 头里声称的 id」）——那边的 helper 未导出，这边按同一
// 契约复刻，secret 只出现在请求头，绝不进 log / localStorage。

import { getStoredToken, getStoredUser } from "./new-api-client";
import { LOCAL_TEST_MODE } from "./local-test-mode";
import { AGENT_GATEWAY_DEFAULT_ORIGIN } from "./agent-gateway";
import type { AgentAttachmentRef } from "./agent-chat-types";

/** 网关原片直传的体积硬顶：超过网关回 413，前端在入队处就用同一个值预检。 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** 网关公网 origin：<img> 直连用（浏览器只发 GET 拿字节流，无 CORS 限制）。 */
export const AGENT_UPLOADS_ORIGIN = AGENT_GATEWAY_DEFAULT_ORIGIN;

export interface AgentUploadsTicket {
  ticket: string;
  /** 到期时刻（epoch ms）。网关 TTL 1h；响应没给 expires_in_ms 时按 1h 兜底。 */
  expiresAt: number;
}

/** 剩余寿命少于这个值就视为过期，提前重铸，别让 <img> 拿着将死的票撞 404。 */
const TICKET_SAFETY_MARGIN_MS = 60_000;

/** 票还在有效期内（含安全余量）时返回票值，否则 null。 */
export function freshTicketValue(t: AgentUploadsTicket | null, now: number = Date.now()): string | null {
  if (t === null) return null;
  return now < t.expiresAt - TICKET_SAFETY_MARGIN_MS ? t.ticket : null;
}

/**
 * 铸一张附件读取票。失败上抛，由调用方静默降级——附件卡退成文档式横条，
 * 绝不为一张票阻塞转录渲染，也绝不弹错。
 */
export async function mintUploadsTicket(sessionId: string): Promise<AgentUploadsTicket> {
  // LOCAL_TEST_MODE：與 agent-chat-client.ts 的 authHeaders 同款假頭——站內代理的
  // resolveAgentCaller 在該模式下直接換 B 端 key，不驗證這組頭。缺這支本地重放
  // （導演台白模上傳 → 鑄票 → 拼公網 URL）會在登入檢查處假性失敗。
  if (LOCAL_TEST_MODE) {
    return mintTicketRequest(sessionId, { Authorization: "Bearer local-test-token", "x-user-id": "0" });
  }
  const token = getStoredToken();
  const userId = getStoredUser()?.id;
  if (!token || !userId) {
    throw new Error("尚未登录，无法读取附件。");
  }
  return mintTicketRequest(sessionId, { Authorization: `Bearer ${token}`, "x-user-id": String(userId) });
}

async function mintTicketRequest(sessionId: string, headers: Record<string, string>): Promise<AgentUploadsTicket> {
  let res: Response;
  try {
    res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/uploads-ticket`, {
      method: "POST",
      headers,
    });
  } catch {
    throw new Error("网络连接失败，无法读取附件。");
  }

  if (!res.ok) {
    throw new Error("附件读取票获取失败。");
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("附件读取票响应格式错误。");
  }
  const record = (data ?? {}) as { ticket?: unknown; expires_in_ms?: unknown };
  if (typeof record.ticket !== "string" || record.ticket.length === 0) {
    throw new Error("附件读取票响应缺少 ticket。");
  }
  const ttl =
    typeof record.expires_in_ms === "number" && Number.isFinite(record.expires_in_ms) && record.expires_in_ms > 0
      ? record.expires_in_ms
      : 60 * 60 * 1000;
  return { ticket: record.ticket, expiresAt: Date.now() + ttl };
}

/**
 * 拼网关直连 URL。path 是 [附件] 区块的字面值（uploads/<session>/<filename>）；
 * path 意外缺会话段时用 sessionId 兜底补全。ticket 进 query（encodeURIComponent，
 * 票里可能带 URL 敏感字符）。
 */
export function buildAssetUrl(sessionId: string, path: string, ticket: string): string {
  let rel = path.replace(/^\/+/, "").replace(/^agent\/v1\//, "");
  if (!rel.startsWith("uploads/") && sessionId) {
    rel = `uploads/${sessionId}/${rel}`;
  }
  return `${AGENT_UPLOADS_ORIGIN}/agent/v1/${rel}?t=${encodeURIComponent(ticket)}`;
}

/**
 * 影片原片直传网关（绕开 Vercel 站内代理的单请求体 4.5MB 硬顶）。
 *
 * 链路：浏览器 → 网关公网 origin 的 POST /agent/v1/sessions/<id>/video-upload，
 * multipart 单栏位 `file`，票走 query（?t=，读票 = 写票同一张）。
 * 成功回 { ok:true, path, name, size, mime }，path 直接进 [附件] 区块，
 * 渲染端用 buildAssetUrl 拼读回 URL 播原片。
 *
 * 不設 Content-Type：FormData 要由浏览器补 multipart boundary（对齐 uploadAgentAttachments）。
 * 任何失败（无票 / 401 / 413 / 415 / 网络 / 响应不合契约）一律抛错带状态语义，
 * 由调用端决定降级（抽帧上传），这里不吞错也不静默。
 */
export async function uploadVideoDirect(sessionId: string, file: File): Promise<AgentAttachmentRef> {
  const { ticket } = await mintUploadsTicket(sessionId);

  const form = new FormData();
  form.append("file", file);

  let res: Response;
  try {
    res = await fetch(
      `${AGENT_UPLOADS_ORIGIN}/agent/v1/sessions/${encodeURIComponent(sessionId)}/video-upload?t=${encodeURIComponent(ticket)}`,
      { method: "POST", body: form },
    );
  } catch {
    throw new Error("视频直传网络连接失败。");
  }

  if (!res.ok) {
    if (res.status === 413) throw new Error("视频超过 100 MB 上限。");
    if (res.status === 415) throw new Error("网关不接受该视频格式。");
    if (res.status === 401) throw new Error("上传票失效，无法直传视频。");
    throw new Error(`视频直传失败（HTTP ${res.status}）。`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("视频直传响应格式错误。");
  }
  const record = (data ?? {}) as { ok?: unknown; path?: unknown; name?: unknown; size?: unknown; mime?: unknown };
  if (record.ok !== true || typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("视频直传响应缺少 path。");
  }
  return {
    kind: "video",
    path: record.path,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : file.name,
    mime: typeof record.mime === "string" && record.mime.length > 0 ? record.mime : "video/mp4",
    size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : file.size,
  };
}
