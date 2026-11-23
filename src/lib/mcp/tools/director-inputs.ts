// eimu_direct 的文档／图片输入（造世界计划第一批）。
//
// 为什么走附件而不是塞进 prompt：消息上限 8000 字，设计案动辄几万字；附件落在会话目录，
// 智能体用读文件工具通读，和网页对话框拖文件进来是同一条路（[ATTACHMENTS_BLOCK] 惯例，
// 见 src/components/agent-chat/AgentComposer.attachments.ts）。
// 图片由服务端经 SSRF 守卫抓取后上传，智能体拿到的是本地文件，能真看图，不是只看见一串 URL。

import { machineError, type McpToolCallResult } from "../protocol";
import { ImageTooLargeError, SsrfBlockedError, isForbiddenHost, safeFetchPublicImage } from "@/lib/ssrf-guard";
import { agentSessionPath } from "./agent";
import type { McpToolContext } from "./types";
import { isPlainObject } from "./validation";

export const DIRECTOR_MAX_DOCUMENTS = 8;
export const DIRECTOR_MAX_IMAGES = 8;
/** 站内 B 端代理单次上传上限 4MiB（含 multipart 头）；留 64KiB 余量。 */
export const DIRECTOR_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

const DOCUMENT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  yaml: "application/yaml",
  yml: "application/yaml",
};

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export interface DirectorDocumentInput {
  name: string;
  content: string;
  mime: string;
}

export interface DirectorAttachmentRef {
  /** 调用方给的文件名（中文原样保留，供导演辨认）。 */
  name: string;
  /** 网关落盘名；网关只留 ASCII，中文名会塌成 `_.md`，与 name 不同时才带。 */
  stored_name?: string;
  path: string;
  size: number | null;
  mime: string;
  source: "document" | "image";
  /** 图片的原始 URL（文档没有）。 */
  url?: string;
}

export interface DirectorInputWarning {
  url: string;
  reason: string;
}

function invalid(message: string): { ok: false; error: McpToolCallResult } {
  return {
    ok: false,
    error: machineError({ code: "invalid_params", message, retryable: false, next_action: "fix_params" }),
  };
}

/** 文件名只留字母数字与 ._-（含中文），去掉前导点，限长；副档名不在白名单就补 .md。 */
function safeDocumentName(raw: string, index: number): { name: string; mime: string } {
  const cleaned = raw
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 80);
  const base = cleaned || `document-${index + 1}`;
  const ext = base.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (ext && DOCUMENT_MIME[ext]) return { name: base, mime: DOCUMENT_MIME[ext] };
  return { name: `${base}.md`, mime: DOCUMENT_MIME.md };
}

export function readDirectorDocuments(
  raw: unknown,
): { ok: true; documents: DirectorDocumentInput[] } | { ok: false; error: McpToolCallResult } {
  if (raw === undefined || raw === null) return { ok: true, documents: [] };
  if (!Array.isArray(raw)) return invalid("documents 必须是数组：[{ name, content }]。");
  if (raw.length > DIRECTOR_MAX_DOCUMENTS) return invalid(`documents 最多 ${DIRECTOR_MAX_DOCUMENTS} 份。`);
  const documents: DirectorDocumentInput[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) return invalid(`documents[${index}] 必须是 { name, content } 对象。`);
    const content = typeof item.content === "string" ? item.content : "";
    if (content.trim() === "") return invalid(`documents[${index}].content 为空。`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > DIRECTOR_ATTACHMENT_MAX_BYTES) {
      return invalid(
        `documents[${index}] 有 ${bytes} 字节，超过单份上限 ${DIRECTOR_ATTACHMENT_MAX_BYTES}；请按章节拆成多份。`,
      );
    }
    let { name, mime } = safeDocumentName(typeof item.name === "string" ? item.name : "", index);
    // 同名会被网关改名落盘；这里先去重，回执里的名字和调用方给的一一对得上。
    if (seen.has(name)) name = name.replace(/(\.[a-z0-9]+)$/i, `-${index + 1}$1`);
    seen.add(name);
    documents.push({ name, content, mime });
  }
  return { ok: true, documents };
}

export function readDirectorImageUrls(
  raw: unknown,
): { ok: true; urls: string[] } | { ok: false; error: McpToolCallResult } {
  if (raw === undefined || raw === null) return { ok: true, urls: [] };
  if (!Array.isArray(raw)) return invalid("image_urls 必须是字符串数组。");
  if (raw.length > DIRECTOR_MAX_IMAGES) return invalid(`image_urls 最多 ${DIRECTOR_MAX_IMAGES} 张。`);
  const urls: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string" || item.trim() === "") return invalid(`image_urls[${index}] 不是有效字符串。`);
    let parsed: URL;
    try {
      parsed = new URL(item.trim());
    } catch {
      return invalid(`image_urls[${index}] 不是合法网址。`);
    }
    if (parsed.protocol !== "https:" || isForbiddenHost(parsed.hostname)) {
      return invalid(`image_urls[${index}] 只收 https 公网图片地址。`);
    }
    // 带账号密码的地址会把凭证带进提示词与回执；非 443 端口抓取守卫也不放行，提前说清楚。
    if (parsed.username || parsed.password) return invalid(`image_urls[${index}] 不能带账号密码。`);
    if (parsed.port && parsed.port !== "443") return invalid(`image_urls[${index}] 只支持默认 443 端口。`);
    if (!urls.includes(parsed.toString())) urls.push(parsed.toString());
  }
  return { ok: true, urls };
}

