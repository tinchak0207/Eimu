// 片5 共用 lib（2026-08-31）：VLM/摳圖類工具的基礎設施。
// 職責：rembg 摳圖（復用片3 runPIL 沙箱 + 自裝 rembg/onnxruntime）、
// 公網 blob 落檔（復用片3 uploadBlob/blobPath）、VLM 讀圖（復用片2 vlmAskJson）、
// HEX 正規化、URL 陣列解析。
// 零生圖扣費：本檔絕不觸碰 /images/generations；僅 rembg 本地推理 + VLM chat（內部通道）。
// 此檔不是 tool，不得 export tool 定義，必須放在 tools/ 之外。

import { runPIL, uploadBlob, blobPath, downloadImage } from "./img-composite"
import { vlmAskJson } from "./img-orchestrate"

export { vlmAskJson, uploadBlob, blobPath, downloadImage, runPIL }

export interface MattingStats {
  width: number
  height: number
  mode: string
  alpha_min: number
  alpha_max: number
  transparent_pct: number // alpha==0
  opaque_pct: number // alpha==255
  partial_pct: number // 0<alpha<255
  has_true_alpha: boolean // mode=RGBA 且 alpha 同時含 0 與 255
}

export interface CutoutResult {
  ok: boolean
  url?: string
  stats?: MattingStats
  source_url?: string
  elapsed_ms?: number
  code?: string
  reason?: string
}

/**
 * 摳圖核心：下載圖片 → rembg（u2net）去背 → RGBA PNG → 公網 blob 落檔。
 * 單張跑（內存緊張）；輸入先等比縮到 max_side 以約束 onnxruntime 後處理峰值。
 * 失敗一律 ok:false + 誠實 reason，不編造。
 */
export async function cutoutFromUrl(
  imageUrl: string,
  abort?: AbortSignal,
  tag = "cutout",
  maxSide = 1536,
): Promise<CutoutResult> {
  const t0 = Date.now()
  let buf: Buffer
  try {
    buf = await downloadImage(imageUrl, abort)
  } catch (e: any) {
    return { ok: false, code: "download_failed", reason: `下載原圖失敗：${e?.message ?? e}`, source_url: imageUrl }
  }
  const job = await runPIL({
    inputs: { in: buf },
    params: { max_side: maxSide },
    outputs: ["cut"],
    code: `
from rembg import remove, new_session
import numpy as np
im=load('in').convert('RGB')
ms=int(PARAMS['max_side'])
if max(im.size)>ms:
    r=ms/max(im.size); im=im.resize((max(1,int(im.width*r)),max(1,int(im.height*r))))
sess=new_session('u2net')
out=remove(im, session=sess)
out=out.convert('RGBA')
out.save(OUT['cut'],'PNG')
a=np.array(out)[:,:,3]
tot=a.size
emit(width=out.width,height=out.height,mode=out.mode,
     alpha_min=int(a.min()),alpha_max=int(a.max()),
     transparent_pct=round(float((a==0).sum())/tot*100,2),
     opaque_pct=round(float((a==255).sum())/tot*100,2),
     partial_pct=round(float(((a>0)&(a<255)).sum())/tot*100,2))
`,
    timeoutMs: 180_000,
    signal: abort,
  })
  const elapsed = Date.now() - t0
  if (!job.ok || !job.files?.cut) {
    return {
      ok: false,
      code: "matting_failed",
      reason: `rembg 摳圖失敗：${(job.stderr || "exit").slice(0, 300)}`,
      source_url: imageUrl,
      elapsed_ms: elapsed,
    }
  }
  const r = (job.result || {}) as Record<string, unknown>
  const stats: MattingStats = {
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
    mode: String(r.mode || ""),
    alpha_min: Number(r.alpha_min ?? 0),
    alpha_max: Number(r.alpha_max ?? 0),
    transparent_pct: Number(r.transparent_pct ?? 0),
    opaque_pct: Number(r.opaque_pct ?? 0),
    partial_pct: Number(r.partial_pct ?? 0),
    has_true_alpha: String(r.mode) === "RGBA" && Number(r.alpha_min) === 0 && Number(r.alpha_max) === 255,
  }
  let pubUrl: string
  try {
    pubUrl = await uploadBlob(blobPath(tag), job.files.cut, "image/png", abort)
  } catch (e: any) {
    return { ok: false, code: "upload_failed", reason: `上傳公網失敗：${e?.message ?? e}`, stats, elapsed_ms: elapsed }
  }
  return { ok: true, url: pubUrl, stats, source_url: imageUrl, elapsed_ms: elapsed }
}

