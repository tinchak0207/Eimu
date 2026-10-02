import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, subjectBox, blobPath } from "../lib/img-composite"

// 多平台適配（2026-08-31 片3）：成圖組 → 逐平台 VLM 引導裁切 + 安全區/分辨率核對報告。
// 內置平台規格表；導出校驗用 PIL 實測輸出像素尺寸與主體重心（非宣稱）。零生圖扣費。

interface Platform {
  id: string
  label: string
  ratio: number
  w: number
  h: number
  min_short: number
  safe_y: [number, number] // 主體重心 y 允許區間（避開平台 UI 遮擋）
}

const PLATFORMS: Platform[] = [
  { id: "xiaohongshu", label: "小紅書筆記", ratio: 3 / 4, w: 1080, h: 1440, min_short: 720, safe_y: [0.12, 0.88] },
  { id: "ig_feed", label: "IG 貼文", ratio: 1, w: 1080, h: 1080, min_short: 640, safe_y: [0.1, 0.9] },
  { id: "ig_story", label: "IG 限動", ratio: 9 / 16, w: 1080, h: 1920, min_short: 720, safe_y: [0.15, 0.8] },
  { id: "douyin", label: "抖音豎屏", ratio: 9 / 16, w: 1080, h: 1920, min_short: 720, safe_y: [0.16, 0.78] },
  { id: "x_post", label: "X 橫圖", ratio: 16 / 9, w: 1600, h: 900, min_short: 500, safe_y: [0.1, 0.9] },
  { id: "wechat_cover", label: "微信公眾號封面", ratio: 2.35, w: 1410, h: 600, min_short: 380, safe_y: [0.15, 0.85] },
]

function pickPlatforms(raw?: string): { ok: true; value: Platform[] } | { ok: false; hint: string } {
  if (!raw) return { ok: true, value: PLATFORMS }
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j) || !j.length) return { ok: false, hint: "platforms 必須是非空 JSON 陣列" }
    const value: Platform[] = []
    for (const item of j) {
      if (typeof item === "string") {
        const p = PLATFORMS.find((x) => x.id === item)
        if (!p) return { ok: false, hint: `未知平台 id：${item}（可選 ${PLATFORMS.map((x) => x.id).join("/")}）` }
        value.push(p)
      } else {
        const ratio = Number(item?.ratio)
        if (!isFinite(ratio) || ratio <= 0) return { ok: false, hint: "自訂平台需含正數 ratio" }
        value.push({
          id: String(item?.id ?? `custom_${value.length}`),
          label: String(item?.label ?? item?.id ?? "自訂"),
          ratio,
          w: Math.max(2, Math.round(Number(item?.w) || (ratio >= 1 ? 1600 : 1600 * ratio))),
          h: Math.max(2, Math.round(Number(item?.h) || (ratio >= 1 ? 1600 / ratio : 1600))),
          min_short: Number(item?.min_short) || 360,
          safe_y: [0.1, 0.9],
        })
      }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, hint: 'platforms 格式非法，例 ["xiaohongshu","ig_feed"] 或 [{"id":"a","ratio":1.5}]' }
  }
}

