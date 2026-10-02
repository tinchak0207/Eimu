import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, blobPath, pickFont } from "../lib/img-composite"

// 九宮格/切片封面排版（2026-08-31 片3）：圖組 → 網格拼貼封面，落公網 URL。
// 純確定性 PIL 拼貼（零生圖扣費、零 LLM）：可配列數/間距/背景/劇名安全區文字。

export default tool({
  description:
    "九宮格/切片封面排版（純確定性 PIL，零生圖扣費、零 LLM）：urls（圖組 URL JSON 陣列）或 node_ids（畫布節點）→ 網格拼貼。可配 cols（列數，默認 3）、cell（單格像素，默認 512）、spacing（間距，默認 16）、bg（背景 HEX，默認 #ffffff）、title（劇名/標題，繪於頂部安全區）、title_area（安全區高度像素）。每格等比 contain 置中補背景（不拉伸）。輸出拼貼圖公網 URL + 實測尺寸。誠實：這是排版拼貼，非 AI 合成；單張下載失敗跳過並在 missing 如實標注。",
  args: {
    urls: tool.schema.string().optional().describe("圖組 URL JSON 陣列字串"),
    node_ids: tool.schema.string().optional().describe("畫布節點 id JSON 陣列字串"),
    cols: tool.schema.number().int().min(1).max(6).optional().describe("每列格數，默認 3"),
    cell: tool.schema.number().int().min(128).max(1024).optional().describe("單格邊長像素，默認 512"),
    spacing: tool.schema.number().int().min(0).max(128).optional().describe("格間距像素，默認 16"),
    bg: tool.schema.string().optional().describe("背景 HEX，例 #ffffff"),
    title: tool.schema.string().optional().describe("頂部安全區標題文字（劇名）"),
    title_area: tool.schema.number().int().min(0).max(400).optional().describe("標題安全區高度像素（有 title 時默認 96，否則 0）"),
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
      return fail("invalid_input", "urls / node_ids 必須是 JSON 陣列字串", { title: "輸入非法" })
    }
    if (!nodeIds.length && !urls.length) return fail("empty_input", "urls 與 node_ids 至少填一個", { title: "輸入缺失" })

    let resolved = [...new Set(urls)]
    const missing: string[] = []
    if (nodeIds.length) {
      try {
        const { gatewayReadSnapshot } = await import("../lib/canvas-flow")
        const snap = await gatewayReadSnapshot(process.env.GATEWAY_URL || "http://127.0.0.1:8081", context.sessionID)
        if (!snap.has_state || snap.state === null) {
          missing.push(...nodeIds.map((i) => `${i}（畫布未上報狀態）`))
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
        return fail("canvas_unavailable", `讀畫布快照失敗：${e?.message ?? e}`, { title: "畫布不可用" })
      }
    }
    resolved = [...new Set(resolved)]
    if (!resolved.length) return fail("no_images", `無可排版圖片：${missing.join("; ") || "空"}`, { title: "無圖片" })
    if (resolved.length > 36) return fail("too_many", "單次最多 36 張", { title: "輸入過多" })

    // 逐張下載，失敗跳過
    const inputs: Record<string, Buffer> = {}
    const order: string[] = []
    for (let i = 0; i < resolved.length; i++) {
      try {
        inputs[`img${i}`] = await downloadImage(resolved[i], context.abort)
        order.push(`img${i}`)
      } catch (e: any) {
        missing.push(`${resolved[i]}（下載失敗）`)
      }
    }
    if (!order.length) return fail("all_download_failed", `全部圖片下載失敗：${missing.join("; ")}`, { title: "無有效圖片" })

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
    if (!job.ok || !job.files?.grid) return fail("grid_failed", `拼貼失敗：${job.stderr}`, { title: "拼貼失敗" })

    let pubUrl: string
    try {
      pubUrl = await uploadBlob(blobPath("grid"), job.files.grid, "image/png", context.abort)
    } catch (e: any) {
      return fail("upload_failed", `上傳公網失敗：${e?.message ?? e}`, { title: "上傳失敗" })
    }

    const cols = Math.min(args.cols ?? 3, order.length)
    const rows = Math.ceil(order.length / cols)
    return ok(
      {
        title: `九宮格排版：${order.length} 格（${cols}×${rows}）`,
        url: pubUrl,
        grid: { cols, rows, cells: order.length, size: `${job.result?.width}x${job.result?.height}` },
        missing,
        note: "純 PIL 網格拼貼（每格 contain 置中補背景，不拉伸）；missing 為下載失敗/無 URL 的來源，已跳過不編造。",
      },
      { url: pubUrl },
    )
  },
})
