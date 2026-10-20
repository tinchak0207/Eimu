import type { DirectorActionClip, DirectorElement, DirectorPlan, DirectorSceneFile, DirectorSequenceShot, Vec3 } from "../../lib/director-engine/types"
import { DIRECTOR_CAPABILITIES } from "./director-types"
import type { DirectorCapabilities, DirectorDoc, DirectorHealth } from "./director-types"
import { DirectorValidationError } from "./director-types"
import { appendLog, assertSessionId, clone, loadCurrent, pruneVersions, snapshotDoc, withSessionLock, writeCurrent, writeVersion } from "./director-store"
import { applyDirectorOp, requiresPlan } from "./director-ops"
import type { DirectorOp } from "./director-ops"
import { activePlanOf, countsOf, emitDirectorDone, healthOf, renderSchematics } from "./director-emit"

// ── 对外 API（spec §3 六条路由的服务层） ─────────────────────────────────────

/** wheel save() 产物形状（DirectorSceneFile v2）——spec §3 GET /state 出参 project 栏位 */
function sceneFileOf(doc: DirectorDoc): DirectorSceneFile {
  return {
    version: 2,
    elements: doc.elements,
    groups: doc.groups,
    plans: doc.plans,
    activePlanId: doc.activePlanId,
    aspect: doc.aspect,
    origin: doc.origin,
    exports: doc.exports,
    updatedAt: Date.parse(doc.updated_at) || Date.now(),
  }
}

/**
 * 2026-09-03 验尸修复 R1-#1：state 分级输出。
 * 极限会话实锤（fd22bd6e）：GET /state project 载荷 55KB，joints（动作 K 帧内嵌 10+ 关节座标）
 * 占 44%，agent 覆核被迫派子代理落盘定点查。summary 模式：保留 plan/shots 结构与每个 action 的
 * {id, elementId, action, startSec, durationSec, from, to, keyframe_count, 首末位置}、
 * cameraKeyframes 摘要（id/帧位/位置）、health/issues/counts；剥除所有 joints 与 keyframes 阵列。
 * 默认仍是 full（前端 viewport 的 evaluateDirectorFrame 需要完整 keyframes，兼容零风险）；
 * 工具层 director_get_state 显式传 ?mode=summary（R2 跟进）。
 */
export type DirectorStateMode = "summary" | "full"

/** summary 模式动作摘要（keyframes 阵列 → keyframe_count + 首末位置） */
export interface DirectorActionSummary {
  id: string
  elementId: string
  action: DirectorActionClip["action"]
  startSec: number
  durationSec: number
  from: Vec3
  to: Vec3
  locked?: boolean
  intensity?: number
  templateId?: string
  keyframe_count: number
  first_position: Vec3
  last_position: Vec3
}

export interface DirectorShotSummary extends Omit<DirectorSequenceShot, "actions" | "cameraKeyframes"> {
  actions: DirectorActionSummary[]
  cameraKeyframes: Array<{ id: string; timeSec: number; position: Vec3 }>
}

export type DirectorStateSummary = Omit<DirectorSceneFile, "plans" | "groups"> & {
  /** R3-⑤：群组进 state 两态；summary 带 id/name/element_ids（elementIds 同值保留，兼容 camel 读法） */
  groups: Array<{ id: string; name: string; elementIds: string[]; element_ids: string[] }>
  plans: Array<Omit<DirectorPlan, "shots"> & { shots: DirectorShotSummary[] }>
}

function summarizeAction(action: DirectorActionClip): DirectorActionSummary {
  const keyframes = [...(action.keyframes ?? [])].sort((a, b) => a.timeSec - b.timeSec)
  const first = keyframes[0]?.position ?? action.from
  const last = keyframes.length ? keyframes[keyframes.length - 1].position ?? action.to : action.to
  return {
    id: action.id,
    elementId: action.elementId,
    action: action.action,
    startSec: action.startSec,
    durationSec: action.durationSec,
    from: clone(action.from),
    to: clone(action.to),
    ...(action.locked !== undefined ? { locked: action.locked } : {}),
    ...(action.intensity !== undefined ? { intensity: action.intensity } : {}),
    ...(action.templateId !== undefined ? { templateId: action.templateId } : {}),
    keyframe_count: keyframes.length,
    first_position: clone(first),
    last_position: clone(last),
  }
}

