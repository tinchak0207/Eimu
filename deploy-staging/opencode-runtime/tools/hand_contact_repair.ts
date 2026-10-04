import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { ORCH_DEFAULT_MODEL, SEED_NOTE, runEdit, vlmAskJson } from "../lib/img-orchestrate"

// 手部接触修复（2026-08-31 片6）：试穿/人像图 → VLM 定位手部问题（描述+千分 bbox 证据）→
// 构造局部修复中文编辑指令 → 站点编辑链 /v1/images/edits（同片2 runEdit 计费链）→ VLM 前后复验。
// 诚实：无问题时回 no_repair_needed 不硬改、不扣费；修复=指令式局部编辑，非手部专用修复模型。

const HAND_INSPECT_Q =
  "仔细检查这张图（多为试穿/人像图）中所有手部与手指：" +
  "手指数量是否正确（每手五指）、形态与关节是否自然、与衣物/配件/身体的接触关系是否合理（有无穿透、悬空、粘连、畸形）。" +
  "输出 JSON：{\"hands_ok\":true|false," +
  '"issues":[{"location":"哪只手/位置（如左手、右手握包处）","description":"具体问题","bbox_permille":[x1,y1,x2,y2]}],' +
  '"summary":"一句话总结"}。' +
  "hands_ok=true 仅当所有手部无可见畸变；bbox_permille 为千分座标 [0-1000]（x1,y1 左上、x2,y2 右下）。只输出 JSON。"

const HAND_COMPARE_Q =
  "图1 是修复前，图2 是 AI 手部修复后。只对比手部区域：修复后手指数量/形态/接触关系是否改善？" +
  "同时检查人物脸部、服装、构图与背景是否保持未被误改。输出 JSON：" +
  '{"hand_verdict":"improved|unchanged|worse","identity_kept":"pass|warn","notes":"简短理由"}。只输出 JSON。'

