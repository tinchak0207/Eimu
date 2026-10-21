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
import { uploadBlob, blobPath } from "./img-composite"
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
}
const MAX_PUBLISH = 12
const MAX_PUBLISH_BYTES = 200 * 1024 * 1024

async function publishArtifacts(result: { title: string; output: string }, context: { abort?: AbortSignal }) {
  let data: any
  try {
    data = JSON.parse(result.output)
  } catch {
    return result
  }
  if (!data?.ok || !Array.isArray(data.artifacts) || !data.artifact_base_url) return result
  const published: string[] = []
  for (const a of data.artifacts) {
    const ext = String(a?.path ?? "").split(".").pop()?.toLowerCase() ?? ""
    const contentType = PUBLISH_TYPES[ext]
    if (!contentType || published.length >= MAX_PUBLISH) continue
    if (typeof a.bytes === "number" && a.bytes > MAX_PUBLISH_BYTES) continue
    try {
      const res = await fetch(`${data.artifact_base_url}?path=${encodeURIComponent(a.path)}`, { signal: context.abort })
      if (!res.ok) throw new Error(`取回产物 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      a.public_url = await uploadBlob(blobPath("blender", ext), buf, contentType, context.abort)
      published.push(a.public_url)
    } catch (e) {
      a.publish_error = (e as Error).message
    }
  }
  if (published.length) {
    data.public_urls = published
    data.delivery_hint =
      "public_urls 是用户可见的平台地址：交付时直接给这些 URL（图片/影片会出卡），或用 workflow_add_node 注入画布；artifact_base_url 是内部地址，禁止交给用户。"
  }
  return { ...result, output: JSON.stringify(data) }
}

export { blenderExecTool, blenderRenderTool, blenderExportGltfTool }