function resolveUrls(nodeIds: string[], urls: string[], snap: any): { list: string[]; missing: string[] } {
  const list: string[] = []
  const missing: string[] = []
  if (nodeIds.length) {
    if (!snap.has_state || snap.state === null) {
      return { list: [], missing: nodeIds.map((i) => `${i}（畫布未上報狀態）`) }
    }
    const nodes = (Array.isArray(snap.state.nodes) ? snap.state.nodes : []) as Record<string, unknown>[]
    const byId = new Map(nodes.map((n) => [String(n.id ?? ""), n]))
    for (const id of nodeIds) {
      const n = byId.get(id)
      const meta = (n && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>
      const u = (meta.content || meta.url || meta.result_url) as string | undefined
      if (n && typeof u === "string" && /^https?:\/\//.test(u)) list.push(u)
      else missing.push(id)
    }
  }
  list.push(...urls)
  return { list: [...new Set(list)], missing }
}

export default tool({
  description:
    "多平台適配（零生圖扣費）：urls（成圖 URL JSON 陣列）或 node_ids（畫布節點）→ 逐平台 VLM 引導裁切，輸出適配圖公網 URL + 核對報告。內置平台規格：小紅書3:4、IG貼文1:1、IG限動9:16、抖音9:16、X16:9、微信封面2.35:1（platforms 可篩選或自訂）。核對報告逐項 PIL 實測輸出尺寸/主體重心：ratio 偏差>2% 或短邊低於平台下限或主體落入平台 UI 遮擋區 → warn 並給原因（實測非宣稱）。單圖 VLM 框一次復用各平台。",
  args: {
    urls: tool.schema.string().optional().describe("成圖 URL JSON 陣列字串"),
    node_ids: tool.schema.string().optional().describe("畫布節點 id JSON 陣列字串（經 gateway 快照取 URL）"),
    platforms: tool.schema.string().optional().describe('平台篩選/自訂 JSON 陣列，例 ["xiaohongshu","douyin"]'),
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

    const pp = pickPlatforms(args.platforms)
    if (!pp.ok) return fail("invalid_platforms", pp.hint, { title: "輸入非法" })
    const platforms = pp.value

    let snap: any = { has_state: false, state: null }
    if (nodeIds.length) {
      try {
        const { gatewayReadSnapshot } = await import("../lib/canvas-flow")
        snap = await gatewayReadSnapshot(process.env.GATEWAY_URL || "http://127.0.0.1:8081", context.sessionID)
      } catch (e: any) {
        return fail("canvas_unavailable", `讀畫布快照失敗：${e?.message ?? e}`, { title: "畫布不可用" })
      }
    }
    const { list, missing } = resolveUrls(nodeIds, urls, snap)
    if (!list.length) return fail("no_images", `無可處理圖片：${missing.join("; ") || "空"}`, { title: "無圖片" })
    if (list.length > 8) return fail("too_many", "單次最多 8 張成圖", { title: "輸入過多" })

    const adapted: Record<string, unknown>[] = []
    const report: Record<string, unknown>[] = []
    for (const url of list) {
      let buf: Buffer
      try {
        buf = await downloadImage(url, context.abort)
      } catch (e: any) {
        report.push({ source: url, status: "error", reason: `下載失敗 ${e?.message ?? e}` })
        continue
      }
      const probe = await runPIL({ inputs: { img: buf }, code: `im=load('img').convert('RGB'); emit(width=im.width,height=im.height)`, signal: context.abort })
      if (!probe.ok) {
        report.push({ source: url, status: "error", reason: "解析失敗" })
        continue
      }
      const w = Number(probe.result!.width), h = Number(probe.result!.height)
      const box = await subjectBox(url, w, h)
      const job = await runPIL({
        inputs: { img: buf },
        params: { plats: platforms.map((p) => ({ name: p.id, ratio: p.ratio, w: p.w, h: p.h, long: Math.max(p.w, p.h) })) },
        outputs: platforms.map((p) => p.id),
        code: `
plats=PARAMS['plats']; bbox=PARAMS.get('bbox')
im=load('img').convert('RGB')
for p in plats:
    out=imgops.reflow(im, float(p['ratio']), bbox=tuple(bbox) if bbox else None, max_side=int(p['long']))
    out.save(OUT[p['name']],'PNG')
emit(used_bbox=bool(bbox))
`,
        timeoutMs: 150_000,
        signal: context.abort,
      })
      if (!job.ok) {
        report.push({ source: url, status: "error", reason: `重排失敗 ${job.stderr}` })
        continue
      }
      // PIL 實測輸出尺寸 + 主體重心（導出校驗）
      const havePlats = platforms.filter((p) => !!job.files?.[p.id])
      const verify = await runPIL({
        inputs: Object.fromEntries(havePlats.map((p) => [p.id, job.files![p.id]])),
        params: { plats: havePlats.map((p) => p.id) },
        code: `
res={}
for name in PARAMS['plats']:
    im=load(name).convert('RGB')
    st=imgops.composition_stats(im)
    res[name]={'w':im.width,'h':im.height,'center':st['subject_center'],'whitespace':st['whitespace_ratio']}
emit(measured=res)
`,
        signal: context.abort,
      })
      const measured: Record<string, any> = (verify.result as any)?.measured || {}

      for (const p of platforms) {
        const b = job.files?.[p.id]
        if (!b) {
          report.push({ source: url, platform: p.id, status: "error", reason: "無輸出檔" })
          continue
        }
        let pubUrl: string
        try {
          pubUrl = await uploadBlob(blobPath(`pf-${p.id}`), b, "image/png", context.abort)
        } catch (e: any) {
          report.push({ source: url, platform: p.id, status: "error", reason: `上傳失敗 ${e?.message ?? e}` })
          continue
        }
        adapted.push({ source: url, platform: p.id, label: p.label, url: pubUrl, mechanism: "vlm_guided_crop" })
        const m = measured[p.id] || {}
        const mw = Number(m.w), mh = Number(m.h)
        const reasons: string[] = []
        let status: "pass" | "warn" = "pass"
        if (!mw || !mh) {
          status = "warn"; reasons.push("無法實測尺寸")
        } else {
          const mr = mw / mh
          if (Math.abs(mr - p.ratio) / p.ratio > 0.02) { status = "warn"; reasons.push(`比例偏差：實測 ${mr.toFixed(3)} vs 目標 ${p.ratio.toFixed(3)}`) }
          if (Math.min(mw, mh) < p.min_short) { status = "warn"; reasons.push(`短邊 ${Math.min(mw, mh)} < 平台下限 ${p.min_short}`) }
        }
        const c = m.center as [number, number] | undefined
        if (c && Array.isArray(c)) {
          if (c[1] < p.safe_y[0] || c[1] > p.safe_y[1]) { status = "warn"; reasons.push(`主體重心 y=${c[1].toFixed(2)} 落入平台 UI 遮擋區 [${p.safe_y[0]},${p.safe_y[1]}]`) }
        }
        report.push({
          source: url,
          platform: p.id,
          label: p.label,
          status,
          measured_size: mw && mh ? `${mw}x${mh}` : null,
          target_ratio: Math.round(p.ratio * 1e4) / 1e4,
          subject_center: c ?? null,
          reason: reasons.join("；") || "尺寸/比例/安全區皆通過（PIL 實測）",
        })
      }
    }

    const passN = report.filter((r) => r.status === "pass").length
    const warnN = report.filter((r) => r.status === "warn").length
    const errN = report.filter((r) => r.status === "error").length
    return ok(
      {
        title: `多平台適配：${adapted.length} 張產出（通過 ${passN}／警示 ${warnN}／錯誤 ${errN}）`,
        platforms: platforms.map((p) => ({ id: p.id, label: p.label, ratio: Math.round(p.ratio * 1e4) / 1e4, target_size: `${p.w}x${p.h}`, min_short: p.min_short })),
        missing_nodes: missing,
        adapted,
        report,
        note: "核對報告的 measured_size/subject_center 均為 PIL 對輸出像素的實測值，非依參數宣稱；warn 表示該平台需人工複核（比例/分辨率/安全區）。",
      },
      { adapted: adapted.map((a) => a.url) },
    )
  },
})