export default tool({
  description:
    "手部接触修复（try-on 后处理环）：image_url（试穿/人像图公网 URL）+ 可选 issue（问题描述，如「左手六指」）→ ① VLM（gemini-2.5-flash-image）定位手部问题（每问题给 location/description/bbox 千分座标证据）；② 有问题（或用户声称问题）时构造局部修复中文编辑指令走站点 /v1/images/edits（同 image_edit 计费链）；③ VLM 前后对比复验（hand_verdict improved/unchanged/worse + identity_kept）。诚实：VLM 判定手部无问题且未给 issue 时回 status=no_repair_needed，不硬改、不扣费；修复是指令式局部编辑，非手部专用修复模型，worse 时建议回退原图。dry_run=true 只返回审计+修复请求构造，不提交生图。",
  args: {
    image_url: tool.schema.string().describe("待审计/修复的图公网 URL（通常为 virtual_tryon 产物）"),
    issue: tool.schema.string().optional().describe("可选：用户声称的手部问题描述（给了则即使 VLM 判 ok 也执行修复）"),
    model: tool.schema.string().optional().describe(`编辑模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等级 1k/2k（编辑链契约），默认 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只做 VLM 审计构造展示，不提交编辑生图"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url.trim()
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const userIssue = args.issue?.trim() || ""

    // ① VLM 手部审计（免费，零生图扣费）
    const inspect = await vlmAskJson([imageUrl], HAND_INSPECT_Q, 1500)
    if (!inspect.ok) return fail("vlm_unavailable", `VLM 手部审计失败：${inspect.reason}（未编造判定、未扣费）`, { title: "手部审计失败" })
    const d = inspect.data as Record<string, unknown>
    const handsOk = d.hands_ok === true
    const rawIssues = Array.isArray(d.issues) ? (d.issues as Record<string, unknown>[]) : []
    const issues = rawIssues
      .filter((i) => i && typeof i === "object")
      .map((i) => ({
        location: typeof i.location === "string" ? i.location : "",
        description: typeof i.description === "string" ? i.description : "",
        bbox_permille: Array.isArray(i.bbox_permille) ? i.bbox_permille : null,
      }))
      .filter((i) => i.description || i.location)
    const summary = typeof d.summary === "string" ? d.summary : ""
    const needRepair = !handsOk || issues.length > 0 || !!userIssue

    const repairPrompt =
      `修复图中手部：${issues.map((i) => `${i.location || "手部"}${i.description ? "：" + i.description : ""}`).join("；") || userIssue || "手部畸变"}。` +
      `要求：每只手五指、关节与比例自然，与衣物/配件/身体的接触关系合理，无穿透无悬空无粘连；` +
      `严禁改变模特的脸型、体态、服装、构图与背景（只修手部区域）。`

    if (args.dry_run) {
      return ok({
        title: `hand_contact_repair dry_run（VLM 判定：${handsOk ? "hands_ok" : "needs_repair"}）`,
        dry_run: true,
        audit: { hands_ok: handsOk, issues, summary },
        need_repair: needRepair,
        requests: needRepair ? [{ tag: "hand-repair", endpoint: "/v1/images/edits", image_url: imageUrl, prompt: repairPrompt, model, size }] : [],
        expected_images: needRepair ? 1 : 0,
        mechanism: "VLM 定位 + instruction-based edit（站点 /v1/images/edits，同 image_edit 计费链）；非手部专用修复模型。",
        note: "dry_run：未提交编辑、未扣费。",
      })
    }

    // 无问题 → 诚实 no_repair_needed，不硬改、零扣费
    if (!needRepair) {
      return ok(
        {
          title: "手部审计通过：无需修复",
          status: "no_repair_needed",
          url: imageUrl,
          audit: { hands_ok: true, issues: [], summary: summary || "VLM 未见手部畸变" },
          cost_coins: 0,
          mechanism: "仅 VLM 审计（零生图扣费）；判定手部无问题，未执行编辑。",
          note: "诚实：VLM 目测 hands_ok 且用户未声称问题，不硬改。若你仍看到问题，带 issue 参数重调可强制修复。",
        },
        { status: "no_repair_needed", cost_coins: 0 },
      )
    }

    // ② 局部修复编辑（站点计费链）
    const edit = await runEdit(imageUrl, repairPrompt, model, size, context.sessionID, context.abort)
    if (!edit.ok) return fail(edit.code, `手部修复编辑链失败：${edit.hint}`, { title: "手部修复失败" })

    // ③ VLM 前后复验
    const cmp = await vlmAskJson([imageUrl, edit.url], HAND_COMPARE_Q, 1500)
    const after = cmp.ok
      ? {
          hand_verdict: String((cmp.data as Record<string, unknown>).hand_verdict ?? "unknown"),
          identity_kept: String((cmp.data as Record<string, unknown>).identity_kept ?? "unknown"),
          notes: String((cmp.data as Record<string, unknown>).notes ?? ""),
        }
      : { hand_verdict: "unavailable", identity_kept: "unavailable", notes: cmp.reason }

    return ok(
      {
        title: `手部修复完成（复验：${after.hand_verdict}）`,
        status: "repaired",
        url: edit.url,
        before_url: imageUrl,
        task_id: edit.task_id,
        cost_coins: edit.cost_coins,
        repair_prompt: repairPrompt,
        audit_before: { hands_ok: handsOk, issues, summary, user_issue: userIssue || null },
        audit_after: after,
        seed: null,
        consistency_mechanism:
          `VLM 定位 + instruction-based edit：站点 /v1/images/edits 局部修复（image_mode=${edit.image_mode}，计费同 image_edit，reserve/commit 在站点端）；非手部专用修复模型。`,
        seed_policy: SEED_NOTE,
        note: "诚实：before/after 证据均为 VLM 目测；hand_verdict=worse 时建议回退原图（before_url）并重试或简化 issue 描述。",
      },
      { url: edit.url, hand_verdict: after.hand_verdict, cost_coins: edit.cost_coins },
    )
  },
})
