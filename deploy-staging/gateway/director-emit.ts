import { rm } from "node:fs/promises"
import { inspectDirectorPlan } from "./director-engine/playback"
import { renderTopViewSvg, renderCameraViewSvg } from "./director-engine/svgSchematic"
import { applyCanvasNodeCreated, applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import type { DirectorPlan, DirectorSequenceShot } from "./director-engine/types"
import { DirectorDoc, DirectorHealth } from "./director-types.ts"
import { assertSessionId, sessionDir, withSessionLock } from "./director-store.ts"

// ── 事件发射（index.ts 注入 emitToSession；模组层不 import index 防环） ─────────

/** index.ts 补丁注入：emitToSession(stateFor(sid), name, data)——含会话解析 */
export type DirectorEmitter = (sid: string, name: string, data: unknown) => void

let emitFn: DirectorEmitter | null = null

/** index.ts 补丁启动时呼叫一次 */
export function setDirectorEmitter(fn: DirectorEmitter): void {
  emitFn = fn
}

/** index.ts 补丁注入：resolveSession——sid（gateway UUID 或 opencode session id）→ 会话状态 */
export type DirectorSessionResolver = (sid: string) => { sessionId: string; apiKey: string } | undefined

export let resolveFn: DirectorSessionResolver | null = null

/** index.ts 补丁启动时呼叫一次 */
export function setDirectorSessionResolver(fn: DirectorSessionResolver): void {
  resolveFn = fn
}

function emitToSessionBySid(sid: string, name: string, data: unknown): void {
  try {
    emitFn?.(sid, name, data)
  } catch {
    /* 事件发射失败不挡写入路径 */
  }
}

// ── SVG / 健康 / 计数（spec §4 payload 组装；渲染轮子锚 = svgSchematic/shotDescription） ──

export function activePlanOf(doc: DirectorDoc): DirectorPlan | null {
  return doc.plans.find((p) => p.id === doc.activePlanId) ?? doc.plans[0] ?? null
}

export function healthOf(doc: DirectorDoc): DirectorHealth {
  const activePlan = activePlanOf(doc)
  if (!activePlan) return { ok: true, issues: [] }
  const issues = inspectDirectorPlan(activePlan, doc.elements)
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues: issues.map((i) => ({ code: i.id, message: i.message, shot_id: i.shotId || undefined })),
  }
}

export function renderSchematics(doc: DirectorDoc, plan?: DirectorPlan, shot?: DirectorSequenceShot): { top_view_svg: string; camera_view_svg: string } {
  const activePlan = plan ?? activePlanOf(doc)
  if (!activePlan) return { top_view_svg: "", camera_view_svg: "" }
  const activeShot = shot ?? activePlan.shots.find((s) => s.id === doc.activeShotId) ?? activePlan.shots[0]
  let top = ""
  let cam = ""
  try {
    top = renderTopViewSvg(activePlan, doc.elements, activeShot)
  } catch {
    top = ""
  }
  try {
    cam = activeShot ? renderCameraViewSvg(activeShot, doc.elements) : ""
  } catch {
    cam = ""
  }
  return { top_view_svg: top, camera_view_svg: cam }
}

export function countsOf(doc: DirectorDoc): { shots: number; elements: number; actions: number } {
  return {
    shots: doc.plans.reduce((s, p) => s + p.shots.length, 0),
    elements: doc.elements.length,
    actions: doc.plans.reduce((s, p) => s + p.shots.reduce((s2, sh) => s2 + sh.actions.length, 0), 0),
  }
}

/**
 * spec §4 director.done + canvas 侧（首次 canvas.node.created / 后续 canvas.node.updated，
 * node.type "director"；SVG 合计 >48KB 时 canvas metadata 省略 SVG，director.done 内不省）。
 */
const announcedDirectorNodes = new Set<string>()