/** 正規化為小寫 6 位 HEX；非法回 null。 */
export function normHex(s: unknown): string | null {
  if (typeof s !== "string") return null
  const m = s.trim().match(/#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/)
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split("").map((c) => c + c).join("")
  return "#" + h.toLowerCase()
}

/** 解析 URL JSON 陣列字串；回 {ok, urls} 或 {ok:false, code, hint}。 */
export function parseUrlArray(
  raw: string | undefined,
  opts: { min?: number; max?: number } = {},
): { ok: true; urls: string[] } | { ok: false; code: string; hint: string } {
  const min = opts.min ?? 1
  const max = opts.max ?? 12
  if (!raw || !raw.trim()) return { ok: false, code: "empty_input", hint: "輸入缺失：需要 JSON 陣列字串" }
  let urls: string[] = []
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j)) return { ok: false, code: "invalid_input", hint: "必須是 JSON 陣列字串" }
    urls = j
      .filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x.trim()))
      .map((s) => s.trim())
  } catch {
    return { ok: false, code: "invalid_input", hint: "非法 JSON 陣列字串" }
  }
  urls = [...new Set(urls)]
  if (urls.length < min) return { ok: false, code: "too_few", hint: `至少 ${min} 個合法 http(s) URL` }
  if (urls.length > max) return { ok: false, code: "too_many", hint: `單次最多 ${max} 張` }
  return { ok: true, urls }
}

/** 解析純字串陣列（賣點清單等）；回 {ok, items} 或 {ok:false,...}。 */
export function parseStringArray(
  raw: string | undefined,
  opts: { min?: number; max?: number } = {},
): { ok: true; items: string[] } | { ok: false; code: string; hint: string } {
  const min = opts.min ?? 1
  const max = opts.max ?? 30
  if (!raw || !raw.trim()) return { ok: false, code: "empty_input", hint: "輸入缺失：需要 JSON 陣列字串" }
  let items: string[] = []
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j)) return { ok: false, code: "invalid_input", hint: "必須是 JSON 陣列字串" }
    items = j.filter((x): x is string => typeof x === "string" && x.trim()).map((s) => s.trim())
  } catch {
    return { ok: false, code: "invalid_input", hint: "非法 JSON 陣列字串" }
  }
  if (items.length < min) return { ok: false, code: "too_few", hint: `至少 ${min} 項` }
  if (items.length > max) return { ok: false, code: "too_many", hint: `單次最多 ${max} 項` }
  return { ok: true, items }
}

/** 千分比 bbox [x1,y1,x2,y2] → 像素 bbox（夾邊界、規範順序）。非法回 null。 */
export function permilleBboxToPx(
  raw: unknown,
  w: number,
  h: number,
): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some((v) => typeof v !== "number")) return null
  const [a, b, c, d] = raw as number[]
  const clamp = (v: number, dim: number) => Math.max(0, Math.min(dim, Math.round(v)))
  const px = (v: number, dim: number) => clamp((v / 1000) * dim, dim)
  const x1 = px(Math.min(a, c), w)
  const x2 = px(Math.max(a, c), w)
  const y1 = px(Math.min(b, d), h)
  const y2 = px(Math.max(b, d), h)
  if (x2 - x1 < 4 || y2 - y1 < 4) return null
  return [x1, y1, x2, y2]
}
