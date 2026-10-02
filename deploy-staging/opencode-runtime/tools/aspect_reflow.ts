import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, subjectBox, blobPath } from "../lib/img-composite"

// 多畫幅矩陣（2026-08-31 片3）：主視覺 + 分鏡圖組 → 逐圖 × 逐畫幅的重排矩陣。
// 與 multi_aspect_reflow 共用同一核心（img-composite.runPIL + imgops.reflow + subjectBox），
// 差別只在批量：對每张輸入圖各跑一次 VLM 引導重排，輸出矩陣。零生圖扣費。

const DEFAULT_TARGETS = [
  { name: "landscape", ratio: 16 / 9 },
  { name: "portrait", ratio: 9 / 16 },
  { name: "square", ratio: 1 },
]

async function reflowOne(
  url: string,
  targets: { name: string; ratio: number }[],
  maxSide: number,
  abort?: AbortSignal,
): Promise<{ row: Record<string, unknown>; err?: string }> {
  let buf: Buffer
  try {
    buf = await downloadImage(url, abort)
  } catch (e: any) {
    return { row: { source: url }, err: `下載失敗 ${e?.message ?? e}` }
  }
  const probe = await runPIL({ inputs: { img: buf }, code: `im=load('img').convert('RGB'); emit(width=im.width,height=im.height)`, signal: abort })
  if (!probe.ok || !probe.result) return { row: { source: url }, err: "解析失敗" }
  const w = Number(probe.result.width), h = Number(probe.result.height)
  const box = await subjectBox(url, w, h)
  const job = await runPIL({
    inputs: { img: buf },
    params: { targets, bbox: box.bbox, max_side: maxSide },
    outputs: targets.map((t) => t.name),
    code: `
targets=PARAMS['targets']; bbox=PARAMS.get('bbox'); ms=int(PARAMS.get('max_side',1600))
im=load('img').convert('RGB')
sizes={}
for t in targets:
    out=imgops.reflow(im, float(t['ratio']), bbox=tuple(bbox) if bbox else None, max_side=ms)
    out.save(OUT[t['name']],'PNG'); sizes[t['name']]=list(out.size)
emit(sizes=sizes, used_bbox=bool(bbox))
`,
    timeoutMs: 120_000,
    signal: abort,
  })
  if (!job.ok) return { row: { source: url, width: w, height: h }, err: `重排失敗 ${job.stderr}` }
  const cells: Record<string, unknown>[] = []
  for (const t of targets) {
    const b = job.files?.[t.name]
    if (!b) {
      cells.push({ name: t.name, error: "無輸出" })
      continue
    }
    try {
      const pubUrl = await uploadBlob(blobPath(`amx-${t.name}`), b, "image/png", abort)
      cells.push({
        name: t.name,
        ratio: Math.round(t.ratio * 1e4) / 1e4,
        width: (job.result?.sizes as any)?.[t.name]?.[0] ?? null,
        height: (job.result?.sizes as any)?.[t.name]?.[1] ?? null,
        url: pubUrl,
        mechanism: "vlm_guided_crop",
      })
    } catch (e: any) {
      cells.push({ name: t.name, error: `上傳失敗 ${e?.message ?? e}` })
    }
  }
  return {
    row: {
      source: url,
      width: w,
      height: h,
      vlm_status: box.ok ? "ok" : `centered_fallback: ${box.reason}`,
      cells,
    },
  }
}

export default tool({
  description:
    "多畫幅矩陣（零生圖扣費）：hero_url 主視覺 + shot_urls（JSON 陣列，分鏡/其他主視覺）→ 逐圖 × 逐畫幅重排矩陣。機制同 multi_aspect_reflow（VLM 框主體 → PIL 主體錨定裁切保像素，標 vlm_guided_crop），批量版。targets 可自訂畫幅集，默認橫/豎/方。輸出矩陣：每列一張源圖、每格一個畫幅的公網 URL 與實測尺寸。單圖失敗不炸整批，該列標 error。",
  args: {
    hero_url: tool.schema.string().optional().describe("主視覺 URL（可選，與 shot_urls 合併去重）"),
    shot_urls: tool.schema.string().optional().describe('分鏡/圖組 URL JSON 陣列字串，例 ["https://...","https://..."]'),
    targets: tool.schema.string().optional().describe("目標畫幅 JSON 陣列字串，默認橫16:9/豎9:16/方1:1"),
    max_side: tool.schema.number().int().min(256).max(4096).optional().describe("輸出長邊上限，默認 1600"),
  },
  async execute(args, context) {
    const urls: string[] = []
    if (args.hero_url && /^https?:\/\//.test(args.hero_url.trim())) urls.push(args.hero_url.trim())
    if (args.shot_urls) {
      try {
        const j = JSON.parse(args.shot_urls)
        if (!Array.isArray(j)) return fail("invalid_shot_urls", "shot_urls 必須是 JSON 陣列字串", { title: "輸入非法" })
        for (const u of j) if (typeof u === "string" && /^https?:\/\//.test(u.trim())) urls.push(u.trim())
      } catch {
        return fail("invalid_shot_urls", "shot_urls 必須是合法 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    const uniq = [...new Set(urls)]
    if (!uniq.length) return fail("empty_input", "hero_url 與 shot_urls 至少提供一個合法 http(s) URL", { title: "輸入缺失" })
    if (uniq.length > 12) return fail("too_many", "單次最多 12 張（避免 VLM 呼叫爆炸）", { title: "輸入過多" })

    let targets = DEFAULT_TARGETS
    if (args.targets) {
      try {
        const j = JSON.parse(args.targets)
        if (!Array.isArray(j) || !j.length) return fail("invalid_targets", "targets 必須是非空 JSON 陣列", { title: "輸入非法" })
        targets = j.map((t: any, i: number) => ({ name: String(t?.name ?? `t${i}`), ratio: Number(t?.ratio) }))
        if (targets.some((t) => !isFinite(t.ratio) || t.ratio <= 0)) return fail("invalid_targets", "targets 每項 ratio 必須為正數", { title: "輸入非法" })
      } catch {
        return fail("invalid_targets", "targets 必須是合法 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    const maxSide = args.max_side ?? 1600

    const matrix: Record<string, unknown>[] = []
    let okCells = 0
    for (const u of uniq) {
      const { row, err } = await reflowOne(u, targets, maxSide, context.abort)
      if (err) row.error = err
      else okCells += (row.cells as any[])?.filter((c) => c.url).length ?? 0
      matrix.push(row)
    }
    if (!okCells) return fail("all_failed", "全部圖重排失敗（見 matrix 各列 error）", { title: "無產出" })

    return ok(
      {
        title: `多畫幅矩陣：${uniq.length} 圖 × ${targets.length} 畫幅`,
        targets: targets.map((t) => ({ name: t.name, ratio: Math.round(t.ratio * 1e4) / 1e4 })),
        matrix,
        note: "每格 mechanism=vlm_guided_crop（VLM 主體框錨定裁切保像素，非拉伸）；單圖失敗僅標該列 error，不影響其他列。",
      },
      { cells: okCells },
    )
  },
})
