/**
 * director 工具層共用模塊（片4，2026-09-02）：16 個 director_* 工具的公共面。
 * 兩部分：
 * 1) 工具 plumbing：GATEWAY loopback fetch、resolveKey Bearer、ok()/fail()、extractError、
 *    directorFetch（session_id 一律走 query，Bun Request body 只能讀一次——片3 坑④）。
 *    範式逐行照 timeline_ops.ts；lib/client.ts 的 ok/fail/resolveKey 邏輯在此內聯
 *    （lib/ 必須在 tools/ 之外且無跨目錄依賴，VPS 落位結構如此）。
 * 2) kunpeng 純函數鏡像：directorTools.ts 的 num/bool/vecFromParams/hasVecParams/
 *    resolveShot/resolveAction/elementState/absoluteFrame + 各守衛文案（簡體照搬）。
 *    gateway 只收「文檔操作」op，工具層負責全部語義守衛與形狀規格化。
 */
import nanoid from "./director/nanoid"
import type { DirectorActionClip, DirectorElement, DirectorPlan, DirectorSequenceShot, DirectorElementState, Vec3 } from "./director/types"
import { planDuration } from "./director/playback"

// ── 1) plumbing ────────────────────────────────────────────────────────────

export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const FPS = 24
export const FPS_OUT = FPS

