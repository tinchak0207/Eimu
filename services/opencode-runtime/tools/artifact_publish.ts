import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "发布版本化交付物（Artifact）：读本地文件、算 sha256/bytes、写版本。",
    "何时用：有真实成品文件要交付、需要可访问链接与版本时；只是登记具型产物用 artifact_register。",
    "何时不用：文件还没生成、或只是中间草稿时不要发布。",
    "关键约束：交付文件上限200MiB、常规文件（拒绝symlink/hardlink）；sha256不变不升版；expected_version做乐观并发。能解析账号所属会话时自动保存私有不可变副本并返回鉴权下载URL，外部客户端需用自己的Eimu API key放Authorization头下载，不在URL带密钥。解析不到归属且无url时只登记本地版本，deliverable=false。",
    "失败处置：version_conflict 先 artifact_get 读最新版本再发布；artifact_publish_failed 按 gateway 文本修正；network_error 稍后重试。",
    "互指：复核元数据用 artifact_get，真实探测用 artifact_verify；artifact_register 只登记不产生版本。",
    "示例：artifact_publish({name:film_final_cut, path:/opt/agent-harness/workspace/out/final.mp4})",
  ].join("\n"),
  args: {
    name: tool.schema.string().describe("artifact 名称（同会话内唯一，如 film_final_cut）"),
    path: tool.schema.string().describe("本地文件路径（必须是常规文件，≤200MiB）"),
    content_type: tool.schema.string().optional().describe("MIME 类型；省略时按扩展名推断"),
    url: tool.schema.string().optional().describe("已有交付URL；省略时自动保存私有快照并生成账号鉴权下载URL"),
    expected_version: tool.schema
      .number()
      .optional()
      .describe("期望的当前版本；0 表示预期尚未发布。与 live 版本不符时整笔拒绝并回 live_version"),
  },
  async execute(args, context) {
    try {
      const resp = await fetch(`${GATEWAY}/internal/artifact/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.HARNESS_INTERNAL_TOKEN ? { "X-Internal-Token": process.env.HARNESS_INTERNAL_TOKEN } : {}),
        },
        body: JSON.stringify({
          session_id: context.sessionID,
          name: args.name,
          path: args.path,
          content_type: args.content_type,
          url: args.url,
          expected_version: args.expected_version,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.status === 409) {
        return fail(
          "version_conflict",
          `版本冲突：live version=${data?.live_version ?? "unknown"}；本次未写入，请先 artifact_get 读取最新版本再发布`,
          {
            title: "版本冲突",
            live_version: data?.live_version,
            live: data?.live,
          },
        )
      }
      if (!resp.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "artifact_publish_failed",
          data?.error || `HTTP ${resp.status}`,
          { title: "发布失败", http_status: resp.status },
        )
      }
      const deliverable = Boolean(data.url)
      return ok({
        title: deliverable
          ? `已发布 ${data.slug} v${data.version}`
          : `已登记本地版本（无公网 URL，不可当交付）`,
        deliverable,
        download_auth: data.url?.includes("/api/agent/biz/sessions/") ? "Authorization: Bearer <your Eimu API key>" : undefined,
        artifact_id: data.artifact_id,
        slug: data.slug,
        version: data.version,
        url: data.url,
        sha256: data.sha256,
        bytes: data.bytes,
        content_type: data.content_type,
        readBack: data.readBack,
        changed: data.changed,
      })
    } catch (e) {
      return fail("network_error", `artifact 发布通信失败：${e instanceof Error ? e.message : String(e)}`, {
        title: "发布失败",
      })
    }
  },
})
