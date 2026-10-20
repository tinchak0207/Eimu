import type { DirectorActionClip, DirectorElement, DirectorElementState, DirectorPlan, DirectorSequenceShot, Vec3 } from "./director-engine/types"
import { DirectorBlockedError, DirectorNotFoundError, DirectorNotInitializedError, DirectorValidationError, KNOWN_OPS } from "./director-types.ts"
import { assertSessionId, loadCurrent } from "./director-store.ts"
import { renderSchematics, resetDirector, resolveFn } from "./director-emit.ts"
import { DirectorOp } from "./director-ops.ts"
import { applyDirectorOps, getDirectorState } from "./director-state.ts"
import { applyDirectorProposal, createDirectorProposals } from "./director-proposals.ts"

/** spec §3 GET /schematic?plan=&shot= */
export async function getDirectorSchematic(sid: string, planId?: string, shotId?: string): Promise<{ ok: true; top_view_svg: string; camera_view_svg: string }> {
  assertSessionId(sid)
  const doc = await loadCurrent(sid)
  if (!doc || doc.plans.length === 0) throw new DirectorNotInitializedError()
  const basePlan = doc.plans.find((p) => p.id === doc.activePlanId) ?? doc.plans[0]
  const plan = planId ? doc.plans.find((p) => p.id === planId) : basePlan
  if (planId && !plan) throw new DirectorNotFoundError(`找不到方案 ${planId}`)
  const shot = shotId ? plan?.shots.find((s) => s.id === shotId) : undefined
  if (shotId && !shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
  return { ok: true, ...renderSchematics(doc, plan, shot) }
}

// ── HTTP 路由层（spec §3 六条；挂载与鉴权照 handleTimelineRoutes 惯例） ──────────
//
// index.ts 补丁在 Bearer sk-biz 闸门之后呼叫 handleDirectorRoutes(key, req, pathname)。
// 鉴权 = getOwnedSession 同款：resolveSession 三段解析（gateway UUID / opencode id 均收敛）
// + apiKey 比对防跨 key 越权；session_id 一律走 query（Bun Request body 只能读一次）。

function directorHttpError(e: unknown): Response {
  if (e instanceof DirectorNotInitializedError) {
    return Response.json({ ok: false, error: { message: e.message, type: "director_not_initialized", code: "director_not_initialized" } }, { status: 409 })
  }
  if (e instanceof DirectorBlockedError) {
    return Response.json({ ok: false, error: { message: e.message, type: "director_blocked", code: "director_blocked" } }, { status: 409 })
  }
  if (e instanceof DirectorNotFoundError) {
    return Response.json({ ok: false, error: { message: e.message, type: "not_found", code: "not_found" } }, { status: 404 })
  }
  if (e instanceof DirectorValidationError) {
    return Response.json({ ok: false, error: { message: e.message, type: "bad_request", code: "bad_request" } }, { status: 400 })
  }
  return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : String(e), type: "director_error", code: "director_error" } }, { status: 500 })
}

/**
 * spec §3 路由族：
 *   GET  /agent/v1/director/state        ?session_id=
 *   POST /agent/v1/director/op           ?session_id=  body {op, ...payload} 或 {ops:[...]}
 *   POST /agent/v1/director/proposals    ?session_id=  body {instruction}
 *   POST /agent/v1/director/apply_proposal ?session_id= body {proposal_id}
 *   GET  /agent/v1/director/schematic    ?session_id=&plan=&shot=
 *   POST /agent/v1/director/reset        ?session_id=
 * spec 亦允许 /agent/v1/director/:sid/* 形；两形都收（:sid 优先，退回 query）。
 */
