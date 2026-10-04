import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, subjectBox, blobPath } from "../lib/img-composite"

// 多画幅矩阵（2026-08-31 片3）：主视觉 + 分镜图组 → 逐图 × 逐画幅的重排矩阵。
// 与 multi_aspect_reflow 共用同一核心（img-composite.runPIL + imgops.reflow + subjectBox），
// 差别只在批量：对每张输入图各跑一次 VLM 引导重排，输出矩阵。零生图扣费。

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
    return { row: { source: url }, err: `下载失败 ${e?.message ?? e}` }
  }
  const probe = await runPIL({ inputs: { img: buf }, code: `im=load('img').convert('RGB'); emit(width=im.width,height=im.height)`, signal: abort })
  if (!probe.ok || !probe.result) return { row: { source: url }, err: "解析失败" }
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
  if (!job.ok) return { row: { source: url, width: w, height: h }, err: `重排失败 ${job.stderr}` }
  const cells: Record<string, unknown>[] = []
  for (const t of targets) {
    const b = job.files?.[t.name]
    if (!b) {
      cells.push({ name: t.name, error: "无输出" })
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
      cells.push({ name: t.name, error: `上传失败 ${e?.message ?? e}` })
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
    "多画幅矩阵（零生图扣费）：hero_url 主视觉 + shot_urls（JSON 阵列，分镜/其他主视觉）→ 逐图 × 逐画幅重排矩阵。机制同 multi_aspect_reflow（VLM 框主体 → PIL 主体锚定裁切保像素，标 vlm_guided_crop），批量版。targets 可自订画幅集，默认横/竖/方。输出矩阵：每列一张源图、每格一个画幅的公网 URL 与实测尺寸。单图失败不炸整批，该列标 error。",
  args: {
    hero_url: tool.schema.string().optional().describe("主视觉 URL（可选，与 shot_urls 合并去重）"),
    shot_urls: tool.schema.string().optional().describe('分镜/图组 URL JSON 阵列字串，例 ["https://...","https://..."]'),
    targets: tool.schema.string().optional().describe("目标画幅 JSON 阵列字串，默认横16:9/竖9:16/方1:1"),
    max_side: tool.schema.number().int().min(256).max(4096).optional().describe("输出长边上限，默认 1600"),
  },
  async execute(args, context) {
    const urls: string[] = []
    if (args.hero_url && /^https?:\/\//.test(args.hero_url.trim())) urls.push(args.hero_url.trim())
    if (args.shot_urls) {
      try {
        const j = JSON.parse(args.shot_urls)
        if (!Array.isArray(j)) return fail("invalid_shot_urls", "shot_urls 必须是 JSON 阵列字串", { title: "输入非法" })
        for (const u of j) if (typeof u === "string" && /^https?:\/\//.test(u.trim())) urls.push(u.trim())
      } catch {
        return fail("invalid_shot_urls", "shot_urls 必须是合法 JSON 阵列字串", { title: "输入非法" })
      }
    }
    const uniq = [...new Set(urls)]
    if (!uniq.length) return fail("empty_input", "hero_url 与 shot_urls 至少提供一个合法 http(s) URL", { title: "输入缺失" })
    if (uniq.length > 12) return fail("too_many", "单次最多 12 张（避免 VLM 呼叫爆炸）", { title: "输入过多" })

    let targets = DEFAULT_TARGETS
    if (args.targets) {
      try {
        const j = JSON.parse(args.targets)
        if (!Array.isArray(j) || !j.length) return fail("invalid_targets", "targets 必须是非空 JSON 阵列", { title: "输入非法" })
        targets = j.map((t: any, i: number) => ({ name: String(t?.name ?? `t${i}`), ratio: Number(t?.ratio) }))
        if (targets.some((t) => !isFinite(t.ratio) || t.ratio <= 0)) return fail("invalid_targets", "targets 每项 ratio 必须为正数", { title: "输入非法" })
      } catch {
        return fail("invalid_targets", "targets 必须是合法 JSON 阵列字串", { title: "输入非法" })
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
    if (!okCells) return fail("all_failed", "全部图重排失败（见 matrix 各列 error）", { title: "无产出" })

    return ok(
      {
        title: `多画幅矩阵：${uniq.length} 图 × ${targets.length} 画幅`,
        targets: targets.map((t) => ({ name: t.name, ratio: Math.round(t.ratio * 1e4) / 1e4 })),
        matrix,
        note: "每格 mechanism=vlm_guided_crop（VLM 主体框锚定裁切保像素，非拉伸）；单图失败仅标该列 error，不影响其他列。",
      },
      { cells: okCells },
    )
  },
})
