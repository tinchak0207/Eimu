import { tool } from "@opencode-ai/plugin/tool"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const WORKSPACE = process.env.HARNESS_WORKSPACE || "/opt/agent-harness/workspace"

/**
 * 只有真实本地文件才能进 artifact 版本库（publish 需要 path）。
 * HTTP(S)/artifact 等带 scheme 的 URI 没有本地字节，跳过落库；
 * file:// 与绝对/相对路径照常尝试（相对路径按 HARNESS_WORKSPACE 解析）。
 * 网关失败不得阻断登记（登记是本工具的主职责），只记录在返回值与日志。
 */
function localFileFromUri(uri: string): string | null {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri)
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return null
  return path.isAbsolute(uri) ? uri : path.resolve(WORKSPACE, uri)
}

async function publishRegistered(
  sessionId: string,
  name: string,
  uri: string,
  metadata: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const localPath = localFileFromUri(uri)
  if (!localPath) return { ok: false, skipped: true, reason: "non_local_uri" }
  try {
    const contentType = typeof metadata?.content_type === "string" ? metadata.content_type : undefined
    const resp = await fetch(`${GATEWAY}/internal/artifact/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        name,
        path: localPath,
        content_type: contentType,
        producer: "artifact_register",
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || !data?.ok) {
      console.warn(
        `[artifact_register] gateway publish failed: status=${resp.status} code=${data?.code ?? ""} error=${data?.error ?? ""}`,
      )
      return { ok: false, http_status: resp.status, code: data?.code, error: data?.error }
    }
    return { ok: true, slug: data.slug, version: data.version, changed: data.changed }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn(`[artifact_register] gateway publish unreachable: ${error}`)
    return { ok: false, error }
  }
}

const EXAMPLE_ARGS = {
  action: "register",
  name: "scene_01_master_keyframe",
  type: "image",
  uri: "https://store.tinchak0207.xyz/artifacts/scene_01_keyframe.png",
  metadata: {
    resolution: "1280x720",
    seed: 4294967295,
    prompt: "A neon-lit cyberpunk city alley with reflective puddles",
    cost_coins: 1,
  },
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "把具型产物注册进主子代理共享的产物表。",
    "何时用：子代理产出图片、视频、音频、文档，需要让主代理按结构化方式读取时；已有版本化交付物用 artifact_publish。",
    "何时不用：只传一条 URL 不必注册；需要 sha256/版本/真实链接证明时用 artifact_publish。",
    "关键约束：action=register 必填 name/type/uri；list 可按 type 过滤；get 按 artifact_id 或 name；注册只写元数据，不产生版本。",
    "失败处置：missing_required_args 补齐 name/type/uri；artifact_failed 按 gateway 文本修正；network_error 稍后重试。",
    "互指：artifact_publish 才产生版本与 sha256；artifact_get/artifact_verify 用于版本化交付物。",
    "示例：artifact_register({action:register, name:scene_01_keyframe, type:image, uri:https://example.com/scene_01.png})",
  ].join("\n"),
  args: {
    action: tool.schema
      .enum(["register", "list", "get"])
      .optional()
      .describe("操作动作：register（注册）、list（列出所有产物）、get（获取产物）"),
    name: tool.schema
      .string()
      .optional()
      .describe("产物唯一名称或描述标识（register 必填，如「scene_01_keyframe」「bgm_track_mix」）"),
    type: tool.schema
      .enum(["image", "video", "audio", "document", "code", "data", "model"])
      .optional()
      .describe("产物类型（register 必填）：image/video/audio/document/code/data/model"),
    uri: tool.schema
      .string()
      .optional()
      .describe("产物可访问 URI（register 必填：可为完整 HTTP 链接或相对文件系统路径）"),
    metadata: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe("产物结构化元数据（可选：如分辨率、码率、时长、提示词、生成消耗等）"),
    artifact_id: tool.schema
      .string()
      .optional()
      .describe("产物 ID（action=\"get\" 时可选）"),
  },
  async execute(args, context) {
    const action = args.action || "list"
    const name = typeof args.name === "string" ? args.name.trim() : ""
    const type = typeof args.type === "string" ? args.type.trim() : ""
    const uri = typeof args.uri === "string" ? args.uri.trim() : ""

    if (action === "register" && (!name || !type || !uri)) {
      const missing = [!name ? "name" : "", !type ? "type" : "", !uri ? "uri" : ""].filter(Boolean)
      return fail(
        "missing_required_args",
        `artifact_register action="register" 缺少必填字段：${missing.join("、")}。示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          action,
          name: name || undefined,
          type: type || undefined,
          uri: uri || undefined,
          metadata: args.metadata,
          artifact_id: args.artifact_id,
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "artifact_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      // 登记后尝试落库到 artifact 版本库（P1-3/网关接线）。失败只记录，不阻断登记。
      const gatewayPublish =
        action === "register"
          ? await publishRegistered(context.sessionID, name, uri, args.metadata as Record<string, unknown> | undefined)
          : undefined
      return ok({
        title: `具型产物操作成功（${action}）`,
        ...data,
        ...(gatewayPublish ? { gateway_publish: gatewayPublish } : {}),
      })
    } catch (e) {
      return fail("network_error", `产物注册通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
