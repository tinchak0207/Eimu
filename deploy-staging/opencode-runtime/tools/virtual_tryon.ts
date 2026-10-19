import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { ORCH_DEFAULT_MODEL, SEED_NOTE, runEdit, vlmAskJson } from "../lib/img-orchestrate"
import { normHex, parseUrlArray } from "../lib/batch5-matting"

// 虚构试穿（2026-08-31 片6）：模特图 + 服装（参考图 URL 或直接给 DNA 后缀）→
// 站点编辑链 /v1/images/edits（同 image_edit.ts / 片2 runEdit 计费链），
// 构造中文编辑指令 + garment DNA 文字锚定 → 产物 VLM 一致性抽检（服装色/版型 pass/warn）。
// 诚实机制（spec 红线）：instruction-based edit，非 CatVTON/IDM-VTON 专用试穿模型，
// 不宣称零形变；warn 时如实回报。
// DNA 抽取段复用 garment_dna_lock.ts（片5）源码（GARMENT_DNA_Q + 后缀合成逐行等价），白名单栏位改试穿注入。

const GARMENT_DNA_Q =
  "这是服装单品图（可能多张，代表同一件服装的不同角度）。提炼服装 DNA 供 AI 生图/试穿复用，输出 JSON：" +
  '{"silhouette":"版型/轮廓（如 A字裙/修身/oversize/高腰）",' +
  '"fit":"合身度与剪裁线索",' +
  '"material":"材质/面料（如 亚麻/牛仔/针织/雪纺）",' +
  '"colors":["主色 HEX","#辅色 HEX",... 3-6 个],' +
  '"craft":"工艺线索（缝线/拉链/钮扣/口袋/印花/刺绣/水洗等）",' +
  '"details":"其他辨识细节",' +
  '"english_suffix":"一段简短英文，精确描述该服装版型材质色彩工艺，可直接追加到生图/试穿 prompt 末尾"}'

