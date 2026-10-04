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
 * 影片原片直傳網關（繞開 Vercel 站內代理的單請求體 4.5MB 硬頂）。
 *
 * 鏈路：瀏覽器 → 網關公網 origin 的 POST /agent/v1/sessions/<id>/video-upload，
 * multipart 單欄位 `file`，票走 query（?t=，讀票 = 寫票同一張）。
 * 成功回 { ok:true, path, name, size, mime }，path 直接進 [附件] 區塊，
 * 渲染端用 buildAssetUrl 拼讀回 URL 播原片。
 *
 * 不設 Content-Type：FormData 要由瀏覽器補 multipart boundary（對齊 uploadAgentAttachments）。
 * 任何失敗（無票 / 401 / 413 / 415 / 網路 / 回應不合契約）一律拋錯帶狀態語義，
 * 由呼叫端決定降級（抽幀上傳），這裡不吞錯也不靜默。
 */
interface GatewayDirectUploadSpec {
  /** 前端 ref 的 kind（音頻無獨立 kind，沿用 document，見 toAgentAttachmentRef 同款映射）。 */
  kind: AgentAttachmentRef["kind"];
  /** 回應未帶 mime 時的型別兜底。 */
  defaultMime: string;
  /** 人話錯誤文案的主語（「视频」/「音频」）。 */
  noun: string;
}

/**
 * 上傳進度／取消的共用選項（缺陷 A 修復，2026-10-04）。
 *
 * 底層 fetch 有兩個硬傷：① 拿不到上行進度（4.4MB 音頻 47–50s 期間 UI 全黑，
 * 使用者以為當掉）；② 沒有取消手段（載錯大檔只能等或重新整理）。改用
 * XMLHttpRequest —— `upload.onprogress` 是**真實位元組計數**（非假動畫），
 * `abort()` 是真取消。signal 供呼叫端（chip 的取消鈕／移除鈕）中斷在途請求。
 */
export interface UploadProgressOptions {
  /** 上行真實進度：loaded/total 皆為位元組；total=0 時不呼叫（無法誠實報百分比）。 */
  onProgress?: (loaded: number, total: number) => void;
  /** 取消信號：abort 時 XHR.abort() → reject(UploadAbortedError)。 */
  signal?: AbortSignal;
}

/** 使用者主動取消上傳（區別於網路失敗）：呼叫端據此落「已取消」而非「失敗」語義。 */
export class UploadAbortedError extends Error {
  constructor() {
    super("已取消上传。");
    this.name = "UploadAbortedError";
  }
}

/**
 * 用 XMLHttpRequest 送出 multipart，回 { status, text }；**不因 HTTP 狀態 reject**
 * （狀態交由呼叫端判讀，與 fetch 語義一致）。僅網路錯誤／取消 reject。
 * 這是全站唯一一支帶進度的上傳器：原片直傳與站內代理上傳都復用它，不另造第二套。
 */
export function xhrUploadForm(
  url: string,
  form: FormData,
  opts: { headers?: Record<string, string> } & UploadProgressOptions = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      xhr.abort();
      reject(new UploadAbortedError());
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new UploadAbortedError());
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
    xhr.open("POST", url);
    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) xhr.setRequestHeader(key, value);
    }
    if (opts.onProgress && xhr.upload) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable && event.total > 0) opts.onProgress?.(event.loaded, event.total);
      };
    }
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status: xhr.status, text: xhr.responseText ?? "" });
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("network_error"));
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new UploadAbortedError());
    };
    xhr.send(form);
  });
}

async function uploadMediaDirect(
  sessionId: string,
  file: File,
  spec: GatewayDirectUploadSpec,
  opts: UploadProgressOptions = {},
): Promise<AgentAttachmentRef> {
  const { ticket } = await mintUploadsTicket(sessionId);

  const form = new FormData();
  form.append("file", file);

  let status: number;
  let text: string;
  try {
    ({ status, text } = await xhrUploadForm(
      `${AGENT_UPLOADS_ORIGIN}/agent/v1/sessions/${encodeURIComponent(sessionId)}/video-upload?t=${encodeURIComponent(ticket)}`,
      form,
      opts,
    ));
  } catch (err) {
    if (err instanceof UploadAbortedError) throw err;
    throw new Error(`${spec.noun}直传网络连接失败。`);
  }

  if (status < 200 || status >= 300) {
    if (status === 413) throw new Error(`${spec.noun}超过 100 MB 上限。`);
    if (status === 415) throw new Error(`网关不接受该${spec.noun}格式。`);
    if (status === 401) throw new Error(`上传票失效，无法直传${spec.noun}。`);
    throw new Error(`${spec.noun}直传失败（HTTP ${status}）。`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${spec.noun}直传响应格式错误。`);
  }
  const record = (data ?? {}) as { ok?: unknown; path?: unknown; name?: unknown; size?: unknown; mime?: unknown };
  if (record.ok !== true || typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${spec.noun}直传响应缺少 path。`);
  }
  return {
    kind: spec.kind,
    path: record.path,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : file.name,
    mime: typeof record.mime === "string" && record.mime.length > 0 ? record.mime : spec.defaultMime,
    size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : file.size,
  };
}

/** 影片原片直傳（大檔，走網關票券路由；見上方 uploadMediaDirect）。 */
export function uploadVideoDirect(
  sessionId: string,
  file: File,
  opts: UploadProgressOptions = {},
): Promise<AgentAttachmentRef> {
  return uploadMediaDirect(sessionId, file, { kind: "video", defaultMime: "video/mp4", noun: "视频" }, opts);
}

/**
 * 音頻原片直傳（真歌等本地參考素材）：與影片**同一條**網關票券大檔路徑，非另造
 * 第二套——差別只在 kind（audio/* 依 toAgentAttachmentRef 同款落 "document"）。
 * 繞開 Vercel 4.5MB 體上限，上限同網關 100MB。
 */
export function uploadAudioDirect(
  sessionId: string,
  file: File,
  opts: UploadProgressOptions = {},
): Promise<AgentAttachmentRef> {
  return uploadMediaDirect(sessionId, file, { kind: "document", defaultMime: "audio/mpeg", noun: "音频" }, opts);
}
