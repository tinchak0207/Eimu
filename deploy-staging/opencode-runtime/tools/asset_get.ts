import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

// 死线②（片 AN，评测 REPORT S2）：scene_3d 条目的 GLB/BVH 本体存在笔记本
// .asset-cache/（多 GB，不上 VPS 不入 git），经 blender-bridge 反向隧道按
// artifactPath 取回字节；registry/api-url 条目的 artifactPath 本身就是远程
// URL，直接访问。两类 storage 以 artifactPath 前缀区分（.asset-cache/ = 本地）。
const BRIDGE_BASE = (process.env.BLENDER_BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/+$/, "")

export default tool({
  description:
    "按 pack_id 获取单个资产包详情（含 items 全文；免费）。GLB/BVH 本体（scene_3d 条目）经返回的 artifact_base_url 取回字节：artifact_base_url?path=<artifactPath 的 URL 编码>；registry/api-url 条目的 artifactPath 即可直接下载的远程 URL。",
  args: {
    pack_id: tool.schema.string().describe("资产包 ID（必填）"),
  },
  async execute(args, context) {
    try {
      const resp = await platformFetch(
        `/assets?id=${encodeURIComponent(args.pack_id)}`,
        {},
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询失败" })
      }

      const p = body?.packs?.[0]
      if (!p) {
        return fail("asset_pack_not_found", "未找到该资产包，请先用 asset_search 确认 pack_id", {
          title: "未找到资产包",
        })
      }

      const items: any[] = Array.isArray(p.items) ? p.items : []
      const hasLocal = items.some(
        (i) => typeof i?.artifactPath === "string" && i.artifactPath.startsWith(".asset-cache/"),
      )
      const hasRemote = items.some((i) => {
        const a = i?.artifactPath
        return typeof a === "string" && /^https?:\/\//.test(a)
      })
      if (hasLocal) {
        // 本地存储包：补 artifact_base_url（= 桥 /v1/artifact），agent 按此取 GLB/BVH 字节。
        return ok({
          title: p.title,
          pack: p,
          artifact_base_url: `${BRIDGE_BASE}/v1/artifact`,
          byte_fetch:
            "GLB/BVH 等本体字节（artifactPath 以 .asset-cache/ 开头的条目）用 " +
            "<artifact_base_url>?path=<item.artifactPath 的 URL 编码> 取回（HTTP 200 二进制）；" +
            "也可让 blender_exec 在脚本里直接 import 同一 artifactPath（桥主机本地可读）。",
        })
      }
      if (hasRemote) {
        // registry/api-url 存储包：item.artifactPath 本就是远程 URL，直接下载。
        return ok({
          title: p.title,
          pack: p,
          byte_fetch:
            "本包条目的 artifactPath 为可直接下载的远程 URL（registry/api-url 存储），直接访问即可；" +
            "与本地 .asset-cache/ 存储包（经 artifact_base_url 取字节）是两类 storage。",
        })
      }
      return ok({ title: p.title, pack: p })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})
