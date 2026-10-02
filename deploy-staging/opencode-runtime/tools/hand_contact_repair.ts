import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { ORCH_DEFAULT_MODEL, SEED_NOTE, runEdit, vlmAskJson } from "../lib/img-orchestrate"

// 手部接觸修復（2026-08-31 片6）：試穿/人像圖 → VLM 定位手部問題（描述+千分 bbox 證據）→
// 構造局部修復中文編輯指令 → 站點編輯鏈 /v1/images/edits（同片2 runEdit 計費鏈）→ VLM 前後複驗。
// 誠實：無問題時回 no_repair_needed 不硬改、不扣費；修復=指令式局部編輯，非手部專用修復模型。

const HAND_INSPECT_Q =
  "仔細檢查這張圖（多為試穿/人像圖）中所有手部與手指：" +
  "手指數量是否正確（每手五指）、形態與關節是否自然、與衣物/配件/身體的接觸關係是否合理（有無穿透、懸空、粘連、畸形）。" +
  "輸出 JSON：{\"hands_ok\":true|false," +
  '"issues":[{"location":"哪隻手/位置（如左手、右手握包處）","description":"具體問題","bbox_permille":[x1,y1,x2,y2]}],' +
  '"summary":"一句話總結"}。' +
  "hands_ok=true 僅當所有手部無可見畸變；bbox_permille 為千分座標 [0-1000]（x1,y1 左上、x2,y2 右下）。只輸出 JSON。"

const HAND_COMPARE_Q =
  "圖1 是修復前，圖2 是 AI 手部修復後。只對比手部區域：修復後手指數量/形態/接觸關係是否改善？" +
  "同時檢查人物臉部、服裝、構圖與背景是否保持未被誤改。輸出 JSON：" +
  '{"hand_verdict":"improved|unchanged|worse","identity_kept":"pass|warn","notes":"簡短理由"}。只輸出 JSON。'

export default tool({
  description:
    "手部接觸修復（try-on 後處理環）：image_url（試穿/人像圖公網 URL）+ 可選 issue（問題描述，如「左手六指」）→ ① VLM（gemini-2.5-flash-image）定位手部問題（每問題給 location/description/bbox 千分座標證據）；② 有問題（或用戶聲稱問題）時構造局部修復中文編輯指令走站點 /v1/images/edits（同 image_edit 計費鏈）；③ VLM 前後對比複驗（hand_verdict improved/unchanged/worse + identity_kept）。誠實：VLM 判定手部無問題且未給 issue 時回 status=no_repair_needed，不硬改、不扣費；修復是指令式局部編輯，非手部專用修復模型，worse 時建議回退原圖。dry_run=true 只返回審計+修復請求構造，不提交生圖。",
  args: {
    image_url: tool.schema.string().describe("待審計/修復的圖公網 URL（通常為 virtual_tryon 產物）"),
    issue: tool.schema.string().optional().describe("可選：用戶聲稱的手部問題描述（給了則即使 VLM 判 ok 也執行修復）"),
    model: tool.schema.string().optional().describe(`編輯模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等級 1k/2k（編輯鏈契約），默認 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只做 VLM 審計構造展示，不提交編輯生圖"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url.trim()
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const userIssue = args.issue?.trim() || ""

    // ① VLM 手部審計（免費，零生圖扣費）
    const inspect = await vlmAskJson([imageUrl], HAND_INSPECT_Q, 1500)
    if (!inspect.ok) return fail("vlm_unavailable", `VLM 手部審計失敗：${inspect.reason}（未編造判定、未扣費）`, { title: "手部審計失敗" })
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
      `修復圖中手部：${issues.map((i) => `${i.location || "手部"}${i.description ? "：" + i.description : ""}`).join("；") || userIssue || "手部畸變"}。` +
      `要求：每隻手五指、關節與比例自然，與衣物/配件/身體的接觸關係合理，無穿透無懸空無粘連；` +
      `嚴禁改變模特的臉型、體態、服裝、構圖與背景（只修手部區域）。`

    if (args.dry_run) {
      return ok({
        title: `hand_contact_repair dry_run（VLM 判定：${handsOk ? "hands_ok" : "needs_repair"}）`,
        dry_run: true,
        audit: { hands_ok: handsOk, issues, summary },
        need_repair: needRepair,
        requests: needRepair ? [{ tag: "hand-repair", endpoint: "/v1/images/edits", image_url: imageUrl, prompt: repairPrompt, model, size }] : [],
        expected_images: needRepair ? 1 : 0,
        mechanism: "VLM 定位 + instruction-based edit（站點 /v1/images/edits，同 image_edit 計費鏈）；非手部專用修復模型。",
        note: "dry_run：未提交編輯、未扣費。",
      })
    }

    // 無問題 → 誠實 no_repair_needed，不硬改、零扣費
    if (!needRepair) {
      return ok(
        {
          title: "手部審計通過：無需修復",
          status: "no_repair_needed",
          url: imageUrl,
          audit: { hands_ok: true, issues: [], summary: summary || "VLM 未見手部畸變" },
          cost_coins: 0,
          mechanism: "僅 VLM 審計（零生圖扣費）；判定手部無問題，未執行編輯。",
          note: "誠實：VLM 目測 hands_ok 且用戶未聲稱問題，不硬改。若你仍看到問題，帶 issue 參數重調可強制修復。",
        },
        { status: "no_repair_needed", cost_coins: 0 },
      )
    }

    // ② 局部修復編輯（站點計費鏈）
    const edit = await runEdit(imageUrl, repairPrompt, model, size, context.sessionID, context.abort)
    if (!edit.ok) return fail(edit.code, `手部修復編輯鏈失敗：${edit.hint}`, { title: "手部修復失敗" })

    // ③ VLM 前後複驗
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
        title: `手部修復完成（複驗：${after.hand_verdict}）`,
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
          `VLM 定位 + instruction-based edit：站點 /v1/images/edits 局部修復（image_mode=${edit.image_mode}，計費同 image_edit，reserve/commit 在站點端）；非手部專用修復模型。`,
        seed_policy: SEED_NOTE,
        note: "誠實：before/after 證據均為 VLM 目測；hand_verdict=worse 時建議回退原圖（before_url）並重試或簡化 issue 描述。",
      },
      { url: edit.url, hand_verdict: after.hand_verdict, cost_coins: edit.cost_coins },
    )
  },
})