function imageFileName(url: string, mime: string, index: number): string {
  const ext = IMAGE_EXT_BY_MIME[mime] ?? "png";
  let last = "";
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    last = "";
  }
  const stem = last
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${stem || `reference-${index + 1}`}.${ext}`;
}

async function fetchImageFile(
  url: string,
  index: number,
): Promise<{ ok: true; file: File } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await safeFetchPublicImage(url, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      maxBytes: DIRECTOR_ATTACHMENT_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) return { ok: false, reason: "不是 https 公网地址" };
    if (error instanceof ImageTooLargeError) return { ok: false, reason: "图片超过 4MB" };
    return { ok: false, reason: "抓取失败或超时" };
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || !contentType.startsWith("image/")) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: response.ok ? `不是图片（${contentType || "无类型"}）` : `上游 HTTP ${response.status}` };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    return { ok: false, reason: error instanceof ImageTooLargeError ? "图片超过 4MB" : "读取图片失败" };
  }
  return { ok: true, file: new File([bytes], imageFileName(url, contentType, index), { type: contentType }) };
}

/** 一次传一件（B 端代理按整个请求体限 4MiB）。网关回 `{ attachments: [{ name, path, size, mime }] }`。 */
async function uploadOne(
  sessionId: string,
  file: File,
  ctx: McpToolContext,
): Promise<{ ok: true; path: string; name: string; size: number | null; mime: string } | { ok: false; status: number; text: string }> {
  const form = new FormData();
  form.append("file", file);
  const response = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(sessionId, "/attachments"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "eimu_direct_attachment",
    form,
  });
  if (response.status < 200 || response.status >= 300) return { ok: false, status: response.status, text: response.text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { ok: false, status: 502, text: "附件回执不是 JSON" };
  }
  const first = isPlainObject(parsed) && Array.isArray(parsed.attachments) ? parsed.attachments[0] : null;
  if (!isPlainObject(first) || typeof first.path !== "string" || first.path === "") {
    return { ok: false, status: 502, text: "附件回执缺 path" };
  }
  return {
    ok: true,
    path: first.path,
    name: typeof first.name === "string" ? first.name : file.name,
    size: typeof first.size === "number" ? first.size : file.size,
    mime: typeof first.mime === "string" && first.mime ? first.mime : file.type || "application/octet-stream",
  };
}

/**
 * 文档必须全部上传成功，否则不发消息（设计案缺一份就开工＝静默降级）；
 * 图片抓不到或传不上只记 warning，并把原 URL 退回参考行，智能体照样看得到地址。
 */
export async function uploadDirectorInputs(
  sessionId: string,
  documents: DirectorDocumentInput[],
  imageUrls: string[],
  ctx: McpToolContext,
): Promise<
  | { ok: true; attachments: DirectorAttachmentRef[]; warnings: DirectorInputWarning[]; fallbackImageUrls: string[] }
  | { ok: false; error: McpToolCallResult }
> {
  const attachments: DirectorAttachmentRef[] = [];
  for (const doc of documents) {
    const sent = await uploadOne(sessionId, new File([doc.content], doc.name, { type: doc.mime }), ctx);
    if (!sent.ok) {
      return {
        ok: false,
        error: machineError({
          code: "attachment_upload_failed",
          message: `文档「${doc.name}」上传失败（HTTP ${sent.status}）；本次没有把任务发给导演，未扣费。会话已建，可带同一 session_id 重试。`,
          retryable: true,
          next_action: "retry_eimu_direct_with_session_id",
          job_id: sessionId,
          session_id: sessionId,
          do_not_resubmit: false,
        }),
      };
    }
    attachments.push({
      name: doc.name,
      ...(sent.name !== doc.name ? { stored_name: sent.name } : {}),
      path: sent.path,
      size: sent.size,
      mime: sent.mime,
      source: "document",
    });
  }

  const warnings: DirectorInputWarning[] = [];
  const fallbackImageUrls: string[] = [];
  for (const [index, url] of imageUrls.entries()) {
    const fetched = await fetchImageFile(url, index);
    if (!fetched.ok) {
      warnings.push({ url, reason: fetched.reason });
      fallbackImageUrls.push(url);
      continue;
    }
    const sent = await uploadOne(sessionId, fetched.file, ctx);
    if (!sent.ok) {
      warnings.push({ url, reason: `上传失败（HTTP ${sent.status}）` });
      fallbackImageUrls.push(url);
      continue;
    }
    attachments.push({ name: sent.name, path: sent.path, size: sent.size, mime: sent.mime, source: "image", url });
  }
  return { ok: true, attachments, warnings, fallbackImageUrls };
}

/** 消息里的说明行＋[ATTACHMENTS_BLOCK]（格式与网页对话框 buildAttachmentBlock 一致）。 */
export function directorAttachmentText(attachments: DirectorAttachmentRef[]): string {
  if (attachments.length === 0) return "";
  const docs = attachments.filter((a) => a.source === "document");
  const images = attachments.filter((a) => a.source === "image");
  const notes = [
    docs.length > 0
      ? `设计文档 ${docs.length} 份（完整原文在附件里，动手前先通读；它是本项目的只读真源）：${docs.map((d) => `「${d.name}」→ ${d.path}`).join("、")}`
      : "",
    images.length > 0 ? `参考图 ${images.length} 张（已作为附件上传，请直接看图）：${images.map((i) => i.name).join("、")}` : "",
  ].filter(Boolean);
  const lines = attachments
    .map((a, i) => `${i + 1}. ${a.path} | ${a.mime} | ${a.size ?? "?"}`)
    .join("\n");
  return `\n\n${notes.join("\n")}\n[ATTACHMENTS_BLOCK]\n[附件]\n${lines}\n[/ATTACHMENTS_BLOCK]`;
}
