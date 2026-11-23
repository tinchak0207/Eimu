/**
 * blender_* 三工具 opencode 形状机械包装器（staging 稿，片 AJ，2026-09-06）。
 *
 * 行为真源 = blender-tools-impl.ts（由 tools/export-blender-tools-staging.ts 从
 * src/lib/blender-tools.ts 机械导出，BlenderToolDef 描述符形状）。本档把它包装成
 * opencode tool()（形状轮子 = src/vendor-bridges/opencode-tools/director_*.ts 的
 * tool({ description, args, execute }) + { title, output: JSON 字串 } 契约）。
 * 描述符 → schema 的映射是纯机械翻译：string→string、number→number、boolean→boolean、
 * enum→enum、required 缺省→optional；args 名/描述/enum 全部取自工具自带定义，
 * 零二次维护面（真源改 args，包装自动跟随）。
 *
 * VPS 落位（完整命令见同目录 PATCH-PLAN.md）：
 *   本档整份 → /opt/agent-harness/workspace/.opencode/lib/blender-tools-adapter.ts
 *   三个 3 行 adapter → .opencode/tools/blender_{exec,render,export_gltf}.ts：
 *     import { wrapBlenderTool, blenderExecTool } from "../lib/blender-tools-adapter"
 *     export default wrapBlenderTool(blenderExecTool)
 *
 * 产物取回（片 AJ）：exec/render 成功 output 带 artifact_base_url，agent 用
 * `${artifact_base_url}?path=${encodeURIComponent(artifact.path)}` 经桥取回字节；
 * 沙箱不自持档案，禁止在沙箱 ls 等产物。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { mkdir, mkdtemp, writeFile, rm, chmod } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  blenderExecTool,
  blenderRenderTool,
  blenderExportGltfTool,
  type BlenderToolDef,
  type BlenderToolContext,
} from "./blender-tools-impl"

export function wrapBlenderTool(def: BlenderToolDef) {
  return tool({
    description: def.description,
    args: Object.fromEntries(
      Object.entries(def.args).map(([name, spec]) => {
        let s: ReturnType<typeof tool.schema.string>
        if (spec.type === "string") {
          s = ("enum" in spec && spec.enum ? tool.schema.enum([...spec.enum]) : tool.schema.string()) as never
        } else if (spec.type === "number") {
          s = tool.schema.number() as never
        } else {
          s = tool.schema.boolean() as never
        }
        if (!spec.required) s = s.optional() as never
        return [name, s.describe(spec.description)]
      }),
    ),
    async execute(args: Record<string, unknown>, context: BlenderToolContext) {
      return publishArtifacts(await def.execute(args, context), context)
    },
  })
}

/**
 * 产物公网化（2026-09-29）：桥产物只有 127.0.0.1 取回地址，用户看不到。
 * 成功结果里的图片／影片／glb 经桥取回后用 uploadBlob（sketch_lock／
 * background_remove 同款公网 blob 轮子）入库，artifact 补 public_url。
 * 任一入库失败只标 publish_error，不影响原结果。
 */
const PUBLISH_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  glb: "model/gltf-binary",
  blend: "application/x-blender",
  gltf: "model/gltf+json",
}
const MAX_PUBLISH = 12
const MAX_PUBLISH_BYTES = 200 * 1024 * 1024