const TRYON_CHECK_Q =
  "图1 是服装参考图，图2 是 AI 虚构试穿结果。对比图2 模特身上穿的服装与图1 的服装：" +
  "颜色、版型轮廓、材质与关键工艺细节是否一致？输出 JSON：" +
  '{"consistency":"pass|warn","color":"色彩一致性简评","silhouette":"版型一致性简评","notes":"简短理由"}。' +
  "pass=色彩版型基本一致；warn=任何可见色偏、版型走样、细节丢失或结构改动。只输出 JSON。"

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
    "虚构试穿（AI try-on）：model_image_url（模特图公网 URL，编辑基准）+ 服装输入二选一（garment_image_urls 参考图 JSON 阵列，或直接 garment_dna 后缀文字，如 garment_dna_lock 的 prompt_suffix）→ 主路径=站点编辑链 /v1/images/edits（同 image_edit 计费链），构造中文编辑指令「让模特穿上这件服装，保持脸型体态不变」+ garment DNA 文字锚定注入。产物自动 VLM（gemini-2.5-flash-image）一致性抽检 1 次（服装色/版型 pass/warn 证据）。诚实：机制=instruction-based edit（指令式编辑 + 文字级服装 DNA），非 CatVTON/IDM-VTON 专用试穿模型，不宣称零形变；verdict=warn 建议重试或简化姿势。metadata.consistency_mechanism 如实记录实际路径。dry_run=true 只返回编辑请求构造，不提交、不扣费。",
  args: {
    model_image_url: tool.schema.string().describe("模特图公网 URL（编辑基准）"),
    garment_image_urls: tool.schema.string().optional().describe('服装参考图 URL JSON 阵列字串，例 ["https://..."]（1-4 张；无 garment_dna 时用它 VLM 抽 DNA）'),
    garment_dna: tool.schema.string().optional().describe("可选：现成服装 DNA 后缀（garment_dna_lock 的 prompt_suffix），给了就跳过 VLM 抽取"),
    pose_note: tool.schema.string().optional().describe("可选：姿势/构图补充说明（追加到编辑指令）"),
    model: tool.schema.string().optional().describe(`编辑模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等级 1k/2k（编辑链契约），默认 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求构造，不提交生图"),
  },
  async execute(args, context) {
    const modelUrl = args.model_image_url.trim()
    if (!/^https?:\/\//.test(modelUrl)) return fail("invalid_model_url", "model_image_url 必须是 http(s) URL", { title: "输入非法" })
    const gp = parseUrlArray(args.garment_image_urls, { min: 1, max: 4 })
    const dnaInput = args.garment_dna?.trim() || ""
    if (!gp.ok && !dnaInput) {
      return fail("missing_garment", "服装输入缺失：garment_image_urls（合法 JSON 阵列）或 garment_dna 至少给一个", { title: "输入缺失" })
    }
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const pose = args.pose_note?.trim() ? ` 姿势/构图补充：${args.pose_note.trim()}。` : ""

    // 服装 DNA：优先采用传入后缀；否则 VLM 从参考图抽取（复用 garment_dna_lock 同段逻辑）
    let dnaSuffix = dnaInput
    let dnaSource: "provided" | "vlm_extracted" | "none" = dnaInput ? "provided" : "none"
    if (!dnaSuffix && gp.ok) {
      const v = await vlmAskJson(gp.urls, GARMENT_DNA_Q, 1400)
      if (!v.ok) return fail("vlm_unavailable", `VLM 抽服装 DNA 失败：${v.reason}（未编造 DNA、未扣费）`, { title: "服装 DNA 抽取失败" })
      const built = buildDnaSuffix(v.data as Record<string, unknown>)
      if (!built.suffix) return fail("empty_dna", "VLM 回覆未含任何服装 DNA 栏位", { title: "服装 DNA 抽取失败" })
      dnaSuffix = built.suffix
      dnaSource = "vlm_extracted"
    }

    const prompt =
      `让图中模特穿上这件服装：${dnaSuffix || "（无服装描述，依图中服装参考自然穿著）"}。` +
      `要求：服装的版型、材质、颜色与工艺细节必须与上述描述完全一致，穿著合身自然、无悬空无穿透；` +
      `严禁改变模特的脸型、发型、肤色、体态与背景。${pose}`
    const mechanismPlan =
      "instruction-based edit：站点 /v1/images/edits 编辑链（同 image_edit.ts 计费链，reserve/commit 在站点端），" +
      "模特图作编辑基准，服装以中文编辑指令 + garment DNA 文字锚定注入；" +
      "非 CatVTON/IDM-VTON 专用试穿模型，不宣称零形变。"

    if (args.dry_run) {
      return ok({
        title: "virtual_tryon dry_run",
        dry_run: true,
        requests: [{ tag: "tryon", endpoint: "/v1/images/edits", image_url: modelUrl, prompt, model, size }],
        expected_images: 1,
        garment_dna_source: dnaSource,
        garment_dna_suffix: dnaSuffix || null,
        consistency_mechanism: mechanismPlan,
        note: "dry_run：未提交、未扣费。实际执行后会自动 VLM 抽检 1 次服装一致性（pass/warn）。",
      })
    }

    const edit = await runEdit(modelUrl, prompt, model, size, context.sessionID, context.abort)
    if (!edit.ok) return fail(edit.code, `试穿编辑链失败：${edit.hint}`, { title: "虚构试穿失败" })

    const mechanism = `${mechanismPlan}（image_mode=${edit.image_mode}${edit.image_mode === "raw_url" ? "，/v1/uploads 桥不可用故原 URL 直传" : ""}；DNA 来源=${dnaSource}）`

    // VLM 一致性抽检：有参考图才可比对；只有文字 DNA 时诚实标 no_reference
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
      check = { verdict: "no_reference", notes: "仅文字 DNA 锚定、无服装参考图，未做视觉比对（不编造 verdict）" }
    }

    return ok(
      {
        title: `虚构试穿完成（VLM 一致性抽检：${check.verdict}）`,
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
        note: "诚实：instruction-based edit（指令式编辑+文字级服装 DNA），非专用 try-on 模型，不宣称零形变。verdict=warn 时建议重试、简化 pose_note 或改用 garment_extract 透明底参考图。",
      },
      { url: edit.url, consistency_mechanism: mechanism, vlm_check: check, cost_coins: edit.cost_coins },
    )
  },
})