export async function handleDirectorRoutes(key: string, req: Request, pathname: string): Promise<Response> {
  const url = new URL(req.url)
  // 形一：/agent/v1/director/<sid>/...；形二：/agent/v1/director/<verb>?session_id=
  const rest = pathname.replace(/^\/agent\/v1\/director\/?/, "")
  const [first, second] = rest.split("/")
  let sid = ""
  let verb = ""
  if (second !== undefined) {
    sid = first
    verb = second
  } else {
    verb = first
    sid = url.searchParams.get("session_id") || ""
  }
  if (!sid) return Response.json({ ok: false, error: { message: "session_id (query or path) is required", type: "bad_request", code: "bad_request" } }, { status: 400 })
  // 鉴权：resolveSession 收敛 opencode id → gateway UUID（timeline B2 修复同款）+ 跨 key 越权守卫
  const state = resolveFn?.(sid)
  if (!state || state.apiKey !== key) {
    return Response.json({ ok: false, error: { message: "session not found", type: "not_found", code: "not_found" } }, { status: 404 })
  }
  sid = state.sessionId
  try {
    if (req.method === "GET" && verb === "state") {
      // R1-#1：?mode=summary 剥 joints/keyframes 摘要输出；缺省 full（前端兼容零风险）
      const mode = url.searchParams.get("mode") === "summary" ? "summary" : "full"
      return Response.json(await getDirectorState(sid, mode))
    }
    if (req.method === "POST" && verb === "op") {
      const body = (await req.json().catch(() => null)) as { op?: string; ops?: DirectorOp[]; reason?: string } & Record<string, unknown> | null
      if (!body) return Response.json({ ok: false, error: { message: "body must be JSON", type: "bad_request", code: "bad_request" } }, { status: 400 })
      // 两形：{ops:[...]} 批量（工具层规格化）或 {op:"...", ...payload} 单发（原生形状）
      let ops: DirectorOp[]
      if (Array.isArray(body.ops)) {
        ops = body.ops
      } else if (typeof body.op === "string") {
        const { op, ops: _drop, reason: _r, ...payload } = body
        ops = [snakeToCamelOp(op, payload)]
      } else {
        return Response.json({ ok: false, error: { message: "body.op or body.ops is required", type: "bad_request", code: "bad_request" } }, { status: 400 })
      }
      const res = await applyDirectorOps(sid, ops, typeof body.reason === "string" ? body.reason : "")
      // R3-⑤：群组 op 时透传契约栏位（信封同现有 op，多回 group/removed_group_id）
      return Response.json({ ok: true, project: res.project, revision: res.revision, changed: res.changed, emitted: res.emitted, ...(res.group ? { group: res.group } : {}), ...(res.removed_group_id ? { removed_group_id: res.removed_group_id } : {}) })
    }
    if (req.method === "POST" && verb === "proposals") {
      const body = (await req.json().catch(() => null)) as { instruction?: string; shot_count?: unknown } | null
      if (!body || typeof body.instruction !== "string") {
        return Response.json({ ok: false, error: { message: "body.instruction is required", type: "bad_request", code: "bad_request" } }, { status: 400 })
      }
      // R3-④：可选 shot_count（int 1-12）；缺省由服务端从 instruction 解析
      const shotCount = body.shot_count === undefined || body.shot_count === null ? undefined : Number(body.shot_count)
      return Response.json(await createDirectorProposals(sid, body.instruction, shotCount))
    }
    if (req.method === "POST" && verb === "apply_proposal") {
      const body = (await req.json().catch(() => null)) as { proposal_id?: string } | null
      if (!body || typeof body.proposal_id !== "string") {
        return Response.json({ ok: false, error: { message: "body.proposal_id is required", type: "bad_request", code: "bad_request" } }, { status: 400 })
      }
      return Response.json(await applyDirectorProposal(sid, body.proposal_id))
    }
    if (req.method === "GET" && verb === "schematic") {
      return Response.json(await getDirectorSchematic(sid, url.searchParams.get("plan") ?? undefined, url.searchParams.get("shot") ?? undefined))
    }
    if (req.method === "POST" && verb === "reset") {
      return Response.json(await resetDirector(sid))
    }
    return Response.json({ ok: false, error: { message: `unknown director route ${req.method} /${verb}`, type: "not_found", code: "not_found" } }, { status: 404 })
  } catch (e) {
    return directorHttpError(e)
  }
}

/**
 * 单发 op 的 payload 栏位名转换：HTTP 层用 snake_case（工具层惯例），op 联合用 camelCase
 * （wheel DirectorPlan/DirectorSequenceShot 栏位名）。只转已知键，值原样透传。
 */
