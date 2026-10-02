import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, platformFetch, classifyError } from "../lib/client"

// 首尾帧视频链（2026-08-31 片4）：關鍵幀清單 → 逐鏡提交視頻 job（站點計費鏈）→ 輪詢 → 按鏡 mp4。
// 【契約實證】站點 B 端 /v1/videos/generations 的 VideoRequestBody 只收
// {model, prompt, n, size, duration_seconds, generate_audio, response_format, callback_url}，
// 無 first_frame/last_frame/reference 欄位（站點與控制面兩層 route 皆如此，已逐行核對）。
// 上游 newapi/metaso adapter 雖支持 workflow.references 首尾幀，但只有 web /api/generation-jobs
// （multipart + 用戶 session 鑰匙）會填充，B 端 sk-biz 計費鏈路徑拿不到。
// 故本工具嚴守「不繞過計費鏈」：提交走 /v1/videos/generations，首尾幀如實降級為文生視頻，
// 並在每個鏡標注 frames_passed:false + 降級原因，絕不假稱幀已透傳。

interface Shot {
  first_frame_url?: string
  last_frame_url?: string
  prompt: string
  duration_seconds?: number
  model?: string
  size?: string
}

function parseShots(raw: string): { shots: Shot[]; error?: string } {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { shots: [], error: "shots 必須是 JSON 陣列字串" }
  }
  const arr = Array.isArray(j) ? j : [j]
  const shots: Shot[] = []
  for (const item of arr) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : typeof o.description === "string" ? o.description.trim() : ""
    const first = typeof o.first_frame_url === "string" ? o.first_frame_url.trim() : undefined
    const last = typeof o.last_frame_url === "string" ? o.last_frame_url.trim() : undefined
    if (!prompt && !first && !last) continue
    shots.push({
      prompt: prompt || "（無文字提示，僅幀參考——但 B 端不支持幀，將如實標注）",
      first_frame_url: first || undefined,
      last_frame_url: last || undefined,
      duration_seconds: typeof o.duration_seconds === "number" ? o.duration_seconds : undefined,
      model: typeof o.model === "string" ? o.model.trim() : undefined,
      size: typeof o.size === "string" ? o.size.trim() : undefined,
    })
  }
  if (!shots.length) return { shots: [], error: "未解析到任何含 prompt/幀 URL 的鏡" }
  return { shots }
}

/** 構造單鏡提交體（站點 B 端實際契約字段；幀字段不放入——放了會被丟棄，寧可不放並如實說明）。 */
function buildBody(shot: Shot, defModel: string, defSize: string, defDur: number): Record<string, unknown> {
  return {
    model: shot.model || defModel,
    prompt: shot.prompt,
    n: 1,
    size: shot.size || defSize,
    duration_seconds: shot.duration_seconds ?? defDur,
    response_format: "url",
  }
}