export function emitDirectorDone(sid: string, doc: DirectorDoc, action: string, svg?: { top_view_svg: string; camera_view_svg: string }): void {
  const activePlan = activePlanOf(doc)
  const activeShot = activePlan?.shots.find((s) => s.id === doc.activeShotId) ?? activePlan?.shots[0] ?? null
  const schematic = svg ?? renderSchematics(doc)
  const health = healthOf(doc)
  emitToSessionBySid(sid, "director.done", {
    session_id: sid,
    revision: doc.revision,
    action,
    plan: activePlan ? { id: activePlan.id, name: activePlan.name, summary: activePlan.summary, shot_count: activePlan.shots.length } : null,
    active_shot: activeShot && activePlan
      ? { no: activePlan.shots.indexOf(activeShot) + 1, name: activeShot.name, duration_frames: Math.round(activeShot.durationSec * 24), camera_move: activeShot.cameraMove, shot_scale: activeShot.shotScale ?? null }
      : null,
    schematic: { top_view_svg: schematic.top_view_svg, camera_view_svg: schematic.camera_view_svg },
    health,
    counts: countsOf(doc),
  })
  const counts = countsOf(doc)
  const svgTotal = schematic.top_view_svg.length + schematic.camera_view_svg.length
  const includeSvg = svgTotal <= 48 * 1024
  const nodeId = `director-${sid}`
  const metadata: Record<string, unknown> = {
    pipelineCard: "director",
    directorSessionId: sid,
    planName: activePlan?.name ?? null,
    shotCount: counts.shots,
    healthOk: health.ok,
    // doc.revision 透传（刷新缺口修复）：已挂载视口比对 revision 变化重拉 state。
    revision: doc.revision,
    ...(includeSvg ? { topViewSvg: schematic.top_view_svg, cameraViewSvg: schematic.camera_view_svg } : {}),
  }
  if (!announcedDirectorNodes.has(nodeId)) {
    announcedDirectorNodes.add(nodeId)
    // 事件形状照 index.ts autoCreateCanvasUnit 的 canvas.node.created：{unit_id, node}
    emitToSessionBySid(sid, "canvas.node.created", {
      unit_id: nodeId,
      node: {
        id: nodeId,
        type: "director",
        title: activePlan ? `导演台 · ${activePlan.name}` : "导演台",
        position: { x: 0, y: 0 },
        width: 380,
        height: 300,
        metadata,
      },
    })
    // 2026-09-20 写穿：SSE 帧发出即落 canvasStates（同一 node 物件，幂等 upsert）。
    applyCanvasNodeCreated(sid, {
      unit_id: nodeId,
      node: {
        id: nodeId,
        type: "director",
        title: activePlan ? `导演台 · ${activePlan.name}` : "导演台",
        position: { x: 0, y: 0 },
        width: 380,
        height: 300,
        metadata,
      },
    })
  } else {
    // 事件形状照 index.ts emitCanvasResult 的 canvas.node.updated：{unit_id, node_id, patch}
    // 前端 reducer（canvas/reducer.ts reduceCanvasNodeUpdated）把 patch 摊平进 node.metadata，
    // 故 patch = metadata 栏位本身（不包 metadata 键）。
    emitToSessionBySid(sid, "canvas.node.updated", { unit_id: nodeId, node_id: nodeId, patch: metadata })
    // 2026-09-20 写穿：同一 patch 浅合并进快照节点 metadata（幂等 last-write-wins）。
    applyCanvasNodeUpdated(sid, { unit_id: nodeId, node_id: nodeId, patch: metadata })
  }
}
/** spec §3 POST /reset：清空会话导演工程（rm 目录 + 清 announced 记录 + 广播重置） */
export async function resetDirector(sid: string): Promise<{ ok: true }> {
  assertSessionId(sid)
  return withSessionLock(sid, async () => {
    await rm(sessionDir(sid), { recursive: true, force: true }).catch(() => {})
    announcedDirectorNodes.delete(`director-${sid}`)
    emitToSessionBySid(sid, "director.done", {
      session_id: sid,
      revision: 0,
      action: "reset",
      plan: null,
      active_shot: null,
      schematic: { top_view_svg: "", camera_view_svg: "" },
      health: { ok: true, issues: [] },
      counts: { shots: 0, elements: 0, actions: 0 },
    })
    return { ok: true as const }
  })
}