async function publishArtifacts(result: { title: string; output: string }, context: BlenderToolContext & { sessionID?: string }) {
  let data: any
  try {
    data = JSON.parse(result.output)
  } catch {
    return result
  }
  if (!Array.isArray(data?.artifacts) || !data.artifact_base_url) return result
  const published: string[] = []
  // Keep editable sources and models ahead of preview frames when the receipt is large.
  const candidates = [...data.artifacts].sort((a, b) => Number(/\.(blend|glb|gltf)$/i.test(b?.path ?? "")) - Number(/\.(blend|glb|gltf)$/i.test(a?.path ?? "")))
  for (const a of candidates) {
    const ext = String(a?.path ?? "").split(".").pop()?.toLowerCase() ?? ""
    const contentType = PUBLISH_TYPES[ext]
    if (!contentType) continue
    if (typeof a.bytes === "number" && a.bytes > MAX_PUBLISH_BYTES) {
      a.publish_error = "产物超过 200MiB 发布上限，未交付"
      a.publish_error_code = "oversized"
      continue
    }
    if (published.length >= MAX_PUBLISH) {
      a.publish_error = "本次最多发布 12 件产物，此件尚未交付"
      a.publish_error_code = "publish_limit"
      continue
    }
    let temporary: string | undefined
    try {
      if (!context.sessionID) throw new Error("产物已生成，但缺少会话身份，未发布")
      const res = await fetch(`${data.artifact_base_url}?path=${encodeURIComponent(a.path)}`, { signal: context.abort })
      if (!res.ok) throw new Error(`取回产物 HTTP ${res.status}`)
      if (Number(res.headers.get("content-length")) > MAX_PUBLISH_BYTES) {
        await res.body?.cancel()
        throw new Error("产物超过发布大小上限")
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error("产物响应缺少内容")
      const chunks: Buffer[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > MAX_PUBLISH_BYTES) { await reader.cancel(); throw new Error("产物超过发布大小上限") }
          chunks.push(Buffer.from(chunk.value))
        }
      } finally { reader.releaseLock() }
      const buf = Buffer.concat(chunks, bytes)
      if (!buf.length || buf.length > MAX_PUBLISH_BYTES) throw new Error("产物为空或超过发布大小上限")
      const root = join(process.env.AGENT_WORKSPACE || "/opt/agent-harness/workspace", "out", "blender-delivery")
      await mkdir(root, { recursive: true, mode: 0o750 })
      temporary = await mkdtemp(join(root, "delivery-"))
      await chmod(temporary, 0o750)
      const localPath = join(temporary, `asset.${ext}`)
      await writeFile(localPath, buf, { mode: 0o640, flag: "wx" })
      const gateway = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
      const response = await fetch(`${gateway}/internal/artifact/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.HARNESS_INTERNAL_TOKEN ? { "X-Internal-Token": process.env.HARNESS_INTERNAL_TOKEN } : {}) },
        body: JSON.stringify({ session_id: context.sessionID, name: `blender_${createHash("sha256").update(a.path).digest("hex").slice(0, 24)}`, path: localPath, content_type: contentType }),
        signal: context.abort ?? AbortSignal.timeout(30_000),
      })
      const receipt = await response.json() as { ok?: boolean; url?: string; error?: string; artifact_id?: string; version?: number }
      if (!response.ok || !receipt.ok || !receipt.url) throw new Error(receipt.error || `产物发布未完成 HTTP ${response.status}`)
      a.public_url = receipt.url
      a.artifact_id = receipt.artifact_id
      a.version = receipt.version
      published.push(a.public_url)
    } catch (e) {
      a.publish_error = (e as Error).message
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }
  data.public_urls = published
  data.missing_artifacts = candidates
    .filter((a: any) => PUBLISH_TYPES[String(a?.path ?? "").split(".").pop()?.toLowerCase() ?? ""] && !a.public_url)
    .map((a: any) => ({ path: a.path, bytes: a.bytes, reason: a.publish_error_code ?? "publish_failed", error: a.publish_error ?? "产物尚未交付" }))
  data.delivery_state = published.length ? (data.artifacts.some((a: any) => a.publish_error) ? "partial" : "published") : "unavailable"
  if (published.length) {
    data.delivery_hint =
      "public_urls 是账号鉴权下载地址，外部客户端须用自己的 Eimu API key 作为 Authorization: Bearer 请求头下载；artifact_base_url 是内部地址，禁止交给用户。"
  }
  return { ...result, output: JSON.stringify(data) }
}

export { blenderExecTool, blenderRenderTool, blenderExportGltfTool }
