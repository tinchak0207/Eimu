import { tool } from "@opencode-ai/plugin/tool";
import { readFile } from "node:fs/promises";
import { ok, fail } from "../lib/client";
import { LOCAL_PATH_HINT, explainMissingPath } from "../lib/agent-paths";

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";
const MAX_BYTES = 200 * 1024 * 1024;

export default tool({
  description:
    "把影片/音频入库平台存储（免费），返回平台公网 URL（https://store.eimu.dev/image-data/files/uploads/...）。两种来源二选一：(1) path——你 ffmpeg 剪/合成出来的本地成片绝对路径（**限 workspace 内**；沙箱私有 /tmp 工具端看不到，传了必失败。工具会读成字节上传，免起 HTTP server、免 file:// 500）；(2) url——外部影片/音频 URL（服务端下载，外部 URL 常被 Cloudflare 403 挡，一律先入库再注入）。拿到平台 URL 后用 workflow_add_node（metadata.content）或 workflow_update_node（patch.content）注入节点，或直接交付此公网 URL 给用户出卡。",
  args: {
    path: tool.schema.string().optional().describe(`本地影片/音频文件的绝对路径（如 <workspace>/out/final.mp4），上限 200MB，仅接受视频/音频扩展名。与 url 二选一，给了 path 就优先用 path。${LOCAL_PATH_HINT}`),
    url: tool.schema.string().optional().describe("外部影片/音频 URL（video/* 或 audio/*，上限 200MB，服务端下载 120s 超时）。与 path 二选一。"),
  },
  async execute({ path: localPath, url }, context) {
    if (!localPath && !url) {
      return fail("bad_request", "需要提供 path（本地成片绝对路径）或 url（外部媒体 URL）其中之一。");
    }
    let payload: Record<string, string>;
    if (localPath) {
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
      note: "已入库平台存储（免费）。用 workflow_add_node（metadata.content）或 workflow_update_node（patch.content）把此 URL 注入节点，或直接交付此公网 URL 给用户。",
    });
  },
});
