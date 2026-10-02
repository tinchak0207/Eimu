import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, subjectBox, blobPath } from "../lib/img-composite"

// 多畫幅重排（2026-08-31 片3）：主視覺 → 橫/豎/方多畫幅切圖。
// 誠實機制 = VLM 引導重排（vlm_guided_crop）：VLM 框主體 → PIL 以主體為錨裁切（保像素、
// 不拉伸變形），僅當裁切窗無法容納主體時才補邊。宣稱「重排非縮放」= 主體置中保像素。

const DEFAULT_TARGETS = [
  { name: "landscape", ratio: 16 / 9 },
  { name: "portrait", ratio: 9 / 16 },
  { name: "square", ratio: 1 },
]

function parseTargets(raw?: string): { ok: true; value: { name: string; ratio: number }[] } | { ok: false; hint: string } {
  if (!raw) return { ok: true, value: DEFAULT_TARGETS }
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j) || !j.length) return { ok: false, hint: "targets 必須是非空 JSON 陣列" }
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
    "多畫幅重排（零生圖扣費）：image_url 填主視覺 URL，可選 targets（JSON 陣列 [{name,ratio}]，默認橫16:9/豎9:16/方1:1）。機制=VLM 框主體邊界框 → PIL 以主體為錨裁切到各目標畫幅（保像素、不拉伸；主體超出裁切窗時才補模糊邊）。每張輸出標 mechanism=vlm_guided_crop，落公網 URL。誠實：這是裁切/補邊重排，非 AI 重繪擴圖，也非整圖拉伸；VLM 不可達時退化為置中裁切並如實標 vlm_status。",
  args: {
    image_url: tool.schema.string().describe("主視覺圖片 URL"),
    targets: tool.schema.string().optional().describe('目標畫幅 JSON 陣列字串，例 [{"name":"landscape","ratio":1.7778},{"name":"square","ratio":1}]'),
    max_side: tool.schema.number().int().min(256).max(4096).optional().describe("輸出長邊上限像素，默認 1600"),
  },
  async execute(args, context) {
    const url = args.image_url.trim()
    if (!/^https?:\/\//.test(url)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const tg = parseTargets(args.targets)
    if (!tg.ok) return fail("invalid_targets", tg.hint, { title: "輸入非法" })
    const targets = tg.value

    let buf: Buffer
    try {
      buf = await downloadImage(url, context.abort)
    } catch (e: any) {
      return fail("download_failed", `下載主視覺失敗：${e?.message ?? e}`, { title: "下載失敗" })
    }

    const probe = await runPIL({
      inputs: { img: buf },
      code: `im=load('img').convert('RGB'); emit(width=im.width, height=im.height)`,
      signal: context.abort,
    })
    if (!probe.ok || !probe.result) return fail("decode_failed", `圖片解析失敗：${probe.stderr}`, { title: "解析失敗" })
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
    if (!job.ok) return fail("reflow_failed", `重排執行失敗：${job.stderr}`, { title: "重排失敗" })

    const outputs: Record<string, unknown>[] = []
    const errors: string[] = []
    for (const t of targets) {
      const b = job.files?.[t.name]
      if (!b) {
        errors.push(`${t.name}：無輸出檔`)
        continue
      }
      let pubUrl: string
      try {
        pubUrl = await uploadBlob(blobPath(`reflow-${t.name}`), b, "image/png", context.abort)
      } catch (e: any) {
        errors.push(`${t.name}：上傳失敗 ${e?.message ?? e}`)
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
    if (!outputs.length) return fail("no_output", `全部畫幅產出失敗：${errors.join("; ")}`, { title: "無產出" })

    return ok(
      {
        title: `多畫幅重排：${outputs.length} 個畫幅`,
        source: { url, width: w, height: h },
        vlm_status: box.ok ? "ok" : `unavailable: ${box.reason}（退化置中裁切）`,
        used_bbox: (job.result as any)?.used_bbox ?? false,
        outputs,
        errors,
        note: "mechanism=vlm_guided_crop：以 VLM 主體框為錨裁切保像素，非整圖拉伸；補邊僅在主體超出裁切窗時觸發。",
      },
      { outputs: outputs.map((o) => o.url) },
    )
  },
})
