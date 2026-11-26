import { compileShotPrompt, normalizeShotCamera, type ShotAudio, type ShotBeat, type ShotCamera, type ShotStateChange } from "../lib/video-prompt-schema"
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, platformFetch, classifyError, registerTask } from "../lib/client"

// 首尾帧视频链（2026-08-31 片4）：关键帧清单 → 逐镜提交视频 job（站点计费链）→ 轮询 → 按镜 mp4。
// 帧通过有序 reference_images 进入站点计费链；minimax-h3 是图片参考，不保证硬锁首尾帧。

interface Shot {
  first_frame_url?: string
  last_frame_url?: string
  prompt: string
  subject?: string
  action?: string
  beats?: ShotBeat[]
  state_change?: ShotStateChange
  environment_change?: string
  audio?: ShotAudio
  camera?: ShotCamera
  duration_seconds?: number
  model?: string
  size?: string
}

/** 散文 prompt 的正向动态契约（不用否定句）：镜头必须发生可观察的物理变化。 */
const DYNAMIC_CONTRACT = "Continuous physical action drives the shot: the subject's position, pose, and silhouette change measurably from the first frame to the last, and the environment evolves with the action."


function parseShots(raw: string): { shots: Shot[]; error?: string } {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { shots: [], error: "shots 必须是 JSON 阵列字串" }
  }
  const arr = Array.isArray(j) ? j : [j]
  const shots: Shot[] = []
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { shots: [], error: `第 ${shots.length + 1} 镜必须为对象，未提交任何镜头` }
    const o = item as Record<string, unknown>
    if (o.prompt !== undefined && typeof o.prompt !== "string") return { shots: [], error: `第 ${shots.length + 1} 镜 prompt 必须是字符串；未提交任何镜头` }
    const prompt = typeof o.prompt === "string" ? o.prompt : typeof o.description === "string" ? o.description : ""
    const first = typeof o.first_frame_url === "string" ? o.first_frame_url.trim() : undefined
    const last = typeof o.last_frame_url === "string" ? o.last_frame_url.trim() : undefined
    for (const key of ["first_frame_url", "last_frame_url"]) {
      if (o[key] !== undefined && (typeof o[key] !== "string" || !/^https?:\/\//i.test(String(o[key]).trim()))) {
        return { shots: [], error: `第 ${shots.length + 1} 镜 ${key} 必须是非空 http(s) URL，未提交任何镜头` }
      }
    }
    if (o.duration_seconds !== undefined && (typeof o.duration_seconds !== "number" || !Number.isFinite(o.duration_seconds) || o.duration_seconds < 5 || o.duration_seconds > 15)) return { shots: [], error: `第 ${shots.length + 1} 镜时长必须为 5–15 秒` }
    if (!prompt.trim() && !first && !last) return { shots: [], error: `第 ${shots.length + 1} 镜缺少 prompt 或图片，未提交任何镜头` }
    let camera: ShotCamera | undefined
    try { camera = normalizeShotCamera(o, typeof o.duration_seconds === "number" ? o.duration_seconds : undefined) }
    catch (error) { return { shots: [], error: `第 ${shots.length + 1} 镜运镜无效：${error instanceof Error ? error.message : String(error)}；未提交任何镜头` } }
    // 状态变化字段原样透传给 buildBody（beats / state_change / environment_change / audio）。
    const beats = Array.isArray(o.beats)
      ? (o.beats as unknown[])
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          .map((item) => ({
            at_seconds: typeof item.at_seconds === "number" && Number.isFinite(item.at_seconds) ? item.at_seconds : undefined,
            action: typeof item.action === "string" ? item.action : "",
            environment_change: typeof item.environment_change === "string" ? item.environment_change : undefined,
          }))
      : undefined
    const stateRaw = o.state_change && typeof o.state_change === "object" && !Array.isArray(o.state_change) ? o.state_change as Record<string, unknown> : undefined
    const stateChange: ShotStateChange | undefined = stateRaw
      ? { from: typeof stateRaw.from === "string" ? stateRaw.from : undefined, to: typeof stateRaw.to === "string" ? stateRaw.to : undefined }
      : undefined
    const audio = o.audio && typeof o.audio === "object" && !Array.isArray(o.audio) ? o.audio as ShotAudio : undefined
    shots.push({
      camera,
      prompt: prompt.trim() ? prompt : "根据参考图片生成连贯的视频",
      subject: typeof o.subject === "string" ? o.subject : undefined,
      action: typeof o.action === "string" ? o.action : undefined,
      beats,
      state_change: stateChange,
      environment_change: typeof o.environment_change === "string" ? o.environment_change : undefined,
      audio,
      first_frame_url: first || undefined,
      last_frame_url: last || undefined,
      duration_seconds: typeof o.duration_seconds === "number" ? o.duration_seconds : undefined,
      model: typeof o.model === "string" ? o.model.trim() : undefined,
      size: typeof o.size === "string" ? o.size.trim() : undefined,
    })
  }
  if (!shots.length) return { shots: [], error: "未解析到任何含 prompt/帧 URL 的镜" }
  return { shots }
}

