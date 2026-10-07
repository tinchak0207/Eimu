import { tool } from "@opencode-ai/plugin/tool";
import { readFile } from "node:fs/promises";
import { ok, fail } from "../lib/client";
import { LOCAL_PATH_HINT, explainMissingPath } from "../lib/agent-paths";
import { checkAgentPath } from "../lib/sandbox";

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";
const MAX_BYTES = 200 * 1024 * 1024;

export default tool({
  description:
    "把视频、音频、图片或完整交付文档入库平台存储（免费），返回用户可下载的公网 URL。文档支持 .md/.txt/.json/.csv/.pdf：先把完整最新版写入 workspace 文件，再用 path 上传；禁止用本地路径、file:// 或摘要冒充下载交付。两种来源二选一：(1) path——workspace 内本地文件的绝对路径（沙箱私有 /tmp 工具端看不到）；(2) url——外部视频/音频/图片 URL（服务端下载，上限200MB）。媒体可将返回 URL 注入工作流节点，文档直接用 Markdown 下载链接交付用户。",
  args: {
    path: tool.schema.string().optional().describe(`本地媒体或完整交付文档的绝对路径；文档支持 .md/.txt/.json/.csv/.pdf，上限200MB。与 url 二选一，给了 path 就优先用 path。${LOCAL_PATH_HINT}`),
    url: tool.schema.string().optional().describe("外部影片/音频 URL（video/* 或 audio/*，上限 200MB，服务端下载 120s 超时）。与 path 二选一。"),
  },
  async execute({ path: localPath, url }, context) {
    if (!localPath && !url) {
      return fail("bad_request", "需要提供 path（本地成片绝对路径）或 url（外部媒体 URL）其中之一。");
    }
    let payload: Record<string, string>;
    if (localPath) {
      const access = checkAgentPath(localPath, context.sessionID);
      if (!access.ok) return fail("path_denied", `文件路径不允许上传：${access.reason}`);
      // 2026-10-02 更正：本工具跑在 opencode-server 服务内（PrivateTmp），**看不到** agent 沙箱私有的
      // /tmp（那是 <workspace>/.run/<slug>/tmp 被 bind 进沙箱的）；三方 /tmp 互不可见。跨边界交接一律
      // 用 workspace 内同绝对路径（见 lib/agent-paths.ts）。读成 base64 交给网关，网关不碰 agent FS。
      let buf: Buffer;
      try {
        buf = await readFile(localPath);
      } catch (e) {
        const hint = explainMissingPath(localPath);
        return fail("not_found", `本地文件不存在或不可读：${localPath}（${(e as Error).message}）${hint ?? ""}`);
      }
      if (buf.byteLength === 0) return fail("bad_request", "本地文件为空。");
      if (buf.byteLength > MAX_BYTES) return fail("too_large", `本地文件 ${buf.byteLength} 字节，超过 200MB 上限。`);
      const filename = localPath.split("/").pop() || "media.mp4";
      payload = { path_b64: buf.toString("base64"), filename };
    } else {
      payload = { url: (url as string).trim() };
    }
    const res = await fetch(`${GATEWAY}/internal/media/upload?session_id=${context.sessionID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      const err = data?.error ?? {};
      const hint =
        typeof err === "string" && err
          ? err
          : typeof err.message === "string" && err.message
            ? err.message
            : `upload failed (HTTP ${res.status})`;
      const code = typeof err.code === "string" && err.code ? err.code : "upload_failed";
      return fail(code, hint);
    }
    return ok({
      url: data.url,
      bytes: data.bytes,
      content_type: data.content_type,
      sha256: data.sha256,
      note: "完整文件已入库平台存储（免费）。文档用 Markdown 下载链接交付此 URL；媒体可注入工作流节点。",
    });
  },
});