export async function resolveKey(sessionID: string, signal?: AbortSignal): Promise<string> {
  try {
    const resp = await fetch(`${GATEWAY}/internal/session-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID }),
      signal,
    })
    if (resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { api_key?: unknown }
      if (typeof body?.api_key === "string" && body.api_key) return body.api_key
    }
  } catch {
    // gateway 無法解析 → fallback
  }
  const fallback = process.env.HARNESS_API_KEY
  if (!fallback) throw new Error("无法解析 API key：gateway 无此 session 记录且无 HARNESS_API_KEY")
  return fallback
}

export function ok(data: Record<string, unknown>): { title: string; output: string } {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

export function fail(code: string, hint: string, extra?: Record<string, unknown>): { title: string; output: string } {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

/** gateway 錯誤體兩種形狀：409/404/400 為 {error:{message,type,code}}；director 錯誤 message 欄位 */
export function extractError(data: Record<string, unknown>, status: number): string {
  const e = data?.error
  if (typeof e === "string" && e) return e
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message
  }
  return `HTTP ${status}`
}

export interface DirectorGatewayError {
  status: number
  code: string
  message: string
}

/** 呼叫 gateway director 六路由；session_id 走 query；錯誤統一拋 DirectorGatewayError */
export async function directorFetch(
  sessionID: string,
  verb: string,
  method: "GET" | "POST",
  body?: unknown,
  signal?: AbortSignal,
  query = "",
): Promise<Record<string, unknown>> {
  const key = await resolveKey(sessionID, signal)
  const res = await fetch(
    `${GATEWAY}/agent/v1/director/${verb}?session_id=${encodeURIComponent(sessionID)}${query}`,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    },
  )
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const e = data?.error
    const code =
      e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
        ? (e as { code: string }).code
        : `http_${res.status}`
    const message = extractError(data, res.status)
    const err = new Error(message) as Error & { status: number; code: string }
    err.status = res.status
    err.code = code
    throw err
  }
  return data
}

/** DirectorGatewayError → fail()：gateway 文案已含行動指引（簡體，片3 實彈驗證過），原樣透傳不加工 */
export function directorFail(e: unknown): { title: string; output: string } {
  const err = e as Error & { status?: number; code?: string }
  return fail(err?.code ?? "director_error", err?.message || "gateway 不可达")
}

// ── 2) kunpeng directorTools.ts 純函數鏡像（逐行等價） ─────────────────────

export function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

export function vecFromParams(params: Record<string, unknown>, prefix: string, fallback: Vec3, limits: [number, number]): Vec3 {
  return {
    x: num(params[`${prefix}_x`], fallback.x, limits[0], limits[1]),
    y: num(params[`${prefix}_y`], fallback.y, limits[0], limits[1]),
    z: num(params[`${prefix}_z`], fallback.z, limits[0], limits[1]),
  }
}

export function hasVecParams(params: Record<string, unknown>, prefix: string): boolean {
  return [`${prefix}_x`, `${prefix}_y`, `${prefix}_z`].some((key) => params[key] !== undefined)
}

/** 從 GET /state 回包取活動方案（路由形參數；找不到=wheel requireDirector 文案） */
export function activePlanOf(state: Record<string, unknown>): DirectorPlan | null {
  const project = state.project as DirectorSceneFileLite | undefined
  if (!project) return null
  const plans = (project.plans ?? []) as DirectorPlan[]
  const activeId = state.active_plan_id as string | null | undefined
  return plans.find((item) => item.id === activeId) ?? plans[0] ?? null
}

/** kunpeng directorStore.ts L247 newElementId 逐字等價（gateway addElement 不生成 id，必須工具層給） */
export function newElementId(): string {
  return `el-${nanoid(8)}`
}

export interface DirectorSceneFileLite {
  plans?: DirectorPlan[]
  elements?: DirectorElement[]
  [key: string]: unknown
}

/** kunpeng resolveShot：顯式 shot_id 優先，否則 active_shot_id，否則首鏡頭 */
export function resolveShot(state: Record<string, unknown>, plan: DirectorPlan, shotId?: unknown): DirectorSequenceShot {
  const id = String(shotId ?? "")
  const activeShotId = state.active_shot_id as string | null | undefined
  const shot =
    (id ? plan.shots.find((item) => item.id === id) : undefined) ??
    (activeShotId ? plan.shots.find((item) => item.id === activeShotId) : undefined) ??
    plan.shots[0]
  if (!shot) throw new Error("找不到目标镜头")
  return shot
}

/** kunpeng resolveAction 文案逐字 */
export function resolveAction(shot: DirectorSequenceShot, actionId: unknown): DirectorActionClip {
  const action = shot.actions.find((item) => item.id === String(actionId ?? ""))
  if (!action) throw new Error(`镜头 ${shot.id} 中找不到动作 ${String(actionId ?? "")}`)
  return action
}

export function elementState(shot: DirectorSequenceShot, element: DirectorElement): DirectorElementState {
  return (
    shot.elementStates[element.id] ?? {
      position: element.position,
      rotationDeg: element.rotationDeg,
      scale: element.scale,
      visible: element.visible,
    }
  )
}

export function absoluteFrame(shot: DirectorSequenceShot, localSec: number): number {
  return Math.round((shot.startSec + localSec) * FPS)
}

/** 工程幀 → 絕對秒（wheel project_frame 語義：Math.round(localSec*FPS) 反解） */
export function projectFrameToSec(plan: DirectorPlan, projectFrame: unknown): number {
  return Math.round(num(projectFrame, 0, 0, Math.round(planDuration(plan) * FPS))) / FPS
}

/** kunpeng kf-<nanoid(7)> 逐字（motion/camera K 帧 id 前缀；gateway add/update op 不生成 K 帧 id） */
export function newKfId(): string {
  return `kf-${nanoid(7)}`
}

/** kunpeng ckf-<nanoid(7)> 逐字（摄影机 K 帧 id 前缀） */
export function newCkfId(): string {
  return `ckf-${nanoid(7)}`
}

/** guard throw → fail()：本地守衛 throw（無 status）= 參數/語義錯；gateway 錯透傳 */
export function guardFail(e: unknown): { title: string; output: string } {
  if (e instanceof Error && !(e as { status?: number }).status) {
    return fail("director_invalid_args", e.message)
  }
  return directorFail(e)
}

/** 幀數參數 → 秒（wheel FPS=24 慣例，addShot/updateShot duration_frames 同口徑） */
export function framesToSec(frames: number): number {
  return frames / FPS
}

// ── 3) R1 驗屍修復輔助（2026-09-03）──────────────────────────────────────────

/** 2026-09-03 驗屍修復 R1-#5：動作 project_frame 越界錯誤帶範圍
 * （該動作的絕對工程幀區間 + 鏡頭內幀區間，從動作 startSec/durationSec 換算，24fps） */
export function actionFrameRangeHint(projectFrame: number, shotStartSec: number, actionStartSec: number, actionDurationSec: number): string {
  const frame = Math.round(projectFrame)
  const start = Math.round((shotStartSec + actionStartSec) * FPS)
  const end = Math.round((shotStartSec + actionStartSec + actionDurationSec) * FPS)
  const inStart = Math.round(actionStartSec * FPS)
  const inEnd = Math.round((actionStartSec + actionDurationSec) * FPS)
  return `project_frame ${frame} 不在该动作片段范围内（该动作 project_frame ${start}-${end}，即镜头内 ${inStart}-${inEnd}）`
}

/** R1-#5：鏡頭級 project_frame 越界錯誤帶範圍（攝影機 K 幀用） */
export function shotFrameRangeHint(projectFrame: number, shotStartSec: number, shotDurationSec: number): string {
  const frame = Math.round(projectFrame)
  const start = Math.round(shotStartSec * FPS)
  const end = Math.round((shotStartSec + shotDurationSec) * FPS)
  return `project_frame ${frame} 不在该镜头范围内（该镜头 project_frame ${start}-${end}）`
}
