import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { ORCH_DEFAULT_MODEL, SEED_NOTE, runEdit, vlmAskJson } from "../lib/img-orchestrate"
import { normHex, parseUrlArray } from "../lib/batch5-matting"

// 虛構試穿（2026-08-31 片6）：模特圖 + 服裝（參考圖 URL 或直接給 DNA 後綴）→
// 站點編輯鏈 /v1/images/edits（同 image_edit.ts / 片2 runEdit 計費鏈），
// 構造中文編輯指令 + garment DNA 文字錨定 → 產物 VLM 一致性抽檢（服裝色/版型 pass/warn）。
// 誠實機制（spec 紅線）：instruction-based edit，非 CatVTON/IDM-VTON 專用試穿模型，
// 不宣稱零形變；warn 時如實回報。
// DNA 抽取段復用 garment_dna_lock.ts（片5）源碼（GARMENT_DNA_Q + 後綴合成逐行等價），白名單欄位改試穿注入。

const GARMENT_DNA_Q =
  "這是服裝單品圖（可能多張，代表同一件服裝的不同角度）。提煉服裝 DNA 供 AI 生圖/試穿複用，輸出 JSON：" +
  '{"silhouette":"版型/輪廓（如 A字裙/修身/oversize/高腰）",' +
  '"fit":"合身度與剪裁線索",' +
  '"material":"材質/面料（如 亞麻/牛仔/針織/雪紡）",' +
  '"colors":["主色 HEX","#輔色 HEX",... 3-6 個],' +
  '"craft":"工藝線索（縫線/拉鏈/鈕扣/口袋/印花/刺繡/水洗等）",' +
  '"details":"其他辨識細節",' +
  '"english_suffix":"一段簡短英文，精確描述該服裝版型材質色彩工藝，可直接追加到生圖/試穿 prompt 末尾"}'

const TRYON_CHECK_Q =
  "圖1 是服裝參考圖，圖2 是 AI 虛構試穿結果。對比圖2 模特身上穿的服裝與圖1 的服裝：" +
  "顏色、版型輪廓、材質與關鍵工藝細節是否一致？輸出 JSON：" +
  '{"consistency":"pass|warn","color":"色彩一致性簡評","silhouette":"版型一致性簡評","notes":"簡短理由"}。' +
  "pass=色彩版型基本一致；warn=任何可見色偏、版型走樣、細節丟失或結構改動。只輸出 JSON。"

