/**
 * blender_* 三工具 opencode 形狀機械包裝器（staging 稿，片 AJ，2026-09-06）。
 *
 * 行為真源 = blender-tools-impl.ts（由 tools/export-blender-tools-staging.ts 從
 * src/lib/blender-tools.ts 機械導出，BlenderToolDef 描述符形狀）。本檔把它包裝成
 * opencode tool()（形狀輪子 = src/vendor-bridges/opencode-tools/director_*.ts 的
 * tool({ description, args, execute }) + { title, output: JSON 字串 } 契約）。
 * 描述符 → schema 的映射是純機械翻譯：string→string、number→number、boolean→boolean、
 * enum→enum、required 缺省→optional；args 名/描述/enum 全部取自工具自帶定義，
 * 零二次維護面（真源改 args，包裝自動跟隨）。
 *
 * VPS 落位（完整命令見同目錄 PATCH-PLAN.md）：
 *   本檔整份 → /opt/agent-harness/workspace/.opencode/lib/blender-tools-adapter.ts
 *   三個 3 行 adapter → .opencode/tools/blender_{exec,render,export_gltf}.ts：
 *     import { wrapBlenderTool, blenderExecTool } from "../lib/blender-tools-adapter"
 *     export default wrapBlenderTool(blenderExecTool)
 *
 * 產物取回（片 AJ）：exec/render 成功 output 帶 artifact_base_url，agent 用
 * `${artifact_base_url}?path=${encodeURIComponent(artifact.path)}` 經橋取回字節；
 * 沙箱不自持檔案，禁止在沙箱 ls 等產物。
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
 * 產物公網化（2026-09-29）：橋產物只有 127.0.0.1 取回地址，用戶看不到。
 * 成功結果裡的圖片／影片／glb 經橋取回後用 uploadBlob（sketch_lock／
 * background_remove 同款公網 blob 輪子）入庫，artifact 補 public_url。
 * 任一入庫失敗只標 publish_error，不影響原結果。
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
