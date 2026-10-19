import { tool } from "@opencode-ai/plugin/tool";
import { readFile } from "node:fs/promises";
import { ok, fail } from "../lib/client";
import { LOCAL_PATH_HINT, explainMissingPath } from "../lib/agent-paths";

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";
const MAX_BYTES = 20 * 1024 * 1024;
const DOC_EXTS = new Set([".md", ".txt", ".json", ".csv", ".pdf"]);

export default tool({
  description:
    "把工作区文稿（研究笔记／剧本／分镜／蓝图等 md·txt·json·csv·pdf）入库平台存储（免费），返回平台公网 URL（https://store.eimu.dev/image-data/files/uploads/...）。用户网页点得开；禁止把裸 VPS workspace 路径说成「可随时查看」。path＝workspace 内绝对路径（与 video_upload 同通道／同契约，只是接受文稿扩展名）。拿到 URL 后用 markdown 链接交付（链接文字用人话标题，如 [护肤短片剧本](url)）；画布已打开时可另用 workflow_add_node type=text 把全文放进 text 节点。",
  args: {
    path: tool.schema
      .string()
      .describe(`本地文稿绝对路径（如 <workspace>/护肤短片剧本.md），上限 20MB，仅接受 md/txt/json/csv/pdf。${LOCAL_PATH_HINT}`),
    title: tool.schema
      .string()
      .optional()
      .describe("给人看的标题（可选；回执原样带回，方便你写 markdown 链接文字）"),
  },
  async execute({ path: localPath, title }, context) {
    if (!localPath || !String(localPath).trim()) {
      return fail("bad_request", "需要提供 path（工作区内文稿绝对路径）。");
    }
    const trimmed = String(localPath).trim();
    const lower = trimmed.toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot) : "";
    if (!DOC_EXTS.has(ext)) {
      return fail("bad_request", `不支持的扩展名 "${ext || "(无)"}"（仅 md/txt/json/csv/pdf）。影片/音频请用 video_upload，图片请用 image_upload。`);
    }
    let buf: Buffer;
    try {
      buf = await readFile(trimmed);
    } catch (e) {
      const hint = explainMissingPath(trimmed);
      return fail("not_found", `本地文件不存在或不可读：${trimmed}（${(e as Error).message}）${hint ?? ""}`);
    }
    if (buf.byteLength === 0) return fail("bad_request", "本地文件为空。");
    if (buf.byteLength > MAX_BYTES) {
      return fail("too_large", `本地文件 ${buf.byteLength} 字节，超过 20MB 上限。`);
    }
    const filename = trimmed.split("/").pop() || `document${ext}`;
    const res = await fetch(`${GATEWAY}/internal/media/upload?session_id=${context.sessionID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path_b64: buf.toString("base64"), filename }),
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
    const linkTitle =
      typeof title === "string" && title.trim()
        ? title.trim()
        : filename.replace(/\.[^.]+$/, "") || "文档";
    return ok({
      url: data.url,
      bytes: data.bytes,
      content_type: data.content_type,
      title: linkTitle,
      markdown_link: `[${linkTitle}](${data.url})`,
      note: "已入库平台存储（免费）。请把 markdown_link 写进交付文（用户可点开）；禁止再报 /opt/eimu-harness/workspace 裸路径或声称「工作区可随时查看」。画布已开时可另加 text 节点承接全文。",
    });
  },
});