function snakeToCamelOp(op: string, payload: Record<string, unknown>): DirectorOp {
  const p = payload
  switch (op) {
    case "addElement": return { op, element: p.element as DirectorElement }
    case "removeElements": return { op, ids: (p.ids ?? p.elements) as string[] }
    case "updateShotElementState": return { op, shot_id: String(p.shot_id ?? p.shotId ?? ""), element_id: String(p.element_id ?? p.elementId ?? ""), patch: (p.patch ?? p.state) as Partial<DirectorElementState> }
    case "addShot": return { op, shot: (p.shot ?? p) as Partial<DirectorSequenceShot> }
    case "updateShot": return { op, shot_id: sid0(p), patch: (p.patch ?? p) as Partial<DirectorSequenceShot> }
    case "removeShot": return { op, shot_id: sid0(p) }
    case "reorderShot": return { op, shot_id: sid0(p), to_index: Number(p.to_index ?? p.toIndex ?? 0) }
    case "addPlan": return { op, plan: (p.plan ?? p) as Partial<DirectorPlan> }
    case "updatePlan": return { op, plan_id: pid0(p), patch: (p.patch ?? { name: p.name, summary: p.summary }) as { name?: string; summary?: string } }
    case "removePlan": return { op, plan_id: pid0(p) }
    case "duplicatePlan": return { op, plan_id: pid0(p) }
    case "replacePlans": return { op, plans: p.plans as DirectorPlan[] }
    case "setActivePlan": return { op, plan_id: pid0(p) }
    case "setActiveShot": return { op, shot_id: (p.shot_id ?? p.shotId ?? null) as string | null }
    case "setCurrentTime": return { op, time_sec: Number(p.time_sec ?? p.timeSec ?? 0) }
    case "setPlaying": return { op, playing: Boolean(p.playing) }
    case "addAction": {
      const a = (p.action ?? p) as Record<string, unknown>
      // R1-#2：显式 from 可覆盖（工具层现不传，raw API 逃生口）；to 缺参时不再虚构 (0,0,0)——
      // 交由 gateway 以「原地动作 to={...from}」接续求解（与原地动作语义一致）
      const hasTo = a.to !== undefined || a.to_x !== undefined || a.to_y !== undefined || a.to_z !== undefined
      const hasFrom = a.from !== undefined || a.from_x !== undefined || a.from_y !== undefined || a.from_z !== undefined
      return {
        op,
        shot_id: sid0(p),
        action: {
          element_id: String(a.element_id ?? a.elementId ?? ""),
          action: a.action as DirectorActionClip["action"],
          start_sec: num0(a.start_sec ?? a.startSec ?? a.start_shot_frame),
          duration_sec: num0(a.duration_sec ?? a.durationSec ?? a.duration_frames),
          ...(hasFrom ? { from: (a.from ?? { x: num0(a.from_x), y: num0(a.from_y), z: num0(a.from_z) }) as Vec3 } : {}),
          ...(hasTo ? { to: (a.to ?? { x: num0(a.to_x ?? a.moveX ?? 0) + 0, y: num0(a.to_y ?? 0), z: num0(a.to_z ?? a.moveZ ?? 0) }) as Vec3 } : {}),
          intensity: a.intensity === undefined ? undefined : Number(a.intensity),
          locked: a.locked === undefined ? undefined : Boolean(a.locked),
          // R3-⑥：force 透传（单发形逃生口；重叠守卫的强制覆盖出口）
          force: a.force === undefined ? undefined : Boolean(a.force),
        },
      }
    }
    case "updateAction": return { op, shot_id: sid0(p), action_id: aid0(p), patch: (p.patch ?? p) as Partial<DirectorActionClip> }
    case "removeAction": return { op, shot_id: sid0(p), action_id: aid0(p) }
    case "set_lock": return { op, target: p.target as "action" | "motion_keyframe" | "camera_keyframe", shot_id: sid0(p), action_id: (p.action_id ?? undefined) as string | undefined, keyframe_id: (p.keyframe_id ?? undefined) as string | undefined, locked: Boolean(p.locked) }
    case "delete_element": return { op, element_id: String(p.element_id ?? p.elementId ?? "") }
    case "delete_action": return { op, shot_id: sid0(p), action_id: aid0(p), override_locked: p.override_locked === undefined ? undefined : Boolean(p.override_locked) }
    case "delete_keyframe": return { op, target: (p.target ?? "motion_keyframe") as "motion_keyframe" | "camera_keyframe", shot_id: sid0(p), action_id: (p.action_id ?? undefined) as string | undefined, keyframe_id: String(p.keyframe_id ?? ""), override_locked: p.override_locked === undefined ? undefined : Boolean(p.override_locked) }
    // R3-⑤：群组单发形（工具层契约：{op:"addGroup", name, element_ids} / {op:"removeGroup", group_id}）
    case "addGroup": return { op, name: String(p.name ?? ""), element_ids: (p.element_ids ?? p.elementIds ?? []) as string[] }
    case "removeGroup": return { op, group_id: String(p.group_id ?? p.groupId ?? "") }
    case "undo": return { op }
    case "redo": return { op }
    case "checkpoint": return { op }
    case "save": return { op }
    default:
      // R3-⑦：未知 op 单发形与 applyDirectorOp 防卫同款文案（带可用清单）
      throw new DirectorValidationError(`不支持的操作 ${op}，可用：${KNOWN_OPS.join("、")}`)
  }
}

function sid0(p: Record<string, unknown>): string {
  return String(p.shot_id ?? p.shotId ?? "")
}
function pid0(p: Record<string, unknown>): string {
  return String(p.plan_id ?? p.planId ?? "")
}
function aid0(p: Record<string, unknown>): string {
  return String(p.action_id ?? p.actionId ?? "")
}
function num0(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}