function buildDnaSuffix(d: Record<string, unknown>): { suffix: string; dna: Record<string, unknown> } {
  const silhouette = typeof d.silhouette === "string" ? d.silhouette.trim() : ""
  const fit = typeof d.fit === "string" ? d.fit.trim() : ""
  const material = typeof d.material === "string" ? d.material.trim() : ""
  const craft = typeof d.craft === "string" ? d.craft.trim() : ""
  const details = typeof d.details === "string" ? d.details.trim() : ""
  const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
  const colors = Array.isArray(d.colors) ? (d.colors.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
  const parts: string[] = []
  if (enSuffix) parts.push(enSuffix)
  if (silhouette) parts.push(`silhouette: ${silhouette}`)
  if (material) parts.push(`material: ${material}`)
  if (colors.length) parts.push(`colors: ${colors.join(", ")}`)
  if (craft) parts.push(`craft: ${craft}`)
  const suffix = parts.join("; ")
  const dna = { silhouette, fit: fit || null, material, colors, craft: craft || null, details: details || null, english_suffix: enSuffix || null }
  return { suffix, dna }
}

export default tool({
  description:
    "虛構試穿（AI try-on）：model_image_url（模特圖公網 URL，編輯基準）+ 服裝輸入二選一（garment_image_urls 參考圖 JSON 陣列，或直接 garment_dna 後綴文字，如 garment_dna_lock 的 prompt_suffix）→ 主路徑=站點編輯鏈 /v1/images/edits（同 image_edit 計費鏈），構造中文編輯指令「讓模特穿上這件服裝，保持臉型體態不變」+ garment DNA 文字錨定注入。產物自動 VLM（gemini-2.5-flash-image）一致性抽檢 1 次（服裝色/版型 pass/warn 證據）。誠實：機制=instruction-based edit（指令式編輯 + 文字級服裝 DNA），非 CatVTON/IDM-VTON 專用試穿模型，不宣稱零形變；verdict=warn 建議重試或簡化姿勢。metadata.consistency_mechanism 如實記錄實際路徑。dry_run=true 只返回編輯請求構造，不提交、不扣費。",
  args: {
    model_image_url: tool.schema.string().describe("模特圖公網 URL（編輯基準）"),
    garment_image_urls: tool.schema.string().optional().describe('服裝參考圖 URL JSON 陣列字串，例 ["https://..."]（1-4 張；無 garment_dna 時用它 VLM 抽 DNA）'),
    garment_dna: tool.schema.string().optional().describe("可選：現成服裝 DNA 後綴（garment_dna_lock 的 prompt_suffix），給了就跳過 VLM 抽取"),
    pose_note: tool.schema.string().optional().describe("可選：姿勢/構圖補充說明（追加到編輯指令）"),
    model: tool.schema.string().optional().describe(`編輯模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等級 1k/2k（編輯鏈契約），默認 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求構造，不提交生圖"),
  },
  async execute(args, context) {
    const modelUrl = args.model_image_url.trim()
    if (!/^https?:\/\//.test(modelUrl)) return fail("invalid_model_url", "model_image_url 必須是 http(s) URL", { title: "輸入非法" })
    const gp = parseUrlArray(args.garment_image_urls, { min: 1, max: 4 })
    const dnaInput = args.garment_dna?.trim() || ""
    if (!gp.ok && !dnaInput) {
      return fail("missing_garment", "服裝輸入缺失：garment_image_urls（合法 JSON 陣列）或 garment_dna 至少給一個", { title: "輸入缺失" })
    }
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const pose = args.pose_note?.trim() ? ` 姿勢/構圖補充：${args.pose_note.trim()}。` : ""

    // 服裝 DNA：優先採用傳入後綴；否則 VLM 從參考圖抽取（復用 garment_dna_lock 同段邏輯）
    let dnaSuffix = dnaInput
    let dnaSource: "provided" | "vlm_extracted" | "none" = dnaInput ? "provided" : "none"
    if (!dnaSuffix && gp.ok) {
      const v = await vlmAskJson(gp.urls, GARMENT_DNA_Q, 1400)
      if (!v.ok) return fail("vlm_unavailable", `VLM 抽服裝 DNA 失敗：${v.reason}（未編造 DNA、未扣費）`, { title: "服裝 DNA 抽取失敗" })
      const built = buildDnaSuffix(v.data as Record<string, unknown>)
      if (!built.suffix) return fail("empty_dna", "VLM 回覆未含任何服裝 DNA 欄位", { title: "服裝 DNA 抽取失敗" })
      dnaSuffix = built.suffix
      dnaSource = "vlm_extracted"
    }

    const prompt =
      `讓圖中模特穿上這件服裝：${dnaSuffix || "（無服裝描述，依圖中服裝參考自然穿著）"}。` +
      `要求：服裝的版型、材質、顏色與工藝細節必須與上述描述完全一致，穿著合身自然、無懸空無穿透；` +
      `嚴禁改變模特的臉型、髮型、膚色、體態與背景。${pose}`
    const mechanismPlan =
      "instruction-based edit：站點 /v1/images/edits 編輯鏈（同 image_edit.ts 計費鏈，reserve/commit 在站點端），" +
      "模特圖作編輯基準，服裝以中文編輯指令 + garment DNA 文字錨定注入；" +
      "非 CatVTON/IDM-VTON 專用試穿模型，不宣稱零形變。"

    if (args.dry_run) {
      return ok({
        title: "virtual_tryon dry_run",
        dry_run: true,
        requests: [{ tag: "tryon", endpoint: "/v1/images/edits", image_url: modelUrl, prompt, model, size }],
        expected_images: 1,
        garment_dna_source: dnaSource,
        garment_dna_suffix: dnaSuffix || null,
        consistency_mechanism: mechanismPlan,
        note: "dry_run：未提交、未扣費。實際執行後會自動 VLM 抽檢 1 次服裝一致性（pass/warn）。",
      })
    }

    const edit = await runEdit(modelUrl, prompt, model, size, context.sessionID, context.abort)
    if (!edit.ok) return fail(edit.code, `試穿編輯鏈失敗：${edit.hint}`, { title: "虛構試穿失敗" })

    const mechanism = `${mechanismPlan}（image_mode=${edit.image_mode}${edit.image_mode === "raw_url" ? "，/v1/uploads 橋不可用故原 URL 直傳" : ""}；DNA 來源=${dnaSource}）`

    // VLM 一致性抽檢：有參考圖才可比對；只有文字 DNA 時誠實標 no_reference
    let check: { verdict: string; color?: string; silhouette?: string; notes: string }
    if (gp.ok) {
      const v = await vlmAskJson([gp.urls[0], edit.url], TRYON_CHECK_Q, 1500)
      check = v.ok
        ? {
            verdict: String((v.data as Record<string, unknown>).consistency ?? "unknown"),
            color: typeof (v.data as Record<string, unknown>).color === "string" ? String((v.data as Record<string, unknown>).color) : "",
            silhouette: typeof (v.data as Record<string, unknown>).silhouette === "string" ? String((v.data as Record<string, unknown>).silhouette) : "",
            notes: String((v.data as Record<string, unknown>).notes ?? ""),
          }
        : { verdict: "unavailable", notes: v.reason }
    } else {
      check = { verdict: "no_reference", notes: "僅文字 DNA 錨定、無服裝參考圖，未做視覺比對（不編造 verdict）" }
    }

    return ok(
      {
        title: `虛構試穿完成（VLM 一致性抽檢：${check.verdict}）`,
        url: edit.url,
        before_url: modelUrl,
        task_id: edit.task_id,
        cost_coins: edit.cost_coins,
        prompt,
        garment_dna_suffix: dnaSuffix || null,
        garment_dna_source: dnaSource,
        seed: null,
        consistency_mechanism: mechanism,
        vlm_check: check,
        seed_policy: SEED_NOTE,
        note: "誠實：instruction-based edit（指令式編輯+文字級服裝 DNA），非專用 try-on 模型，不宣稱零形變。verdict=warn 時建議重試、簡化 pose_note 或改用 garment_extract 透明底參考圖。",
      },
      { url: edit.url, consistency_mechanism: mechanism, vlm_check: check, cost_coins: edit.cost_coins },
    )
  },
})