function summarizeSceneFile(scene: DirectorSceneFile): DirectorStateSummary {
  return {
    ...scene,
    // R3-⑤：summary 群组带双写法成员清单（契约 element_ids；elementIds 为存储原形）
    groups: (scene.groups as Array<{ id: string; name: string; elementIds?: string[] }>).map((g) => ({
      id: g.id,
      name: g.name,
      elementIds: [...(g.elementIds ?? [])],
      element_ids: [...(g.elementIds ?? [])],
    })),
    // mannequin 元素的 joints 关节覆盖属于大体积低频栏位，summary 剥除（poseId 保留）
    elements: scene.elements.map((element) => (element.kind === "mannequin" ? (({ joints: _joints, ...rest }) => rest)(element) as DirectorElement : element)) as DirectorElement[],
    plans: scene.plans.map((plan) => ({
      ...plan,
      shots: plan.shots.map((shot) => {
        const { actions, cameraKeyframes, ...rest } = shot
        return {
          ...rest,
          actions: actions.map(summarizeAction),
          cameraKeyframes: (cameraKeyframes ?? []).map((keyframe) => ({ id: keyframe.id, timeSec: keyframe.timeSec, position: clone(keyframe.position) })),
        } as DirectorShotSummary
      }),
    })),
  }
}

export interface DirectorStateResult {
  ok: true
  /** R1-#1：本回包的分级（默认 full） */
  mode: DirectorStateMode
  project: DirectorSceneFile | DirectorStateSummary
  active_plan_id: string | null
  active_shot_id: string | null
  health: DirectorHealth
  counts: { shots: number; elements: number; actions: number }
  revision: number
  initialized: boolean
  /** R3-②：能力清单（action/camera/pose 模板 + op 集 + 群组/导出边界），summary/full 两态都带 */
  capabilities: DirectorCapabilities
}

export async function getDirectorState(sid: string, mode: DirectorStateMode = "full"): Promise<DirectorStateResult> {
  assertSessionId(sid)
  const doc = await loadCurrent(sid)
  if (!doc) {
    return {
      ok: true,
      mode,
      project: {
        version: 2,
        elements: [],
        groups: [],
        plans: [],
        activePlanId: null,
        aspect: "16:9",
        origin: { kind: "free", title: "" },
        exports: [],
        updatedAt: Date.now(),
      },
      active_plan_id: null,
      active_shot_id: null,
      health: { ok: true, issues: [] },
      counts: { shots: 0, elements: 0, actions: 0 },
      revision: 0,
      initialized: false,
      capabilities: DIRECTOR_CAPABILITIES,
    }
  }
  const scene = sceneFileOf(doc)
  return {
    ok: true,
    mode,
    project: mode === "summary" ? summarizeSceneFile(scene) : scene,
    active_plan_id: doc.activePlanId,
    active_shot_id: doc.activeShotId,
    health: healthOf(doc),
    counts: countsOf(doc),
    revision: doc.revision,
    initialized: doc.plans.length > 0,
    capabilities: DIRECTOR_CAPABILITIES,
  }
}

export interface ApplyDirectorOpsResult {
  ok: true
  project: DirectorSceneFile
  revision: number
  changed: string[]
  emitted: boolean
  /**
   * 2026-09-03 验尸修复 R3-⑤（群组写路径契约，工具层按此调用）：批内含 addGroup 时回
   * 新建群组 `{id, name, element_ids}`；含 removeGroup 时回 `removed_group_id`。无则不带。
   */
  group?: { id: string; name: string; element_ids: string[] }
  removed_group_id?: string
}

/**
 * 一批 ops：变更类 op 先 checkpoint（wheel mutation 惯例）后套用；有实际变化 → revision+1、
 * 写 current + versions/<n>.json + log.jsonl、按策略裁剪、emit director.done + canvas.node.*。
 * spec §3：store 未初始化 → DirectorNotInitializedError（409 director_not_initialized）。
 */
