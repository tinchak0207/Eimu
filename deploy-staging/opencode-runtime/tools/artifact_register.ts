import { tool } from "@opencode-ai/plugin/tool"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const WORKSPACE = process.env.HARNESS_WORKSPACE || "/opt/agent-harness/workspace"

/**
 * P3：register 只登记元数据，**不**隐式 publish/升版（旧实现在无 expected_version 时
 * 会静默升版，把已验证的 live 版本冲成未验证）。HTTP(S) 与本地路径都登记：URL 行的
 * sha256 留空，由 artifact_verify 探测后回填。
 */
type UriTarget = { url?: string; localPath?: string; error?: string }

function targetFromUri(uri: string): UriTarget {
  if (uri.startsWith("file://")) {
    try {
      return { localPath: fileURLToPath(uri) }
    } catch {
      return { error: "invalid_file_uri" }
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase()
  if (scheme) {
    // P2-13：只接受 http/https（javascript:/data: 等一律拒绝）。
    if (scheme === "http" || scheme === "https") return { url: uri }
    return { error: "unsupported_url_scheme" }
  }
  return { localPath: path.isAbsolute(uri) ? uri : path.resolve(WORKSPACE, uri) }
}

function internalHeaders(): Record<string, string> {
  const token = process.env.HARNESS_INTERNAL_TOKEN
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Internal-Token": token } : {}),
  }
}

async function registerMetadata(
  sessionId: string,
  name: string,
  uri: string,
  metadata: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const target = targetFromUri(uri)
  if (target.error) return { ok: false, skipped: true, reason: target.error }
  try {
    const contentType = typeof metadata?.content_type === "string" ? metadata.content_type : undefined
    const resp = await fetch(`${GATEWAY}/internal/artifact/register`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        session_id: sessionId,
        name,
        ...(target.url ? { url: target.url } : { path: target.localPath }),
        content_type: contentType,
        producer: "artifact_register",
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || !data?.ok) {
      console.warn(
        `[artifact_register] gateway register failed: status=${resp.status} code=${data?.code ?? ""} error=${data?.error ?? ""}`,
      )
      return { ok: false, http_status: resp.status, code: data?.code, error: data?.error }
    }
    return {
      ok: true,
      registered: true,
      slug: data.slug,
      version: data.version,
      changed: data.changed,
      verify_status: data.verify_status,
      sha256: data.sha256,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn(`[artifact_register] gateway register unreachable: ${error}`)
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
    "关键约束：action=register 必填 name/type/uri；list 可按 type 过滤；get 按 artifact_id 或 name；注册只写元数据、不产生/升级版本，也绝不隐式发布（要版本与 sha 证明用 artifact_publish；URL 的 sha 由 artifact_verify 探测后回填）。",
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
    // P2-13：javascript:/data: 等非 http(s) scheme 在进入任何登记前就 400。
    if (action === "register") {
      const target = targetFromUri(uri)
      if (target.error) {
        return fail(target.error, `uri scheme 不受支持（只接受 http/https 或本地路径）：${uri}`, {
          uri,
        })
      }
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/artifact`, {
        method: "POST",
        headers: internalHeaders(),
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
      // 登记后写 artifact store 元数据（只登记，不发布/不升版）。失败只记录，不阻断登记。
      const gatewayRegister =
        action === "register"
          ? await registerMetadata(context.sessionID, name, uri, args.metadata as Record<string, unknown> | undefined)
          : undefined
      return ok({
        title: `具型产物操作成功（${action}）`,
        ...data,
        ...(gatewayRegister ? { gateway_register: gatewayRegister } : {}),
      })
    } catch (e) {
      return fail("network_error", `产物注册通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
