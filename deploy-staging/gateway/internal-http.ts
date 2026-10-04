// index.ts 行区 6412–6869 机械抽取（Wave3，2026-09-19）：画布摘要读取、时间线端点族、
// confirm 轮询/resume/session-key/session-tasks、optimize-prompt 与 extract-lessons 内部端点。
// 逐行搬运自 /home/lenovo/Desktop/image-app/deploy-staging/gateway/index.ts，仅加 export 前缀＋本档头＋单行 import。
import { getTimeline, applyOps, listVersions, diffVersions, restoreVersion, getLog, totalDurationSec, TimelineBlockedError, TimelineValidationError, TimelineNotFoundError, type TimelineOp } from "./timeline"
import { analyzeRhythm } from "./rhythm"
import { lintTimeline } from "./lint"
import { analyzeMix, applyMix } from "./mix"
import { styleCatalog, subtitlesAss, findStylePreset, findTransitionPreset, STYLE_PRESETS } from "./style"
import { masterCheck, masterExport, MASTER_PRESETS, type MasterPresetId } from "./master"
import { registerMasterExport } from "./masters-index"
import { subagentParentApiKey, subagentParentState } from "./subagent"
import { beastAgentField } from "./session-lifecycle"
import { resolveSession, markDirty } from "./sessions-core"
import { opencodeFetch } from "./opencode-client"
import { jsonError } from "./gw-lib"
import { hashKey } from "./auth-gw"
import { armWatchdogTimer } from "./timers-gw.ts"
// TODO(整合 Wave3): timers-gw 同波在建，armWatchdogTimer 尚未可 import，declare 占位（bun build 不查名可过）。

// 画布摘要读取：opencode 的 canvas_summary 工具用 session_id（opencode 或
// gateway 任一 id 皆可）查当前画布状态。GET only、loopback only。
// 摘要 = 前端最后一次发讯息时附带的 canvas_state（节点/连线/预算），
// 纯透传不加工；前端在每轮讯息都会更新，所以这里永远是最新。
export async function handleCanvasStateRead(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json({
    ok: true,
    canvas_state: state.canvasSummary ?? null,
    updated_at: state.canvasSummaryAt ?? null,
  })
}



/**
 * 时间线端点族（B1，2026-08-31）：REQ-EDIT-01 可计算时间线 + REQ-EDIT-05 版本/决策日志。
 * session_id 一律走 query——Bun Request body 只能读一次（workflow 家族同款模式）。
 * 鉴权 = 过上方 Bearer sk-biz 闸门 + getOwnedSession 防跨 key 越权（与 workflow rerun 同款）。
 * 错误映射：locked→409 {blocked, reason:"locked"}；非法 op→400；版本不存在→404。
 */