/** 首帧、尾帧保序作为图片参考；不宣称上游硬锁端点。 */
function buildBody(shot: Shot, defModel: string, defSize: string, defDur: number): Record<string, unknown> {
  const duration = shot.duration_seconds ?? defDur
  const model = shot.model || defModel
  const hasMotionData =
    (Array.isArray(shot.beats) && shot.beats.some((beat) => typeof beat?.action === "string" && beat.action.trim() !== "")) ||
    (typeof shot.state_change?.from === "string" && shot.state_change.from.trim() !== "" &&
      typeof shot.state_change?.to === "string" && shot.state_change.to.trim() !== "")
  let prompt: string
  if (hasMotionData) {
    // 有状态变化：编译成时间线（起态 → beats → 终态 → 环境变化 → 机位）。
    prompt = compileShotPrompt({ ...shot, subject: shot.subject ?? "", action: shot.action ?? shot.prompt }, model)
  } else {
    // 散文镜头：原话逐字保留；显式运镜照旧追加，末尾补一句正向动态契约（不用否定句）。
    const motion = shot.camera ? compileShotPrompt({ subject: "", action: "", camera: shot.camera, output: { duration_seconds: duration } }, model) : ""
    prompt = `${shot.prompt}${motion ? `\n${motion}` : ""}`
    if (!prompt.includes(DYNAMIC_CONTRACT)) prompt = `${prompt}\n${DYNAMIC_CONTRACT}`
  }
  if (prompt.length > 4000) throw new Error(`镜头提示词共 ${prompt.length} 字超过 4000；未截断、未提交`)
  return {
    model,
    prompt,
    n: 1,
    size: shot.size || defSize,
    duration_seconds: shot.duration_seconds ?? defDur,
    response_format: "url",
    reference_images: [shot.first_frame_url, shot.last_frame_url].filter((url): url is string => Boolean(url)),
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
      // 计费 commit 行可能在 succeeded 响应后才落库（实测竞态）：cost 缺失时延迟重读一次，
      // 仍取不到才诚实回 null（不编造金额）。
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
  return { status: lastStatus, costCoins: null, videoUrl: null, error: `轮询超时（${Math.round(deadlineMs / 1000)}s），job 可能仍在跑，用 GET /v1/videos/${id} 续查` }
}

export default tool({
  description:
    "首尾帧视频链：输入关键帧清单（JSON 数组 [{first_frame_url?, last_frame_url?, prompt, subject?, action?, beats?, state_change?, environment_change?, audio?, camera?, trajectory?, keyframes?, duration_seconds?, model?, size?}]），逐镜经站点计费链 /v1/videos/generations 提交视频 job，轮询至完成，返回按镜排序的 mp4 URL + 耗时 + 实际 cost_coins。\n\n【状态变化契约】有 beats:[{at_seconds?,action,environment_change?}] 或 state_change:{from,to} 的镜头按时间线编译（起态→动作 beat→终态→环境变化→机位）；没有则保留散文原话，并在末尾追加正向动态契约（主体位置/姿态/轮廓与环境的可观察变化）。只写静态画面会被模型做成慢推。\n\n【运镜契约】camera={movement?,start?,end?,trajectory?,timing?,parallax?,keyframes?:[{time_seconds,position}]}，独立trajectory/keyframes同样实传；未知结构或超长明确拒绝。散文prompt逐字保留，未指定运镜不添加默认运动。dolly是摄影机空间位移，zoom是机位固定的光学变焦；参考图差异不是连续运镜证据。\n\n【帧契约】首帧和尾帧 URL 按序经 reference_images 透传站点计费链。minimax-h3 支持最多 9 张图片参考；图片参与生成，但不保证锁定开头或结尾。禁止丢弃关键帧而静默改成纯文生视频。\n\n【预算纪律】必带 dry_run（构造提交体不发射，零扣费）；真发射前用目录 coins_per_second×时长做保守估价，超 budget_max_coins（默认 50）直接拒发并回报预算冲突，不擅自超支。submit_only 模式提交后立即返回 job ids 不等完成（长任务不阻塞）。同一错误重试 2 次即停，失败由站点计费链退款，不重发烧钱。",
  args: {
    shots: tool.schema.string().min(1).describe("关键帧清单 JSON 数组字串：[{first_frame_url?, last_frame_url?, prompt, subject?, action?, beats?, state_change?, environment_change?, audio?, camera?, trajectory?, keyframes?, duration_seconds?, model?, size?}]"),
    model: tool.schema.string().optional().describe("默认视频模型（镜未指定时用）；建议先用 video_quote 查可用模型与单价"),
    size: tool.schema.string().optional().describe("默认画幅，如 16:9 / 9:16（镜未指定时用），默认 16:9"),
    duration_seconds: tool.schema.number().int().min(5).max(15).optional().describe("默认时长秒（镜未指定时用）"),
    dry_run: tool.schema.boolean().optional().describe("true=只构造提交体与预算估算，不发射、零扣费（默认 false）"),
    submit_only: tool.schema.boolean().optional().describe("true=提交后立即返回 job ids 不等完成（长任务不阻塞工具）"),
    budget_max_coins: tool.schema.number().min(0).optional().describe("真发射预算上限（币），默认 50；估价超限即拒发"),
    max_shots: tool.schema.number().int().min(1).max(100).optional().describe("镜数上限，默认 100，超过上限明确拒绝，禁止静默截断"),
    poll_timeout_ms: tool.schema.number().int().min(10000).max(600000).optional().describe("单镜轮询上限毫秒，默认 300000"),
  },
  async execute(args, context) {
    const { shots, error } = parseShots(args.shots)
    if (error) return fail("invalid_shots", error, { title: "关键帧清单解析失败" })

    const maxShots = args.max_shots ?? 100
    if (shots.length > maxShots) return fail("too_many_shots", `共 ${shots.length} 镜超过 max_shots=${maxShots}；未截断、未提交。`)
    const truncated = false
    const work = shots
    const defModel = (args.model || "").trim()
    const defSize = args.size || "16:9"
    const defDur = args.duration_seconds ?? 15
    const dryRun = args.dry_run === true
    const submitOnly = args.submit_only === true
    const budgetMax = args.budget_max_coins ?? 50

    if (!defModel && work.some((s) => !s.model)) {
      return fail("missing_model", "未提供默认 model 且部分镜无 model：先用 video_quote 查可用模型再提交", { title: "缺模型" })
    }

    let bodies: Record<string, unknown>[]
    try { bodies = work.map((s) => buildBody(s, defModel, defSize, defDur)) }
    catch (error) { return fail("invalid_shots", error instanceof Error ? error.message : String(error)) }

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
      /* 取不到目录：估价回退保守 10 币/秒 */
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

    const estimates = bodies.map(estimateShot)
    const totalEstimate = estimates.reduce((a, b) => a + b, 0)

    const frameFinding = {
      endpoint: "/v1/videos/generations",
      reference_images_supported: true,
      keyframe_image_input_supported: true,
      head_tail_lock_guaranteed: false,
      reason: "首帧、尾帧依序作为图片参考传入；minimax-h3 不保证锁定首尾端点。",
      degradation: null,
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
            frames_passed: ((b.reference_images as string[]) ?? []).length > 0,
            est_coins: Math.round(estimates[i] * 1e4) / 1e4,
          })),
          total_est_coins: Math.round(totalEstimate * 1e4) / 1e4,
          budget_max_coins: budgetMax,
          within_budget: totalEstimate <= budgetMax,
          truncated,
          note: "dry_run 未提交任何 job、零扣费。真发射请设 dry_run=false（并确认 within_budget）。帧 URL 已按序进入 reference_images；图片参考不保证锁定首尾。",
        },
        { dry_run: true, shots: work.length, total_est_coins: totalEstimate },
      )
    }

    // ── 预算闸：估价超限即拒发，不擅自超支 ──
    if (totalEstimate > budgetMax) {
      return fail(
        "budget_exceeded",
        `估价 ${Math.round(totalEstimate * 1e4) / 1e4} 币 > 预算上限 ${budgetMax} 币（模型档可能偏贵或镜数过多）。请先 dry_run 核对、换更便宜模型/减镜数/缩短时长，或明确调高 budget_max_coins。未提交任何 job、零扣费。`,
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
        frames_passed: ((body.reference_images as string[]) ?? []).length > 0,
        frame_note: "图片已按首帧、尾帧顺序提交为参考；不保证锁定首尾端点",
      }
      if (submitOnly) {
        results.push({ ...base, status: "submitted", poll_url: `/v1/videos/${jobId}`, elapsed_ms: Date.now() - t0 })
        // 注册给 poller 自动轮询；best-effort，失败不影响主流程（registerTask 本体已吞错回 {ok:false}）。
        // 只在 submit_only 分支注册：轮询分支已拿到终态，再注册会让 poller 对已完成 job 再轮一次并多发 resume。
        // cost_coins 不带：submit 当下尚无真实扣费，poller 用平台回传值或退回估算。
        if (jobId) void registerTask(jobId, context.sessionID, "video", context.abort, { model: work[i].model })
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
          : "逐镜经站点计费链提交+轮询；mp4_url 为成功镜产物；cost_coins 从站点 job 记录读实际值。frames_passed 表示图片参考已随请求提交；不保证锁定首尾端点。",
      },
      { shots: results.length, succeeded, submit_only: submitOnly },
    )
  },
})
