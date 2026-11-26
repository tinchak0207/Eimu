import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, subjectBox, blobPath } from "../lib/img-composite"

// 多画幅重排（2026-08-31 片3）：主视觉 → 横/竖/方多画幅切图。
// 诚实机制 = VLM 引导重排（vlm_guided_crop）：VLM 框主体 → PIL 以主体为锚裁切（保像素、
// 不拉伸变形），仅当裁切窗无法容纳主体时才补边。宣称「重排非缩放」= 主体置中保像素。

const DEFAULT_TARGETS = [
  { name: "landscape", ratio: 16 / 9 },
  { name: "portrait", ratio: 9 / 16 },
  { name: "square", ratio: 1 },
]

function parseTargets(raw?: string): { ok: true; value: { name: string; ratio: number }[] } | { ok: false; hint: string } {
  if (!raw) return { ok: true, value: DEFAULT_TARGETS }
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j) || !j.length) return { ok: false, hint: "targets 必须是非空 JSON 阵列" }
    const value = j.map((t: any, i: number) => {
      let ratio = Number(t?.ratio)
      if (!isFinite(ratio) && t?.w && t?.h) ratio = Number(t.w) / Number(t.h)
      const name = String(t?.name ?? `target_${i}`)
      if (!isFinite(ratio) || ratio <= 0) throw new Error("bad ratio")
      return { name, ratio }
    })
    return { ok: true, value }
  } catch {
    return { ok: false, hint: 'targets 格式非法，例：[{"name":"landscape","ratio":1.7778}]' }
  }
}

export default tool({
  description:
    "多画幅重排（零生图扣费）：image_url 填主视觉 URL，可选 targets（JSON 阵列 [{name,ratio}]，默认横16:9/竖9:16/方1:1）。机制=VLM 框主体边界框 → PIL 以主体为锚裁切到各目标画幅（保像素、不拉伸；主体超出裁切窗时才补模糊边）。每张输出标 mechanism=vlm_guided_crop，落公网 URL。诚实：这是裁切/补边重排，非 AI 重绘扩图，也非整图拉伸；VLM 不可达时退化为置中裁切并如实标 vlm_status。",
  args: {
    image_url: tool.schema.string().describe("主视觉图片 URL"),
    targets: tool.schema.string().optional().describe('目标画幅 JSON 阵列字串，例 [{"name":"landscape","ratio":1.7778},{"name":"square","ratio":1}]'),
    max_side: tool.schema.number().int().min(256).max(4096).optional().describe("输出长边上限像素，默认 1600"),
  },
  async execute(args, context) {
    const url = args.image_url.trim()
    if (!/^https?:\/\//.test(url)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    const tg = parseTargets(args.targets)
    if (!tg.ok) return fail("invalid_targets", tg.hint, { title: "输入非法" })
    const targets = tg.value

    let buf: Buffer
    try {
      buf = await downloadImage(url, context.abort)
    } catch (e: any) {
      return fail("download_failed", `下载主视觉失败：${e?.message ?? e}`, { title: "下载失败" })
    }

    const probe = await runPIL({
      inputs: { img: buf },
      code: `im=load('img').convert('RGB'); emit(width=im.width, height=im.height)`,
      signal: context.abort,
    })
    if (!probe.ok || !probe.result) return fail("decode_failed", `图片解析失败：${probe.stderr}`, { title: "解析失败" })
    const w = Number(probe.result.width), h = Number(probe.result.height)

    const box = await subjectBox(url, w, h)
    const maxSide = args.max_side ?? 1600

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
    out.save(OUT[t['name']], 'PNG')
    sizes[t['name']]=list(out.size)
emit(sizes=sizes, used_bbox=bool(bbox))
`,
      timeoutMs: 120_000,
      signal: context.abort,
    })
    if (!job.ok) return fail("reflow_failed", `重排执行失败：${job.stderr}`, { title: "重排失败" })

    const outputs: Record<string, unknown>[] = []
    const errors: string[] = []
    for (const t of targets) {
      const b = job.files?.[t.name]
      if (!b) {
        errors.push(`${t.name}：无输出档`)
        continue
      }
      let pubUrl: string
      try {
        pubUrl = await uploadBlob(blobPath(`reflow-${t.name}`), b, "image/png", context.abort)
      } catch (e: any) {
        errors.push(`${t.name}：上传失败 ${e?.message ?? e}`)
        continue
      }
      outputs.push({
        name: t.name,
        ratio: Math.round(t.ratio * 1e4) / 1e4,
        width: (job.result?.sizes as any)?.[t.name]?.[0] ?? null,
        height: (job.result?.sizes as any)?.[t.name]?.[1] ?? null,
        url: pubUrl,
        mechanism: "vlm_guided_crop",
      })
    }
    if (!outputs.length) return fail("no_output", `全部画幅产出失败：${errors.join("; ")}`, { title: "无产出" })

    return ok(
      {
        title: `多画幅重排：${outputs.length} 个画幅`,
        source: { url, width: w, height: h },
        vlm_status: box.ok ? "ok" : `unavailable: ${box.reason}（退化置中裁切）`,
        used_bbox: (job.result as any)?.used_bbox ?? false,
        outputs,
        errors,
        note: "mechanism=vlm_guided_crop：以 VLM 主体框为锚裁切保像素，非整图拉伸；补边仅在主体超出裁切窗时触发。",
      },
      { outputs: outputs.map((o) => o.url) },
    )
  },
})