export async function handleTimelineRoutes(key: string, req: Request, pathname: string): Promise<Response> {
  const url = new URL(req.url)
  let sid = url.searchParams.get("session_id") || ""
  if (!sid) return jsonError(400, "session_id (query) is required", "bad_request", "bad_request")
  // B2 修复（08-31）：opencode 工具传的是 opencode session id，getOwnedSession 只认 gateway UUID。
  // 收敛到 canvasKeyFor 同款三段解析（resolveSession），并收拢 canonical id 防双目录。
  // 0927 身份传递修复：Expert 子代理（editor）跑在独立 opencode 子会话，该 id 不在主
  // sessions 表 → resolveSession 查无 → 整族 timeline 端点一律 404，剪辑域工具在生产
  // 路径上物理不可用（子代理只能 bash 手搓绕过）。缝用既有同款（handleSessionKey 244 /
  // canvas 读取 28 / media 39）：命中活跃子会话时回溯其父 gateway 会话（byChildOc 注册表，
  // 只由可信的 internal dispatch 写入）。下面那道 apiKey 比对照旧——回溯出的父会话必须
  // 与呼叫者同一把 key，跨租户隔离不变，验证未放松。
  const tlDirect = resolveSession(sid)
  const tlParent = tlDirect ? undefined : subagentParentState(sid)
  const tlState = tlDirect ?? tlParent
  // 身份诊断（每呼叫一行，只记 id 与是否同一把 key，不落 key 本身）：日后再遇
  // timeline 404，一次 journal 就能分清「查无会话」与「会话非本 key」。
  console.log(
    `[gateway] timeline auth: sid=${sid} direct=${tlDirect ? "yes" : "no"} parentFallback=${tlParent ? "yes" : "no"} owner=${tlState?.sessionId ?? "-"} keyMatch=${tlState ? (tlState.apiKey === key ? "yes" : "no") : "n/a"}`,
  )
  if (!tlState || tlState.apiKey !== key) return jsonError(404, "session not found", "not_found", "not_found")
  sid = tlState.sessionId
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  try {
    if (req.method === "GET" && pathname === "/agent/v1/timeline") {
      const tl = await getTimeline(sid)
      return Response.json({ ...tl, total_duration_sec: r3(totalDurationSec(tl)) })
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/ops") {
      const body = (await req.json().catch(() => null)) as { ops?: TimelineOp[]; reason?: string } | null
      if (!body || !Array.isArray(body.ops)) return jsonError(400, "body.ops must be an array", "bad_request", "bad_request")
      const res = await applyOps(sid, body.ops, typeof body.reason === "string" ? body.reason : "")
      return Response.json({ diff: res.diff, version: res.version, total_duration_sec: res.total_duration_sec, affected_clips: res.affected_clips })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/versions") {
      return Response.json({ versions: await listVersions(sid) })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/diff") {
      const a = Number(url.searchParams.get("a"))
      const b = Number(url.searchParams.get("b"))
      if (!Number.isInteger(a) || !Number.isInteger(b)) return jsonError(400, "a and b (query) must be integers", "bad_request", "bad_request")
      return Response.json({ a, b, diff: await diffVersions(sid, a, b) })
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/restore") {
      const body = (await req.json().catch(() => null)) as { version?: number } | null
      if (!body || !Number.isInteger(body.version)) return jsonError(400, "body.version must be an integer", "bad_request", "bad_request")
      const res = await restoreVersion(sid, body.version as number)
      return Response.json({ version: res.version, restored_from: body.version, diff: res.diff, total_duration_sec: res.total_duration_sec })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/log") {
      return Response.json({ entries: await getLog(sid) })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/rhythm") {
      const bgm = url.searchParams.get("bgm") || undefined
      return Response.json(await analyzeRhythm(sid, bgm ? { bgmPath: bgm } : {}))
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/lint") {
      return Response.json(await lintTimeline(sid))
    }
    // B5 音画混合（REQ-EDIT-06）：GET 只量测不落盘；POST 渲染落盘 mix.wav
    if (req.method === "GET" && pathname === "/agent/v1/timeline/mix") {
      return Response.json(await analyzeMix(sid))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/mix") {
      return Response.json(await applyMix(sid))
    }
    // B7 风格货架（REQ-EDIT-08）：目录 / 套用（presetId→四滑杆翻译成 set_style；transition 翻译成既有 set_transition op）/ 字卡 ASS
    if (req.method === "GET" && pathname === "/agent/v1/timeline/style") {
      const tl = await getTimeline(sid)
      return Response.json(styleCatalog(tl))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/style") {
      const body = (await req.json().catch(() => null)) as {
        clipId?: string
        presetId?: string
        filter?: { brightness?: number; contrast?: number; saturation?: number; temperature?: number }
        transition?: { presetId?: string; durationSec?: number }
        reason?: string
      } | null
      if (!body || typeof body.clipId !== "string" || !body.clipId) return jsonError(400, "body.clipId is required", "bad_request", "bad_request")
      const ops: TimelineOp[] = []
      if (body.presetId !== undefined) {
        const p = findStylePreset(body.presetId)
        if (!p) return jsonError(400, `unknown presetId: ${body.presetId}（可选：${STYLE_PRESETS.map((x) => x.id).join("/")}）`, "bad_request", "bad_request")
        ops.push({ type: "set_style", clipId: body.clipId, filter: { preset: p.id, ...p.values } })
      } else if (body.filter) {
        ops.push({
          type: "set_style",
          clipId: body.clipId,
          filter: {
            brightness: Number(body.filter.brightness ?? 0),
            contrast: Number(body.filter.contrast ?? 0),
            saturation: Number(body.filter.saturation ?? 0),
            temperature: Number(body.filter.temperature ?? 0),
          },
        })
      }
      if (body.transition?.presetId !== undefined) {
        const t = findTransitionPreset(body.transition.presetId)
        if (!t) return jsonError(400, `unknown transition presetId: ${body.transition.presetId}`, "bad_request", "bad_request")
        ops.push({ type: "set_transition", clipId: body.clipId, transition: { type: t.xfade, duration: body.transition.durationSec ?? t.defaultDuration } })
      }
      if (!ops.length) return jsonError(400, "body requires presetId / filter / transition.presetId", "bad_request", "bad_request")
      const res = await applyOps(sid, ops, typeof body.reason === "string" ? body.reason : "set_style")
      return Response.json({ version: res.version, applied: res.affected_clips, diff: res.diff })
    }
    if (req.method === "GET" && pathname === "/agent/v1/timeline/style/subtitles.ass") {
      const tl = await getTimeline(sid)
      return new Response(subtitlesAss(tl), { headers: { "content-type": "text/plain; charset=utf-8" } })
    }
    // B6 母带检查+导出闸（REQ-EDIT-07）：GET 聚合报告；POST blockers 非空拒导（TimelineValidationError→400）
    if (req.method === "GET" && pathname === "/agent/v1/timeline/master") {
      return Response.json(await masterCheck(sid))
    }
    if (req.method === "POST" && pathname === "/agent/v1/timeline/master") {
      const body = (await req.json().catch(() => null)) as { preset?: string; with_cover?: boolean } | null
      const presetId = (body?.preset ?? "landscape_169") as MasterPresetId
      if (!(presetId in MASTER_PRESETS)) return jsonError(400, `unknown preset: ${body?.preset}（可选：${Object.keys(MASTER_PRESETS).join("/")}）`, "bad_request", "bad_request")
      const result = await masterExport(sid, presetId, body?.with_cover !== false)
      // G4（2026-09-17）：导出成功 → 回填公网 URL + 控制面索引登记（幂等）。
      // 登记失败不反悔导出（档案已在盘上、静态路由已可服务），只诚实记 note。
      await registerMasterExport(key, sid, presetId, result)
      return Response.json(result)
    }
    return jsonError(404, "unknown timeline route", "not_found", "not_found")
  } catch (e) {
    if (e instanceof TimelineBlockedError) {
      return Response.json({ error: e.message, blocked: e.blocked, reason: "locked" }, { status: 409 })
    }
    if (e instanceof TimelineNotFoundError) return jsonError(404, e.message, "not_found", "timeline_version_not_found")
    if (e instanceof TimelineValidationError) return jsonError(400, e.message, "bad_request", "timeline_invalid_op")
    return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "timeline_error")
  }
}

