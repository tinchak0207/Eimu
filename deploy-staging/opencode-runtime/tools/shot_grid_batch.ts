import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, blobPath, pickFont } from "../lib/img-composite"

// 九宫格/切片封面排版（2026-08-31 片3）：图组 → 网格拼贴封面，落公网 URL。
// 纯确定性 PIL 拼贴（零生图扣费、零 LLM）：可配列数/间距/背景/剧名安全区文字。

export default tool({
  description:
    "九宫格/切片封面排版（纯确定性 PIL，零生图扣费、零 LLM）：urls（图组 URL JSON 阵列）或 node_ids（画布节点）→ 网格拼贴。可配 cols（列数，默认 3）、cell（单格像素，默认 512）、spacing（间距，默认 16）、bg（背景 HEX，默认 #ffffff）、title（剧名/标题，绘于顶部安全区）、title_area（安全区高度像素）。每格等比 contain 置中补背景（不拉伸）。输出拼贴图公网 URL + 实测尺寸。诚实：这是排版拼贴，非 AI 合成；单张下载失败跳过并在 missing 如实标注。",
  args: {
    urls: tool.schema.string().optional().describe("图组 URL JSON 阵列字串"),
    node_ids: tool.schema.string().optional().describe("画布节点 id JSON 阵列字串"),
    cols: tool.schema.number().int().min(1).max(6).optional().describe("每列格数，默认 3"),
    cell: tool.schema.number().int().min(128).max(1024).optional().describe("单格边长像素，默认 512"),
    spacing: tool.schema.number().int().min(0).max(128).optional().describe("格间距像素，默认 16"),
    bg: tool.schema.string().optional().describe("背景 HEX，例 #ffffff"),
    title: tool.schema.string().optional().describe("顶部安全区标题文字（剧名）"),
    title_area: tool.schema.number().int().min(0).max(400).optional().describe("标题安全区高度像素（有 title 时默认 96，否则 0）"),
  },
  async execute(args, context) {
    const nodeIds: string[] = []
    const urls: string[] = []
    try {
      if (args.node_ids) {
        const j = JSON.parse(args.node_ids)
        if (Array.isArray(j)) nodeIds.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      }
      if (args.urls) {
        const j = JSON.parse(args.urls)
        if (Array.isArray(j)) urls.push(...j.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x.trim())).map((s) => s.trim()))
      }
    } catch {
      return fail("invalid_input", "urls / node_ids 必须是 JSON 阵列字串", { title: "输入非法" })
    }
    if (!nodeIds.length && !urls.length) return fail("empty_input", "urls 与 node_ids 至少填一个", { title: "输入缺失" })

    let resolved = [...new Set(urls)]
    const missing: string[] = []
    if (nodeIds.length) {
      try {
        const { gatewayReadSnapshot } = await import("../lib/canvas-flow")
        const snap = await gatewayReadSnapshot(process.env.GATEWAY_URL || "http://127.0.0.1:8081", context.sessionID)
        if (!snap.has_state || snap.state === null) {
          missing.push(...nodeIds.map((i) => `${i}（画布未上报状态）`))
        } else {
          const nodes = (Array.isArray(snap.state.nodes) ? snap.state.nodes : []) as Record<string, unknown>[]
          const byId = new Map(nodes.map((n) => [String(n.id ?? ""), n]))
          for (const id of nodeIds) {
            const n = byId.get(id)
            const meta = (n && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>
            const u = (meta.content || meta.url || meta.result_url) as string | undefined
            if (n && typeof u === "string" && /^https?:\/\//.test(u)) resolved.push(u)
            else missing.push(id)
          }
        }
      } catch (e: any) {
        return fail("canvas_unavailable", `读画布快照失败：${e?.message ?? e}`, { title: "画布不可用" })
      }
    }
    resolved = [...new Set(resolved)]
    if (!resolved.length) return fail("no_images", `无可排版图片：${missing.join("; ") || "空"}`, { title: "无图片" })
    if (resolved.length > 36) return fail("too_many", "单次最多 36 张", { title: "输入过多" })

    // 逐张下载，失败跳过
    const inputs: Record<string, Buffer> = {}
    const order: string[] = []
    for (let i = 0; i < resolved.length; i++) {
      try {
        inputs[`img${i}`] = await downloadImage(resolved[i], context.abort)
        order.push(`img${i}`)
      } catch (e: any) {
        missing.push(`${resolved[i]}（下载失败）`)
      }
    }
    if (!order.length) return fail("all_download_failed", `全部图片下载失败：${missing.join("; ")}`, { title: "无有效图片" })

    const title = args.title?.trim() || null
    const titleArea = args.title_area ?? (title ? 96 : 0)
    const job = await runPIL({
      inputs,
      params: {
        order,
        cols: args.cols ?? 3,
        cell: args.cell ?? 512,
        spacing: args.spacing ?? 16,
        bg: args.bg ?? "#ffffff",
        title,
        title_area: titleArea,
        font_path: title ? pickFont(title) : null,
      },
      outputs: ["grid"],
      code: `
order=PARAMS['order']
imgs=[load(n).convert('RGB') for n in order]
out=imgops.grid(imgs, cols=int(PARAMS['cols']), cell=int(PARAMS['cell']), spacing=int(PARAMS['spacing']),
                bg=PARAMS['bg'], title=PARAMS.get('title'), font_path=PARAMS.get('font_path'), title_area=int(PARAMS.get('title_area',0)))
out.save(OUT['grid'],'PNG')
emit(width=out.width, height=out.height, cells=len(imgs))
`,
      timeoutMs: 120_000,
      signal: context.abort,
    })
    if (!job.ok || !job.files?.grid) return fail("grid_failed", `拼贴失败：${job.stderr}`, { title: "拼贴失败" })

    let pubUrl: string
    try {
      pubUrl = await uploadBlob(blobPath("grid"), job.files.grid, "image/png", context.abort)
    } catch (e: any) {
      return fail("upload_failed", `上传公网失败：${e?.message ?? e}`, { title: "上传失败" })
    }

    const cols = Math.min(args.cols ?? 3, order.length)
    const rows = Math.ceil(order.length / cols)
    return ok(
      {
        title: `九宫格排版：${order.length} 格（${cols}×${rows}）`,
        url: pubUrl,
        grid: { cols, rows, cells: order.length, size: `${job.result?.width}x${job.result?.height}` },
        missing,
        note: "纯 PIL 网格拼贴（每格 contain 置中补背景，不拉伸）；missing 为下载失败/无 URL 的来源，已跳过不编造。",
      },
      { url: pubUrl },
    )
  },
})