export async function applyDirectorOps(
  sid: string,
  ops: DirectorOp[],
  reason = "",
): Promise<ApplyDirectorOpsResult> {
  assertSessionId(sid)
  if (!Array.isArray(ops) || ops.length === 0) throw new DirectorValidationError("ops must be a non-empty array")
  if (ops.length > 200) throw new DirectorValidationError("too many ops in one batch (max 200)")

  return withSessionLock(sid, async () => {
    const loaded = await loadCurrent(sid)
    // 空工程文档壳（无 doc 时用；wheel open() 语义：kunpeng directorStore.open() 对空目录首开即播种）
    const doc: DirectorDoc = loaded ?? {
      session_id: sid,
      revision: 0,
      version: 2,
      elements: [],
      groups: [],
      plans: [],
      activePlanId: null,
      activeShotId: null,
      aspect: "16:9",
      origin: { kind: "free", title: "" },
      exports: [],
      currentTimeSec: 0,
      playing: false,
      undoStack: [],
      redoStack: [],
      updated_at: new Date(0).toISOString(),
    }
    // 2026-09-03 验尸修复 R3-①（P0：无 plan 即播种）：旧门禁只在 `!current`（无 doc）时 auto-seed，
    // 首 op 为 addElement 时 doc 建了但 plans 空、activePlanId:null → 后续需 plan 的 op（addShot 等）
    // 全撞「当前没有活动方案」死路且无出口（REPORT P0-1：agent 连续撞墙 3 次）。
    // 新守卫：只要「无 activePlan（plans 空）」且本批 ops 含 requiresPlan 且批内无自建 plan op（addPlan/
    // replacePlans）→ 注入 bare addPlan（R1-#3 的 bare 壳语义，不带模板镜头垃圾）。
    // 已有 plan 的用户（前端已建方案）activePlanOf 非 null → 零影响。
    const hasPlanCreator = ops.some((op) => op.op === "addPlan" || op.op === "replacePlans")
    const needsSeed = activePlanOf(doc) === null && !hasPlanCreator && ops.some((op) => requiresPlan(op))
    const ops2 = needsSeed ? ([{ op: "addPlan", plan: { name: "未命名方案", shots: [] } } as DirectorOp, ...ops] as DirectorOp[]) : ops
    return applyWithinLock(sid, doc, ops2, reason)
  })
}

async function applyWithinLock(
  sid: string,
  current: DirectorDoc,
  ops: DirectorOp[],
  reason: string,
): Promise<ApplyDirectorOpsResult> {
  const draft = clone(current)
  const changed: string[] = []
  for (const op of ops) {
    // wheel 惯例：变更类 mutation 先 checkpoint（快照去重 + 上限 40，同 checkpoint()）
    const mutating = !["undo", "redo", "checkpoint", "save", "setCurrentTime", "setPlaying"].includes(op.op)
    if (mutating) {
      const snap = snapshotDoc(draft)
      const previous = draft.undoStack[draft.undoStack.length - 1]
      if (!(previous && JSON.stringify(previous) === JSON.stringify(snap))) {
        draft.undoStack = [...draft.undoStack.slice(-39), snap]
        draft.redoStack = []
      }
    }
    changed.push(applyDirectorOp(draft, op))
  }

  // R3-⑤：群组 op 响应契约——从 changed 提取本批 addGroup/removeGroup 结果
  // （changed 与 ops 逐位对齐；批内多个同类 op 取最后一个）。
  let group: ApplyDirectorOpsResult["group"]
  let removed_group_id: string | undefined
  ops.forEach((op, i) => {
    const c = changed[i] ?? ""
    if (op.op === "addGroup" && c.startsWith("group_added:")) {
      const gid = c.slice("group_added:".length)
      const g = draft.groups.find((item) => item.id === gid)
      if (g) group = { id: g.id, name: g.name, element_ids: [...g.elementIds] }
    }
    if (op.op === "removeGroup" && c.startsWith("group_removed:")) {
      removed_group_id = c.slice("group_removed:".length)
    }
  })

  if (JSON.stringify(draft) === JSON.stringify(current)) {
    // 幂等 op：不 bump 版本、不写日志（timeline.ts 同款），但仍回当前状态
    return { ok: true, project: sceneFileOf(current), revision: current.revision, changed, emitted: false, ...(group ? { group } : {}), ...(removed_group_id ? { removed_group_id } : {}) }
  }

  draft.session_id = sid
  draft.revision = current.revision + 1
  draft.updated_at = new Date().toISOString()

  const schematic = renderSchematics(draft)
  await writeCurrent(sid, draft)
  await writeVersion(sid, draft)
  await appendLog(sid, {
    at: draft.updated_at,
    action: ops.map((o) => o.op).join("+") + (reason ? ` (${reason})` : ""),
    revision: draft.revision,
    changed,
  })
  await pruneVersions(sid, draft.revision)

  emitDirectorDone(sid, draft, ops.map((o) => o.op).join("+"), schematic)
  return { ok: true, project: sceneFileOf(draft), revision: draft.revision, changed, emitted: true, ...(group ? { group } : {}), ...(removed_group_id ? { removed_group_id } : {}) }
}