async function pollJob(
  id: string,
  sessionID: string,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<{ status: string; costCoins: number | null; videoUrl: string | null; error?: string }> {
  const start = Date.now()
  let lastStatus = "queued"
  while (Date.now() - start < deadlineMs) {
    const res = await platformFetch(`/videos/${encodeURIComponent(id)}`, { method: "GET" }, sessionID, signal)
    const data = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) {
      const err = await classifyError(res, data)
      return { status: "failed", costCoins: null, videoUrl: null, error: `${err.code}: ${err.hint}` }
    }
    lastStatus = String(data.status ?? "unknown")
    if (lastStatus === "succeeded") {
      const url = data?.data?.[0]?.url ?? data?.data?.[0]?.videoUrl ?? null
      let cost = typeof data.cost_coins === "number" ? data.cost_coins : null
      // 計費 commit 行可能在 succeeded 響應後才落庫（實測競態）：cost 缺失時延遲重讀一次，
      // 仍取不到才誠實回 null（不編造金額）。
      if (cost === null) {
        await new Promise((r) => setTimeout(r, 3000))
        const res2 = await platformFetch(`/videos/${encodeURIComponent(id)}`, { method: "GET" }, sessionID, signal)
        const d2 = (await res2.json().catch(() => ({}))) as Record<string, any>
        if (typeof d2.cost_coins === "number") cost = d2.cost_coins
      }
      return { status: "succeeded", costCoins: cost, videoUrl: url }
    }
    if (lastStatus === "failed" || lastStatus === "cancelled" || lastStatus === "refunded") {
      const em = data?.error?.message || data?.error?.code || lastStatus
      return { status: lastStatus, costCoins: null, videoUrl: null, error: String(em) }
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
  return { status: lastStatus, costCoins: null, videoUrl: null, error: `輪詢超時（${Math.round(deadlineMs / 1000)}s），job 可能仍在跑，用 GET /v1/videos/${id} 續查` }
}

export default tool({
  description:
    "首尾帧视频链：输入关键帧清单（JSON 数组 [{first_frame_url?, last_frame_url?, prompt, duration_seconds?, model?, size?}]），逐镜经站点计费链 /v1/videos/generations 提交视频 job，轮询至完成，返回按镜排序的 mp4 URL + 耗时 + 实际 cost_coins。\n\n【诚实·帧契约】站点 B 端 /v1/videos/generations 实测只收 {model,prompt,n,size,duration_seconds,generate_audio,response_format,callback_url}，无 first_frame/last_frame/reference 字段（站点+控制面两层 route 逐行核对）。上游虽支持首尾帧，但仅 web 端 multipart+用户 session 路径可填，B 端 sk-biz 计费链拿不到。故本工具严守『不绕过计费链』：首尾帧如实降级为文生视频，每镜标注 frames_passed:false 与降级原因，绝不假称帧已透传。要真正首尾帧需走 web 路径（非本工具）。\n\n【预算纪律】必带 dry_run（构造提交体不发射，零扣费）；真发射前用目录 coins_per_second×时长做保守估价，超 budget_max_coins（默认 50）直接拒发并回报预算冲突，不擅自超支。submit_only 模式提交后立即返回 job ids 不等完成（长任务不阻塞）。同一错误重试 2 次即停，失败由站点计费链退款，不重发烧钱。",
  args: {
    shots: tool.schema.string().min(1).describe("关键帧清单 JSON 数组字串：[{first_frame_url?, last_frame_url?, prompt, duration_seconds?, model?, size?}]"),
    model: tool.schema.string().optional().describe("默认视频模型（镜未指定时用）；建议先用 video_quote 查可用模型与单价"),
    size: tool.schema.string().optional().describe("默认画幅，如 16:9 / 9:16（镜未指定时用），默认 16:9"),
    duration_seconds: tool.schema.number().int().min(4).max(15).optional().describe("默认时长秒（镜未指定时用）"),
    dry_run: tool.schema.boolean().optional().describe("true=只构造提交体与预算估算，不发射、零扣费（默认 false）"),
    submit_only: tool.schema.boolean().optional().describe("true=提交后立即返回 job ids 不等完成（长任务不阻塞工具）"),
    budget_max_coins: tool.schema.number().min(0).optional().describe("真发射预算上限（幣），默认 50；估价超限即拒发"),
    max_shots: tool.schema.number().int().min(1).max(12).optional().describe("镜数上限，默认 8，超出截断并标 truncated"),
    poll_timeout_ms: tool.schema.number().int().min(10000).max(600000).optional().describe("单镜轮询上限毫秒，默认 300000"),
  },
  async execute(args, context) {
    const { shots, error } = parseShots(args.shots)
    if (error) return fail("invalid_shots", error, { title: "关键帧清单解析失败" })

    const maxShots = args.max_shots ?? 8
    const truncated = shots.length > maxShots
    const work = shots.slice(0, maxShots)
    const defModel = (args.model || "").trim()
    const defSize = args.size || "16:9"
    const defDur = args.duration_seconds ?? 5
    const dryRun = args.dry_run === true
    const submitOnly = args.submit_only === true
    const budgetMax = args.budget_max_coins ?? 50

    if (!defModel && work.some((s) => !s.model)) {
      return fail("missing_model", "未提供默认 model 且部分镜无 model：先用 video_quote 查可用模型再提交", { title: "缺模型" })
    }

    // 目录单价（保守估价：取该模型各分辨率 coins_per_second 的最大值 × 时长）
    let rateTable: Record<string, Record<string, number>> = {}
    try {
      const mres = await platformFetch("/models", { method: "GET" }, context.sessionID, context.abort)
      const mbody = (await mres.json().catch(() => ({}))) as { data?: any[] }
      for (const m of mbody.data ?? []) {
        const cps = m?.x_coins_per_second
        if (m?.id && cps && typeof cps === "object") rateTable[m.id] = cps as Record<string, number>
      }
    } catch {
      /* 取不到目录：估价回退保守 10 幣/秒 */
    }
    const estimateShot = (body: Record<string, unknown>): number => {
      const mid = String(body.model)
      const dur = Number(body.duration_seconds) || defDur
      const cps = rateTable[mid]
      if (cps) {
        const rates = Object.values(cps).filter((v): v is number => typeof v === "number")
        if (rates.length) return Math.max(...rates) * dur
      }
      return 10 * dur // 保守兜底
    }

    const bodies = work.map((s) => buildBody(s, defModel, defSize, defDur))
    const estimates = bodies.map(estimateShot)
    const totalEstimate = estimates.reduce((a, b) => a + b, 0)

    const frameFinding = {
      endpoint: "/v1/videos/generations",
      first_frame_supported: false,
      last_frame_supported: false,
      reason:
        "站点 B 端 VideoRequestBody 无 first_frame/last_frame/reference 字段（站点+控制面两层 route 逐行核对）；上游首尾帧仅 web /api/generation-jobs（multipart+用户 session）可填，B 端计费链路径拿不到。",
      degradation: "text_to_video（仅 prompt 提交，帧 URL 不透传，如实在每镜标注 frames_passed:false）",
    }

    // ── dry_run：构造提交体 + 预算估算，零扣费，不发射 ──
    if (dryRun) {
      return ok(
        {
          title: `视频链 dry_run：${work.length} 镜（未发射，零扣费）`,
          dry_run: true,
          frame_contract: frameFinding,
          shots: bodies.map((b, i) => ({
            index: i,
            submit_body: b,
            input_first_frame_url: work[i].first_frame_url ?? null,
            input_last_frame_url: work[i].last_frame_url ?? null,
            frames_passed: false,
            est_coins: Math.round(estimates[i] * 1e4) / 1e4,
          })),
          total_est_coins: Math.round(totalEstimate * 1e4) / 1e4,
          budget_max_coins: budgetMax,
          within_budget: totalEstimate <= budgetMax,
          truncated,
          note: "dry_run 未提交任何 job、零扣费。真发射请设 dry_run=false（并确认 within_budget）。帧字段不会进入提交体——站点 B 端不支持。",
        },
        { dry_run: true, shots: work.length, total_est_coins: totalEstimate },
      )
    }

    // ── 预算闸：估价超限即拒发，不擅自超支 ──
    if (totalEstimate > budgetMax) {
      return fail(
        "budget_exceeded",
        `估价 ${Math.round(totalEstimate * 1e4) / 1e4} 幣 > 预算上限 ${budgetMax} 幣（模型档可能偏贵或镜数过多）。请先 dry_run 核对、换更便宜模型/减镜数/缩短时长，或明确调高 budget_max_coins。未提交任何 job、零扣费。`,
        { title: "预算冲突", total_est_coins: totalEstimate, budget_max_coins: budgetMax, frame_contract: frameFinding },
      )
    }

    // ── 真发射：逐镜提交（计费链），可选 submit_only ──
    const results: Record<string, unknown>[] = []
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]
      const t0 = Date.now()
      let submitRes: Response
      try {
        submitRes = await platformFetch("/videos/generations", { method: "POST", body: JSON.stringify(body) }, context.sessionID, context.abort)
      } catch (e: any) {
        results.push({ index: i, status: "submit_error", error: e?.message ?? String(e), frames_passed: false, elapsed_ms: Date.now() - t0 })
        continue
      }
      const sdata = (await submitRes.json().catch(() => ({}))) as Record<string, any>
      if (!submitRes.ok) {
        const err = await classifyError(submitRes, sdata)
        results.push({ index: i, status: "submit_failed", error: `${err.code}: ${err.hint}`, frames_passed: false, elapsed_ms: Date.now() - t0 })
        // 402/配额类错误立即停，不重发烧钱
        if (err.code === "insufficient_quota") break
        continue
      }
      const jobId = String(sdata.task_id ?? sdata.id ?? "")
      const base = {
        index: i,
        job_id: jobId,
        submit_body: body,
        input_first_frame_url: work[i].first_frame_url ?? null,
        input_last_frame_url: work[i].last_frame_url ?? null,
        frames_passed: false,
        frame_note: "站点 B 端不支持首尾帧，已降级文生视频",
      }
      if (submitOnly) {
        results.push({ ...base, status: "submitted", poll_url: `/v1/videos/${jobId}`, elapsed_ms: Date.now() - t0 })
        continue
      }
      const poll = await pollJob(jobId, context.sessionID, context.abort, args.poll_timeout_ms ?? 300_000)
      results.push({
        ...base,
        status: poll.status,
        mp4_url: poll.videoUrl,
        cost_coins: poll.costCoins,
        error: poll.error ?? null,
        elapsed_ms: Date.now() - t0,
      })
      // 同一错误 2 次即停纪律：job 失败不重发（退款由计费链负责）
    }

    const succeeded = results.filter((r) => r.status === "succeeded").length
    const totalCost = results.reduce((a, r) => a + (typeof r.cost_coins === "number" ? (r.cost_coins as number) : 0), 0)
    return ok(
      {
        title: `视频链：${results.length} 镜（成功 ${succeeded}${submitOnly ? "，submit_only 未轮询" : ""}）`,
        submit_only: submitOnly,
        frame_contract: frameFinding,
        shots: results,
        succeeded,
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        truncated,
        note: submitOnly
          ? "submit_only：job 已提交计费链，未轮询完成。用 GET /v1/videos/{job_id} 续查，完成后 result_url 取 mp4。"
          : "逐镜经站点计费链提交+轮询；mp4_url 为成功镜产物；cost_coins 从站点 job 记录读实际值。frames_passed 恒 false（B 端帧契约不支持，已降级文生视频）。",
      },
      { shots: results.length, succeeded, submit_only: submitOnly },
    )
  },
})