/** Poll target for the tool: has the user answered this confirm yet? */
export async function handleConfirmStatus(req: Request): Promise<Response> {
  let body: { session_id?: string; request_id?: string }
  try {
    body = (await req.json()) as { session_id?: string; request_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  // 0920：Expert 子会话兜底（见 canvas 读取同款注释）——扣费确认卡必须落在用户会话。
  const state = resolveSession(session_id) ?? subagentParentState(session_id)
  // A vanished session means the session was deleted or reaped out from under
  // the tool. That is a denial, not an unknown: nothing may be spent for a
  // session that no longer exists.
  if (!state) return Response.json({ status: "denied", request_id, reason: "session_gone" })

  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }
  // Neither pending nor recently resolved: the answer aged out of the retention
  // window, or this id was never registered. Fail closed.
  return Response.json({ status: "denied", request_id, reason: "unknown_request" })
}

export async function handleResumeSession(req: Request): Promise<Response> {
  let body: { session_id?: string; content?: string }
  try {
    body = (await req.json()) as { session_id?: string; content?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, content } = body
  if (!session_id || typeof content !== "string" || content.trim() === "") {
    return jsonError(400, "session_id and content are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  // Async, same reason as handleSendMessage: the poller must not be held open
  // for the length of an LLM turn.
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ ...beastAgentField(state), parts: [{ type: "text", text: content }] }),
      timeoutMs: 10000,
    })
    if (!res.ok) {
      return jsonError(502, `opencode resume failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  // 抖动重试记账（与 handleSendMessage 同款）：resume 轮同样可能抖动早死。
  state.lastPromptBody = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
  state.turnGen = (state.turnGen ?? 0) + 1
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnRetries = 0
  state.turnAborted = false
  state.turnAbortSource = undefined // D2-1b：新轮起点清中止来源（与 turnAborted 同点）
  state.retryQueued = false
  state.turnUpstreamError = null
  // R2-A 看门狗：resume 轮同样要兜 turn 未启动。
  state.turnToolStarted = false
  state.watchdogRetried = false
  // 修 1：resume 开新轮，旧死亡宣告作废（撤回帧不嫁接到新轮）。
  state.deathDeclared = false
  // R8-B 工单 #4：resume 轮同样重置 question 答覆标记。
  state.questionAnsweredThisTurn = false
  // 2026-10-02 steer 误判修复：resume 轮同样要打 lastTurnActiveAt（steer 受理闸
  // 唯一依据；三条「从 idle 起轮」路径——子代理唤醒／workflow 唤醒／本端点——
  // 原本全漏，唤醒驱动会话的 steer 因此全被 409 no_active_turn 误判失败）。
  state.lastTurnActiveAt = Date.now()
  markDirty(state)
  armWatchdogTimer(state)
  return Response.json({ ok: true })
}

export async function handleSessionKey(req: Request): Promise<Response> {
  let body: { session_id?: string }
  try {
    body = (await req.json()) as { session_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id } = body
  if (!session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id) ?? subagentParentState(session_id)
  if (state) {
    const user_id = await hashKey(state.apiKey)
    // 2026-09-29 审计（H5）：回传可信的上传归属＝该会话的 gateway sessionId（uploads/<id>/）。
    // plugin 以此为唯一允许的 upload 目录，取代「用户提到即授权」的旧机制。
    return Response.json({ ok: true, api_key: state.apiKey, user_id, upload_owner: state.sessionId })
  }
  // 死线③（片 AN，评测 REPORT S2）：子代理 opencode session 只在 subagent 运行时
  // 注册表（byChildOc）里，主 sessions 表查无记录 → 工具侧 resolveKey 全挂。
  // 最小修：命中活跃子会话时继承父会话 apiKey（同一用户，计费口径不变）。
  const parentKey = subagentParentApiKey(session_id)
  if (parentKey) {
    const user_id = await hashKey(parentKey)
    return Response.json({ ok: true, api_key: parentKey, user_id })
  }
  return jsonError(404, "session not found", "not_found", "not_found")
}

// 0831：本轮任务登记表端点（给工具读的权威 ID 来源）。鉴权/防呆逐字对齐 /internal/session-key：
// 同处 /internal/ loopback 门内、同一 resolveSession 查找、同 jsonError 防呆；仅回应换成 tasks 契约。
export async function handleSessionTasks(req: Request): Promise<Response> {
  let body: { session_id?: string }
  try {
    body = (await req.json()) as { session_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id } = body
  if (!session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id) ?? subagentParentState(session_id)
  // H11：查无会话不再回 404——工具侧（image_get_result.listTasks）以 resp.ok 判断，404 会被吞成
  // 「回环未回应」。改回 200 + tasks:[] + session_found:false，如实区分「无会话」与「无任务」。
  if (!state) return Response.json({ ok: true, session_found: false, tasks: [] })
  // hydrate 重启恢复的 session 该栏可能 undefined（sessions-core 已补，这里再兜底防 500）。
  return Response.json({ ok: true, session_found: true, tasks: [...(state.sessionTasks?.values() ?? [])] })
}


/**
 * POST /agent/v1/optimize-prompt — 同步影片 prompt 优化。
 *
 * 这是 Image Studio 的「隐形提示词导演」后端：generate-videos 进上游前，
 * 把用户短 prompt + 金矿工业级导演规则送给 opencode（deepseek）大脑，
 * 同步拿回优化稿。与 agent 对话 session 完全隔离：每次请求建一个临时
 * opencode session，用完即删，不进 sessions 池、不开 SSE 流。
 *
 * body: { prompt: string, duration_seconds?: number, generate_audio?: boolean }
 * 回应: 200 { ok, prompt, model } / 502 { ok:false, ... }（上游不可用）
 *
 * 规则来源：Higgsfield Hell Grind 95 分钟长片 pipeline + Seedance 2.0 官方
 * prompt 架构（OSideMedia/higgsfield-ai-prompt-skill，MIT）——31 子 skill 的
 * 共通核心全文编译进 system prompt，一次读完，不需 agent 多步思考。
 */

// 金矿工业级规则全文。用户输入可能只是「帮我生成浩克对战蜘蛛侠的电影」这种
// 一句话抽象请求——规则负责把它变成可用 production prompt。
export const OPTIMIZE_DIRECTOR_PREFIX = `You are a professional video and image prompt director trained on the Higgsfield Hell Grind 95-minute feature film pipeline and Seedance 2.0 production prompt rules.

Turn the user's request into ONE production-ready generation prompt. The user may be a non-expert writing one vague sentence — you must still produce a complete, usable prompt. Output ONLY the generated prompt, no preamble, no commentary, no markdown.

THE SIX-SLOT FORMULA (every prompt must contain all six, in this order):
[Camera movement] + [Subject] + [Action] + [Setting] + [Style] + [Lighting]
If the user's input is missing slots, fill them with the most effective defaults for the scene type. 50-80 words is the sweet spot for a single shot.

BLOCK SCAFFOLD (for multi-shot / long-form work):
SCENE CONTEXT → ACTIVE REFERENCES → LOCATION MAP → FIRST FRAME/BLOCKING → FORMAT MODE → OPTICS → CAMERA → ACTION → PERFORMANCE → PHYSICS → LIGHTING → COLOR GRADE → WARDROBE → AUDIO → STYLE → OUTPUT SETTINGS → POSITIVE LOCKS. Write only the blocks the shot needs. 2000+ words is fine here — structure replaces the word cap.

HARD RULES (each one exists because a shot failed without it):
1. POSITIVE PHRASING ONLY. Never write negative instructions ("does not", "no X"). Declare what IS true. Seedance parses every token as a positive instruction. Short lock tails inside a positive declaration ("Stable composition, no flicker") are fine.
2. ANTI-SLOP. Replace empty adjectives with named referents: "cinematic" -> a lighting setup or lens spec ("golden-hour backlight", "anamorphic 2.39:1 flare"); "epic" -> "large-scale"; "fast" -> describe physics ("feet striking hard, each stride at full extension"); "beautiful"/"high quality" -> delete, describe the specific visual.
3. EMOTION = MUSCLE. Never write emotion labels ("she looks scared"). Write "jaw clenches, nostrils flare, shallow breath, shoulders pull inward". One visible micro-event every 1-2 seconds (a blink, a breath, a nostril move). Layered emotion: dominant state in the face, underlying state in breath/posture/hands, the tell in the eyes.
4. NAME THE CAMERA WITH AN ENDPOINT. Not "the camera moves" but "slow dolly-in, ending on her hands around the cup". One primary move per shot, max one texture modifier ("slightly handheld"). Camera matches emotion: jittery handheld for anger, smooth breathing for calm, static slow push for revelation.
5. ONE PRIMARY ACTION per clip, 1-2 secondary max. Chain 2-3 connected actions in one direction so motion spends the whole clip. A deliberate there-and-back is two shots, never one prompt. Never let a short action finish early.
6. AGE-BLIND. Never describe characters by age (boy/girl/child/kid/teen/young/little). Use role, clothing, action. The content filter tightens sharply the moment it reads a minor.
7. IP AND REAL PEOPLE. Never name copyrighted characters (Hulk, Spider-Man, etc.) or real celebrities. Describe them by their defining visual traits, role, and actions instead: "an enormous green-skinned muscle-bound figure whose rage grows as it fights" / "a slight acrobatic hero in red-and-blue body armor who webs and swings". This is mandatory even when the user named the IP directly.
8. FOV IN DEGREES ONLY (for multishot): 180 fisheye / 107 ultra-wide arch / 84 wide group / 63 observational / 47 neutral / 29 portrait / 18 close portrait / 12 tele-detail / 8 extreme. Add "no drift mid-segment".
9. MEASURABLE LANGUAGE. Speed in km/h. Fog/haze in % and meters. Giant scale via human-height comparison ("as tall as four humans stacked"). Left/right always from the camera. White balance fixed in Kelvin (3200K/4000K/5600K/8500K). Mass and size in real units so gravity reads correctly.
10. HOMOGRAPH TRAP. If a word has a second physical reading the model may take it: tearing (rip/cry), shoot, duck, bolt, draw, wave, charge, rock, drop, fire, strike, break, pound, snap. Replace with phrasing only ONE thing can look like: "wind tearing at her coat" -> "wind whipping violently at her coat".
11. END WITH A QUALITY TAIL if video: "Stable composition, no flicker, detailed texture preserved." Audio: "SFX only, no music" unless the user asked for a soundtrack.
12. CUT DISCIPLINE. Keep one continuous shot unless the scene demands a cut. If a cut is needed, name the type (HARD CUT / SMASH CUT / MATCH CUT / REVERSE CUT) and timing. Every cut changes BOTH shot size AND camera character (double-contrast rule). Never repeat either across a cut.
13. POSITIVE LOCKS for multi-shot: "The set contains only what is described. Character identity and environment stay identical across every cut. No extra people, no duplicated furniture." For 2+ characters write real heights to prevent equalization drift.

WHEN THE USER IS VAGUE (they will be — they are a non-expert):
- Infer the scene type, pick the right template, and produce a complete prompt anyway.
- Decide camera, lighting, and style from the mood of the request.
- If they named a copyrighted hero, rewrite per rule 7 — never paste the IP name.
- If they described a shot type (battle, chase, dialogue, horror, product), use the strongest expected structure for that type.

Translate any Chinese user input to English in the output prompt.

USER:`
export async function handleOptimizePrompt(key: string, req: Request): Promise<Response> {
  let body: { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  try {
    body = (await req.json()) as { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return jsonError(400, "prompt is required", "bad_request", "bad_request")

  // 开一个一次性 opencode session（与对话 pool 无关）。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${OPTIMIZE_DIRECTOR_PREFIX}\n\n${prompt}`

    const res = await opencodeFetch(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      timeoutMs: 120000,
    })
    if (!res.ok) {
      return jsonError(502, `opencode optimize failed: ${res.status}`, "backend_error", "backend_error")
    }

    const payload = (await res.json()) as { info?: { modelID?: string }; parts?: Array<{ type?: string; text?: string }> }
    // 最后一个 text part = 最终答案。opencode 同步 message 的 parts 顺序是
    // step-start → text → step-finish，通常只有一个 text。
    const texts = (payload.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text ?? "")
    const optimized = texts.length > 0 ? texts[texts.length - 1].trim() : ""
    if (!optimized) {
      return jsonError(502, "opencode returned no text", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, prompt: optimized, model: payload.info?.modelID ?? "unknown" })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    // 一次性 session，事后必删。
    await opencodeFetch(`/session/${sessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}

export const EXTRACT_LESSONS_PREFIX = `You are a memory curator for an AI image-generation assistant.
Your ONLY job: given a conversation transcript between a user and the assistant, extract up to 6 durable lessons about THIS USER that would help a future session serve them better without re-asking.

Rules:
- Lessons must be about the user's stable preferences, working habits, specs, style, workflow, or recurring corrections.
- One lesson per line. Each lesson is ONE short sentence (under 40 words), imperative-ish or declarative, e.g. "User batches 4 images at a time and wants them all in one canvas" or "User prefers 4:5 aspect ratio for product shots".
- Never invent facts not supported by the transcript.
- Skip one-time requests, greetings, and anything non-durable.
- Output ONLY the lessons, one per line, no preamble, no numbering, no markdown.`

export async function handleExtractLessons(key: string, req: Request): Promise<Response> {
  let body: { transcript?: string; max_lessons?: number }
  try {
    body = (await req.json()) as { transcript?: string; max_lessons?: number }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : ""
  if (!transcript) return jsonError(400, "transcript is required", "bad_request", "bad_request")
  if (transcript.length > 100_000) return jsonError(400, "transcript too large", "bad_request", "bad_request")
  const maxLessons = Math.min(Math.max(Number(body.max_lessons) || 6, 1), 8)

  // 一次性 opencode session（与对话 pool 无关），同步取结果后即删。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${EXTRACT_LESSONS_PREFIX}\n\n<transcript>\n${transcript}\n</transcript>\n\n提取该用户的教训,每行一条。`
    const res = await opencodeFetch(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      timeoutMs: 120000,
    })
    if (!res.ok) {
      return jsonError(502, `opencode extract failed: ${res.status}`, "backend_error", "backend_error")
    }
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    const raw = texts.length > 0 ? texts[texts.length - 1] : ""
    const lessons = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, maxLessons)
    if (lessons.length === 0) {
      return jsonError(502, "opencode returned no lessons", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, lessons })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    await opencodeFetch(`/session/${sessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}
