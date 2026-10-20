import { nanoid } from "nanoid"
import type { AspectId, DirectorActionClip, DirectorElement, DirectorElementState, DirectorMotionKeyframe, DirectorPlan, DirectorSequenceShot, Vec3 } from "../../lib/director-engine/types"
import { vec3 } from "../../lib/director-engine/types"
import { createMotionKeyframes } from "../../lib/director-engine/motionTemplates"
import { evaluateDirectorFrame } from "../../lib/director-engine/playback"
import { KNOWN_OPS } from "./director-types"
import type { DirectorDoc, DirectorGroup } from "./director-types"
import { DirectorBlockedError, DirectorNotFoundError, DirectorValidationError } from "./director-types"
import { clone, elementStateMap, normalizeShotTimes, snapshotDoc, stateOfElement, upgradePlanKeyframes } from "./director-store"

// ── op 联合（~20 个纯文档操作；语义逐一对齐 directorStore mutation + directorTools 守卫） ──

/** addAction 入参（kunpeng upsert_action 的新建路径；栏位名走 HTTP snake_case） */
export interface DirectorActionSeed {
  element_id: string
  action: DirectorActionClip["action"]
  start_sec?: number
  duration_sec: number
  /** 2026-09-03 R1-#2：显式起点覆盖；省略时默认取「前一镜末帧（或同镜头前序动作结束时）」求解位置 */
  from?: Vec3
  to?: Vec3
  from_rotation_deg?: Vec3
  to_rotation_deg?: Vec3
  intensity?: number
  locked?: boolean
  /** 2026-09-03 验尸修复 R3-⑥：同元素同镜动作时间重叠时强制覆盖（默认 false → 重叠报错） */
  force?: boolean
}

export type DirectorOp =
  | { op: "addElement"; element: DirectorElement }
  | { op: "removeElements"; ids: string[] }
  | { op: "updateShotElementState"; shot_id: string; element_id: string; patch: Partial<DirectorElementState> }
  | { op: "addShot"; shot?: Partial<DirectorSequenceShot> }
  | { op: "updateShot"; shot_id: string; patch: Partial<DirectorSequenceShot> }
  | { op: "removeShot"; shot_id: string }
  | { op: "reorderShot"; shot_id: string; to_index: number }
  | { op: "addPlan"; plan?: Partial<DirectorPlan> }
  | { op: "updatePlan"; plan_id: string; patch: { name?: string; summary?: string } }
  | { op: "removePlan"; plan_id: string }
  | { op: "duplicatePlan"; plan_id: string }
  | { op: "replacePlans"; plans: DirectorPlan[] }
  | { op: "setActivePlan"; plan_id: string }
  | { op: "setActiveShot"; shot_id: string | null }
  | { op: "setCurrentTime"; time_sec: number }
  | { op: "setPlaying"; playing: boolean }
  | { op: "addAction"; shot_id: string; action: DirectorActionSeed }
  | { op: "updateAction"; shot_id: string; action_id: string; patch: Partial<DirectorActionClip> }
  | { op: "removeAction"; shot_id: string; action_id: string }
  | { op: "set_lock"; target: "action" | "motion_keyframe" | "camera_keyframe"; shot_id: string; action_id?: string; keyframe_id?: string; locked: boolean }
  | { op: "delete_element"; element_id: string }
  | { op: "delete_action"; shot_id: string; action_id: string; override_locked?: boolean }
  | { op: "delete_keyframe"; target: "motion_keyframe" | "camera_keyframe"; shot_id: string; action_id?: string; keyframe_id: string; override_locked?: boolean }
  | { op: "addGroup"; name: string; element_ids: string[] }
  | { op: "removeGroup"; group_id: string }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "checkpoint" }
  | { op: "save" }

/** 首个 op 需要已初始化工程吗？addPlan/addElement/save/undo/redo/checkpoint/播放控制/群组可在空工程上跑。 */
export function requiresPlan(op: DirectorOp): boolean {
  return !["addPlan", "addElement", "save", "undo", "redo", "checkpoint", "setCurrentTime", "setPlaying", "replacePlans", "addGroup", "removeGroup"].includes(op.op)
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !isFinite(v)) throw new DirectorValidationError(`${name} must be a finite number`)
  return v
}
export function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new DirectorValidationError(`${name} must be a non-empty string`)
  return v
}

/**
 * 2026-09-03 验尸修复 R3-⑦（错误文案卫生）：manage_plan 系 op 的目标方案 id 校验。
 * 极限评测实锤（REPORT P0-1/⑦）：无效/空 plan_id 旧路径落 `str()` 回英文 "plan_id must be a
 * non-empty string"，或工具层拼出「找不到方案 」（尾空格+空 id）。统一为中文 not_found：
 * 空 id → 「找不到方案（未提供有效的 plan_id）」；非空但不存在 → 呼叫点回「找不到方案 <id>」（无尾空格）。
 */
function requirePlanId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : ""
  if (!id) throw new DirectorNotFoundError("找不到方案（未提供有效的 plan_id）")
  return id
}

/** R3-⑥：动作时间区间可读化（秒，保留两位） */
function actionRangeLabel(startSec: number, durationSec: number): string {
  const round = (n: number) => Math.round(n * 100) / 100
  return `${round(startSec)}-${round(startSec + durationSec)}s`
}

/** kunpeng directorStore.ts L138-166 makeSequenceShot 逐行等价 */
function makeSequenceShot(
  index: number,
  startSec: number,
  durationSec: number,
  aspect: AspectId,
  elements: DirectorElement[],
): DirectorSequenceShot {
  const angles = [0, -22, 20, -8]
  const distances = [7.2, 5.2, 4.2, 6.0]
  const yaw = (angles[index % angles.length] * Math.PI) / 180
  const distance = distances[index % distances.length]
  const position = vec3(Math.sin(yaw) * distance, index === 2 ? 1.7 : 2.3, Math.cos(yaw) * distance)
  const target = vec3(0, 1, 0)
  return {
    id: `shot-${nanoid(7)}`,
    name: `镜头 ${index + 1}`,
    position,
    target,
    fov: index === 2 ? 34 : index === 1 ? 42 : 50,
    aspect,
    createdAt: Date.now(),
    startSec,
    durationSec,
    cameraEnd: { position: clone(position), target: clone(target), fov: index === 2 ? 34 : index === 1 ? 42 : 50 },
    cameraMove: "static",
    elementStates: elementStateMap(elements),
    actions: [],
  }
}

/** kunpeng directorStore.ts L168-177 makeDefaultPlan 逐行等价 */
export function makeDefaultPlan(elements: DirectorElement[], aspect: AspectId, name = "稳定叙事"): DirectorPlan {
  const duration = 3.75
  return {
    id: `plan-${nanoid(7)}`,
    name,
    summary: "15 秒 · 4 个镜头 · 白模动态预演",
    createdAt: Date.now(),
    shots: Array.from({ length: 4 }, (_, index) => makeSequenceShot(index, index * duration, duration, aspect, elements)),
  }
}

/**
 * 2026-09-03 验尸修复 R1-#3：bare 方案壳（shots: []，摘要同步空工程口径）。
 * 工具触发的 auto-seed 用此壳——极限会话实锤：makeDefaultPlan 播种的 4 个模板镜头
 * 在 agent 从零搭建时要逐个 delete 清垃圾。makeDefaultPlan 模板语义保留给前端 open()（二期）。
 */
function makeBarePlan(name = "未命名方案"): DirectorPlan {
  return {
    id: `plan-${nanoid(7)}`,
    name,
    summary: "0 个镜头 · 0 秒",
    createdAt: Date.now(),
    shots: [],
  }
}

/** 2026-09-03 验尸修复 R1-#6：方案摘要动态口径（镜头数 · 总秒数） */
function planSummaryOf(plan: DirectorPlan): string {
  const totalSec = Math.round(plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0) * 100) / 100
  return `${plan.shots.length} 个镜头 · ${totalSec} 秒`
}

/** R1-#6：结构性镜头操作后同步所在方案 summary */
function withSyncedSummary(plan: DirectorPlan): DirectorPlan {
  return { ...plan, summary: planSummaryOf(plan) }
}

/**
 * 2026-09-03 验尸修复 R3-④（propose_plans 尊重镜头数）：从 instruction 解析「N 个镜头 / N 镜头 / N 镜」。
 * 极限评测实锤（REPORT P1-5）：指令明写六镜，提案 4 镜，agent 手补 2。
 * 正则照 spec 原样：(\d+)\s*[个个]?\s*镜头|(\d+)\s*镜；解析不出回 null（维持模板默认）。
 */
export function parseShotCountFromInstruction(instruction: string): number | null {
  const m = instruction.match(/(\d+)\s*[个个]?\s*镜头|(\d+)\s*镜/)
  if (!m) return null
  const n = Number(m[1] ?? m[2])
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null
}

/** R3-④：克隆镜头并换全套 id（循环凑数时避免 id 重复；名称统一「镜头 N」口径）。 */
function cloneShotFreshIds(shot: DirectorSequenceShot, index: number): DirectorSequenceShot {
  return {
    ...clone(shot),
    id: `shot-${nanoid(7)}`,
    name: `镜头 ${index + 1}`,
    createdAt: Date.now(),
    actions: shot.actions.map((action) => ({
      ...clone(action),
      id: `act-${nanoid(7)}`,
      keyframes: action.keyframes?.map((keyframe) => ({ ...keyframe, id: `kf-${nanoid(7)}` })),
    })),
    cameraKeyframes: shot.cameraKeyframes?.map((keyframe) => ({ ...keyframe, id: `ckf-${nanoid(7)}` })),
  }
}

/**
 * R3-④：把方案镜头序列调整为 count 个——不足循环模板序列凑数（克隆换 id），超出截断；
 * 之后 normalizeShotTimes 重排 startSec。空序列无从循环，原样返回。
 */
export function resizePlanShotCount(plan: DirectorPlan, count: number): DirectorPlan {
  if (!Number.isInteger(count) || count < 1) return plan
  if (plan.shots.length === 0 || plan.shots.length === count) return plan
  const source = plan.shots
  const shots: DirectorSequenceShot[] = []
  for (let i = 0; i < count; i++) {
    const src = source[i % source.length]
    shots.push(i < source.length ? src : cloneShotFreshIds(src, i))
  }
  return normalizeShotTimes({ ...plan, shots })
}

/**
 * 2026-09-03 验尸修复 R1-#2：动作起点接续求解（见 addAction 注释）。
 * 用 evaluateDirectorFrame 在目标时刻解算该元素位置：
 * 同镜头前序动作 → 动作 startSec 时刻；否则上一镜末帧（末帧前 1ms 落在前镜内）；
 * 首镜头无前序 → 回退 fallback（elementStates/element.position，现状语义）。
 */
function solvedFromPosition(plan: DirectorPlan, elements: DirectorElement[], shot: DirectorSequenceShot, elementId: string, startSec: number, fallback: Vec3): Vec3 {
  const hasEarlierAction = shot.actions.some((action) => action.elementId === elementId && action.startSec <= startSec + 1e-6)
  let timeSec: number | null = null
  if (hasEarlierAction) {
    timeSec = shot.startSec + Math.min(Math.max(0, startSec), Math.max(0, shot.durationSec - 0.001))
  } else {
    const index = plan.shots.indexOf(shot)
    const previous = index > 0 ? plan.shots[index - 1] : null
    if (previous) timeSec = previous.startSec + Math.max(0, previous.durationSec - 0.001)
  }
  if (timeSec === null) return fallback
  try {
    const frame = evaluateDirectorFrame(plan, elements, timeSec)
    const solved = frame?.elements.find((item) => item.id === elementId)?.position
    return solved ? clone(solved) : fallback
  } catch {
    return fallback
  }
}

/** 2026-09-03 验尸修复 R1-#4：K 帧规整——按 timeSec 升幂重排 + 同帧去重（一个 24fps 帧槽内视为同帧）。
 * 真实会话弹跳实锤（fd22bd6e rev49/55「step-back 末帧时间轴异常，重建干净版本」）：
 * 用户 K 帧 t=1.0（位置 15,-2，提前到达语义）与模板填充 K 帧 t=1.025（11.4,-1.64，0.6 帧间隔）共存，
 * 回放位置 15,-2 → 11.4,-1.64 → 15,-2 来回弹跳；旧去重窗仅半帧（1/48）拦不住 0.6 帧间隔。
 * 本规整窗宽 = 1/24（同帧槽），同槽保留时间较早者（保住「提前到达」意图；模板残留填充丢弃）。
 * 意图感知的精细去重（用户帧 next 优先，一帧窗）在工具层 set_motion_keyframe，先于本规整执行。 */
const KF_DEDUPE_SEC = 1 / 24

function normalizeMotionKeyframes(keyframes: DirectorMotionKeyframe[]): DirectorMotionKeyframe[] {
  const sorted = keyframes
    .filter((keyframe) => keyframe && typeof keyframe.timeSec === "number" && Number.isFinite(keyframe.timeSec))
    .sort((a, b) => a.timeSec - b.timeSec)
  const out: DirectorMotionKeyframe[] = []
  for (const keyframe of sorted) {
    const previous = out[out.length - 1]
    if (previous && keyframe.timeSec - previous.timeSec < KF_DEDUPE_SEC) {
      // 人工锁定帧永不丢弃：同帧槽撞上锁定帧时保留锁定者
      if (!previous.locked && keyframe.locked) out[out.length - 1] = keyframe
      continue
    }
    out.push(keyframe)
  }
  return out
}

/**
 * 单 op 套用（draft 就地修改；语义注释标 wheel mutation 名；错误文案全简体，照 directorTools）。
 * 回传 changed 摘要（log.jsonl changed 栏位）。
 */
export function applyDirectorOp(doc: DirectorDoc, op: DirectorOp): string {
  switch (op.op) {
    // wheel addElement：push + 全 plan 全 shot elementStates 补 baseState
    // （API 边界防御：部分形状补默认——wheel 假设 UI 工厂传完整元素，裸 API/agent 补丁层可能缺栏，
    // 不补会在 clone(undefined) 处炸 JSON.parse）
    case "addElement": {
      const raw = op.element
      if (!raw || typeof raw.id !== "string") throw new DirectorValidationError("element.id is required")
      if (!raw.kind) throw new DirectorValidationError("element.kind is required")
      const element = {
        ...raw,
        position: raw.position ?? vec3(),
        rotationDeg: raw.rotationDeg ?? vec3(),
        scale: raw.scale ?? vec3(1, 1, 1),
        visible: raw.visible ?? true,
      } as DirectorElement
      if (doc.elements.some((e) => e.id === element.id)) throw new DirectorValidationError(`对象 ID 重复：${element.id}`)
      const baseState = stateOfElement(element)
      doc.elements.push(element)
      for (const plan of doc.plans) {
        for (const shot of plan.shots) {
          shot.elementStates[element.id] = clone(baseState)
        }
      }
      return `element:${element.id}`
    }
    // wheel removeElements（delete_element 为 director_delete target=element 路径，含存在性守卫）
    case "removeElements":
    case "delete_element": {
      const ids = op.op === "removeElements" ? op.ids : [op.element_id]
      if (!Array.isArray(ids) || ids.length === 0) throw new DirectorValidationError("ids must be a non-empty array")
      const remove = new Set(ids)
      for (const id of ids) {
        if (!doc.elements.some((e) => e.id === id)) throw new DirectorNotFoundError(`找不到对象 ${id}`)
      }
      doc.elements = doc.elements.filter((element) => !remove.has(element.id))
      for (const plan of doc.plans) {
        for (const shot of plan.shots) {
          shot.elementStates = Object.fromEntries(Object.entries(shot.elementStates).filter(([id]) => !remove.has(id)))
          shot.actions = shot.actions.filter((action) => !remove.has(action.elementId))
        }
      }
      return `elements:${ids.join(",")}`
    }
    // wheel updateShotElementState：全 plan 中目标 shot 的 elementStates 合并
    case "updateShotElementState": {
      const shotId = str(op.shot_id, "shot_id")
      const elementId = str(op.element_id, "element_id")
      if (!op.patch || typeof op.patch !== "object") throw new DirectorValidationError("patch is required")
      let hit = false
      for (const plan of doc.plans) {
        for (const shot of plan.shots) {
          if (shot.id !== shotId) continue
          hit = true
          const current = shot.elementStates[elementId]
          shot.elementStates[elementId] = {
            position: clone(op.patch.position ?? current?.position ?? vec3()),
            rotationDeg: clone(op.patch.rotationDeg ?? current?.rotationDeg ?? vec3()),
            scale: clone(op.patch.scale ?? current?.scale ?? vec3(1, 1, 1)),
            visible: op.patch.visible ?? current?.visible ?? true,
          }
        }
      }
      if (!hit) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      return `shot:${shotId} element:${elementId}`
    }
    // wheel addShot：目标=activePlan；追加后 normalizeShotTimes；activeShot 切新镜头
    case "addShot": {
      const plan = doc.plans.find((p) => p.id === doc.activePlanId)
      if (!plan) throw new DirectorNotFoundError("当前没有活动方案")
      const duration = op.shot?.durationSec ?? 3.75
      const start = plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0)
      const shot = { ...makeSequenceShot(plan.shots.length, start, duration, doc.aspect, doc.elements), ...(op.shot ?? {}), id: op.shot?.id ?? `shot-${nanoid(7)}` } as DirectorSequenceShot
      // R1-#6：结构变更后同步方案摘要
      doc.plans = doc.plans.map((item) => (item.id === plan.id ? withSyncedSummary(normalizeShotTimes({ ...item, shots: [...item.shots, shot] })) : item))
      doc.activeShotId = shot.id
      doc.currentTimeSec = start
      return `shot:${shot.id}`
    }
    // wheel updateShot：patch 合并 + durationSec 比例缩放 cameraKeyframes/actions + normalizeShotTimes
    case "updateShot": {
      const shotId = str(op.shot_id, "shot_id")
      if (!op.patch || typeof op.patch !== "object") throw new DirectorValidationError("patch is required")
      doc.plans = doc.plans.map((plan) => normalizeShotTimes({
        ...plan,
        shots: plan.shots.map((shot) => {
          if (shot.id !== shotId) return shot
          const next = { ...shot, ...clone(op.patch) } as DirectorSequenceShot
          const patch = op.patch as Partial<DirectorSequenceShot>
          if (patch.durationSec !== undefined && patch.durationSec > 0 && shot.durationSec > 0) {
            const ratio = patch.durationSec / shot.durationSec
            if (patch.cameraKeyframes === undefined && next.cameraKeyframes) next.cameraKeyframes = next.cameraKeyframes.map((keyframe) => ({ ...keyframe, timeSec: Math.min(patch.durationSec!, keyframe.timeSec * ratio) }))
            if (patch.actions === undefined) next.actions = next.actions.map((action) => ({ ...action, startSec: Math.min(patch.durationSec! - 0.2, action.startSec * ratio), durationSec: Math.min(patch.durationSec!, action.durationSec * ratio), keyframes: action.keyframes?.map((keyframe) => ({ ...keyframe, timeSec: keyframe.timeSec * ratio })) }))
          }
          return next
        }),
      }))
      return `shot:${shotId}`
    }
    // wheel removeShot：activePlan；至少留一镜头；normalizeShotTimes；activeShot 回退首镜头
    case "removeShot": {
      const shotId = str(op.shot_id, "shot_id")
      const plan = doc.plans.find((p) => p.id === doc.activePlanId)
      if (!plan) throw new DirectorNotFoundError("当前没有活动方案")
      if (plan.shots.length <= 1) throw new DirectorBlockedError("方案至少保留一个镜头")
      // R1-#6：结构变更后同步方案摘要
      doc.plans = doc.plans.map((item) => (item.id === plan.id ? withSyncedSummary(normalizeShotTimes({ ...item, shots: item.shots.filter((shot) => shot.id !== shotId) })) : item))
      if (doc.activeShotId === shotId) {
        const next = doc.plans.find((item) => item.id === plan.id)?.shots[0]
        doc.activeShotId = next?.id ?? null
        doc.currentTimeSec = next?.startSec ?? 0
      }
      return `shot:${shotId}`
    }
    // wheel reorderShot：splice + clamp + normalizeShotTimes
    case "reorderShot": {
      const shotId = str(op.shot_id, "shot_id")
      const toIndex = num(op.to_index, "to_index")
      doc.plans = doc.plans.map((plan) => {
        const index = plan.shots.findIndex((shot) => shot.id === shotId)
        if (index < 0) return plan
        const shots = [...plan.shots]
        const [shot] = shots.splice(index, 1)
        shots.splice(Math.max(0, Math.min(toIndex, shots.length)), 0, shot)
        // R1-#6：结构变更后同步方案摘要
        return withSyncedSummary(normalizeShotTimes({ ...plan, shots }))
      })
      return `shot:${shotId}`
    }
    // wheel addPlan：partial 覆盖；activePlan/activeShot 切过去
    // R1-#3：带 shots 阵列的 addPlan 以 bare 壳为基底（工具 auto-seed / 从零搭建语义，
    // 不再先造 4 个模板镜头再整体覆盖）；无 shots 参数维持 makeDefaultPlan 模板（前端 open() 二期）。
    case "addPlan": {
      const base = Array.isArray(op.plan?.shots) ? makeBarePlan(op.plan?.name) : makeDefaultPlan(doc.elements, doc.aspect, op.plan?.name)
      const plan = { ...base, ...(op.plan ?? {}), id: op.plan?.id ?? base.id } as DirectorPlan
      doc.plans = [...doc.plans, upgradePlanKeyframes(plan)]
      doc.activePlanId = plan.id
      doc.activeShotId = plan.shots[0]?.id ?? null
      doc.currentTimeSec = 0
      return `plan:${plan.id}`
    }
    // wheel updatePlan：name/summary patch（rename 语义，kunpeng manage_plan rename 同款守卫）
    case "updatePlan": {
      const planId = requirePlanId(op.plan_id)
      if (!op.patch || typeof op.patch !== "object") throw new DirectorValidationError("patch is required")
      if (op.patch.name === undefined && op.patch.summary === undefined) throw new DirectorValidationError("需要提供方案名称或摘要")
      if (!doc.plans.some((p) => p.id === planId)) throw new DirectorNotFoundError(`找不到方案 ${planId}`)
      doc.plans = doc.plans.map((plan) => (plan.id === planId ? { ...plan, ...clone(op.patch) } : plan))
      return `plan:${planId}`
    }
    // wheel removePlan：至少留一；activePlan 回退首方案
    case "removePlan": {
      const planId = requirePlanId(op.plan_id)
      if (doc.plans.length <= 1) throw new DirectorBlockedError("导演台至少保留一个方案")
      if (!doc.plans.some((p) => p.id === planId)) throw new DirectorNotFoundError(`找不到方案 ${planId}`)
      const plans = doc.plans.filter((plan) => plan.id !== planId)
      const active = doc.activePlanId === planId ? plans[0] : plans.find((plan) => plan.id === doc.activePlanId)
      doc.plans = plans
      doc.activePlanId = active?.id ?? null
      doc.activeShotId = active?.shots[0]?.id ?? null
      doc.currentTimeSec = 0
      return `plan:${planId}`
    }
    // wheel duplicatePlan：深拷贝 + 全 id 换新
    case "duplicatePlan": {
      const planId = requirePlanId(op.plan_id)
      const source = doc.plans.find((p) => p.id === planId)
      if (!source) throw new DirectorNotFoundError(`找不到方案 ${planId}`)
      const copy = clone(source)
      copy.id = `plan-${nanoid(7)}`
      copy.name = `${source.name} 副本`
      copy.createdAt = Date.now()
      copy.shots = copy.shots.map((shot) => ({
        ...shot,
        id: `shot-${nanoid(7)}`,
        actions: shot.actions.map((action) => ({ ...action, id: `act-${nanoid(7)}`, keyframes: action.keyframes?.map((keyframe) => ({ ...keyframe, id: `kf-${nanoid(7)}` })) })),
        cameraKeyframes: shot.cameraKeyframes?.map((keyframe) => ({ ...keyframe, id: `ckf-${nanoid(7)}` })),
      }))
      doc.plans = [...doc.plans, copy]
      doc.activePlanId = copy.id
      doc.activeShotId = copy.shots[0]?.id ?? null
      doc.currentTimeSec = 0
      return `plan:${copy.id}`
    }
    // wheel replacePlans：空列表拒绝；normalizeShotTimes；activePlan=首方案
    case "replacePlans": {
      if (!Array.isArray(op.plans) || op.plans.length === 0) throw new DirectorValidationError("plans must be a non-empty array")
      const next = clone(op.plans).map(upgradePlanKeyframes).map(normalizeShotTimes)
      doc.plans = next
      doc.activePlanId = next[0].id
      doc.activeShotId = next[0].shots[0]?.id ?? null
      doc.currentTimeSec = 0
      doc.playing = false
      return `plans:${next.length}`
    }
    // wheel setActivePlan：切方案 + activeShot=首镜头 + currentTime=0 + playing=false
    case "setActivePlan": {
      const planId = requirePlanId(op.plan_id)
      const plan = doc.plans.find((item) => item.id === planId)
      if (!plan) throw new DirectorNotFoundError(`找不到方案 ${planId}`)
      doc.activePlanId = planId
      doc.activeShotId = plan.shots[0]?.id ?? null
      doc.currentTimeSec = 0
      doc.playing = false
      return `plan:${planId}`
    }
    // wheel setActiveShot：跨方案找镜头；currentTime=该镜头 startSec；playing=false
    case "setActiveShot": {
      const shotId = op.shot_id === null ? null : str(op.shot_id, "shot_id")
      const shot = shotId ? doc.plans.flatMap((plan) => plan.shots).find((item) => item.id === shotId) : undefined
      doc.activeShotId = shotId
      doc.currentTimeSec = shot?.startSec ?? doc.currentTimeSec
      doc.playing = false
      return `shot:${shotId ?? "null"}`
    }
    // wheel setCurrentTime：Math.max(0, timeSec)
    case "setCurrentTime": {
      doc.currentTimeSec = Math.max(0, num(op.time_sec, "time_sec"))
      return `time:${doc.currentTimeSec}`
    }
    // wheel setPlaying
    case "setPlaying": {
      doc.playing = Boolean(op.playing)
      return `playing:${doc.playing}`
    }
    // wheel addAction：补 id/templateId/intensity/source/keyframes（createMotionKeyframes 轮子）
    case "addAction": {
      const shotId = str(op.shot_id, "shot_id")
      const seed = op.action
      if (!seed || typeof seed !== "object") throw new DirectorValidationError("action is required")
      const elementId = str(seed.element_id, "action.element_id")
      const actionId = str(seed.action, "action.action") as DirectorActionClip["action"]
      // R1-#2：定位所在方案（from 接续求解需要完整 plan 上下文）
      const containingPlan = doc.plans.find((plan) => plan.shots.some((item) => item.id === shotId))
      const shot = containingPlan?.shots.find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      const element = doc.elements.find((e) => e.id === elementId)
      if (!element) throw new DirectorNotFoundError(`找不到对象 ${elementId}`)
      const durationSec = num(seed.duration_sec, "action.duration_sec")
      const startSec = num(seed.start_sec ?? 0, "action.start_sec")
      const state = shot.elementStates[elementId]
      const fallback = state?.position ?? element.position
      // 2026-09-03 验尸修复 R1-#2：from 默认接续动线——极限会话实锤 12 次手工「起点锚定 S4 终点」：
      // 旧逻辑取 shot.elementStates（可能滞留全局初始位），跨镜动线每镜都要手工锚一次。
      // 新默认：a) 同镜头有更早动作 → 取该动作进行中/结束时的求解位置；
      //         b) 无同镜头前序但有上一镜 → 取上一镜末帧（startSec+durationSec 边界内）求解位置；
      //         c) 首镜头 → 维持现状（elementStates/element.position）。
      // 显式 from 参数永远可覆盖。
      const from = seed.from ? clone(seed.from) : solvedFromPosition(containingPlan!, doc.elements, shot, elementId, startSec, fallback)
      const to = seed.to ? clone(seed.to) : { ...from }
      // 2026-09-03 验尸修复 R3-⑥（动作重叠守卫）：同元素同镜头时间区间重叠 → 旧行为直接追加，
      // 回放时两动作抢同一元素造成位置跳变（REPORT P2-7：look-back+raise-hand 靠 agent 自查自删）。
      // 新默认：重叠回结构化错误带两动作 id+区间；force:true 保留旧覆盖出口。
      const clipId = `act-${nanoid(7)}`
      if (!seed.force) {
        const EPS = 1e-6
        const clash = shot.actions.find(
          (a) => a.elementId === elementId && startSec < a.startSec + a.durationSec - EPS && a.startSec < startSec + durationSec - EPS,
        )
        if (clash) {
          throw new DirectorValidationError(
            `同元素同镜头动作时间重叠（${clash.id} ${actionRangeLabel(clash.startSec, clash.durationSec)} vs ${clipId} ${actionRangeLabel(startSec, durationSec)}），请先 delete 或调整区间；确需覆盖传 force:true`,
          )
        }
      }
      const complete: DirectorActionClip = {
        id: clipId,
        elementId,
        action: actionId,
        startSec,
        durationSec,
        from,
        to,
        ...(seed.from_rotation_deg ? { fromRotationDeg: clone(seed.from_rotation_deg) } : {}),
        ...(seed.to_rotation_deg ? { toRotationDeg: clone(seed.to_rotation_deg) } : {}),
        templateId: actionId,
        intensity: num(seed.intensity ?? 1, "action.intensity"),
        locked: Boolean(seed.locked ?? false),
        source: "agent",
        keyframes: [],
      }
      complete.keyframes = createMotionKeyframes(complete.action, complete.durationSec, complete.from, complete.to, "agent")
      doc.plans = doc.plans.map((plan) => normalizeShotTimes({
        ...plan,
        shots: plan.shots.map((item) => (item.id === shotId ? { ...item, actions: [...item.actions, complete] } : item)),
      }))
      return `action:${complete.id}`
    }
    // wheel updateAction：patch 合并 + durationSec 比例缩放 keyframes
    case "updateAction": {
      const shotId = str(op.shot_id, "shot_id")
      const actionId = str(op.action_id, "action_id")
      const shot = doc.plans.flatMap((plan) => plan.shots).find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      if (!op.patch || typeof op.patch !== "object") throw new DirectorValidationError("patch is required")
      if (!shot.actions.some((a) => a.id === actionId)) throw new DirectorNotFoundError(`找不到动作 ${actionId}`)
      doc.plans = doc.plans.map((plan) => normalizeShotTimes({
        ...plan,
        shots: plan.shots.map((item) => (item.id !== shotId ? item : {
          ...item,
          actions: item.actions.map((action) => {
            if (action.id !== actionId) return action
            const patch = clone(op.patch) as Partial<DirectorActionClip>
            const next = { ...action, ...patch } as DirectorActionClip
            if (patch.durationSec !== undefined && patch.keyframes === undefined && action.durationSec > 0 && next.keyframes) {
              const ratio = Math.max(0.01, patch.durationSec) / action.durationSec
              next.keyframes = next.keyframes.map((keyframe) => ({ ...keyframe, timeSec: Math.min(patch.durationSec!, keyframe.timeSec * ratio) }))
            }
            // R1-#4：写入前规整（升幂重排 + 同帧去重；缩放 clamp 造成的同刻重复也在此收敛）
            if (next.keyframes) next.keyframes = normalizeMotionKeyframes(next.keyframes)
            return next
          }),
        })),
      }))
      return `action:${actionId}`
    }
    // wheel removeAction / delete_action（含 locked 守卫，kunpeng deleteTool 同款文案）
    case "removeAction":
    case "delete_action": {
      const shotId = str(op.shot_id, "shot_id")
      const actionId = str(op.action_id, "action_id")
      const shot = doc.plans.flatMap((plan) => plan.shots).find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      const action = shot.actions.find((a) => a.id === actionId)
      if (!action) throw new DirectorNotFoundError(`找不到动作 ${actionId}`)
      if (action.locked && (op as { override_locked?: boolean }).override_locked !== true) throw new DirectorBlockedError("动作已锁定，未删除")
      doc.plans = doc.plans.map((plan) => normalizeShotTimes({
        ...plan,
        shots: plan.shots.map((item) => (item.id === shotId ? { ...item, actions: item.actions.filter((a) => a.id !== actionId) } : item)),
      }))
      return `action:${actionId}`
    }
    // wheel set_lock（kunpeng lockTool）：action/motion_keyframe/camera_keyframe 三目标
    case "set_lock": {
      const shotId = str(op.shot_id, "shot_id")
      const locked = Boolean(op.locked)
      const target = str(op.target, "target")
      const shot = doc.plans.flatMap((plan) => plan.shots).find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      if (target === "action") {
        const actionId = str(op.action_id, "action_id")
        if (!shot.actions.some((a) => a.id === actionId)) throw new DirectorNotFoundError(`找不到动作 ${actionId}`)
        doc.plans = doc.plans.map((plan) => normalizeShotTimes({
          ...plan,
          shots: plan.shots.map((item) => (item.id === shotId ? { ...item, actions: item.actions.map((action) => (action.id === actionId ? { ...action, locked } : action)) } : item)),
        }))
        return `action:${actionId} locked:${locked}`
      }
      if (target === "motion_keyframe") {
        const actionId = str(op.action_id, "action_id")
        const keyframeId = str(op.keyframe_id, "keyframe_id")
        const action = shot.actions.find((a) => a.id === actionId)
        if (!action) throw new DirectorNotFoundError(`找不到动作 ${actionId}`)
        if (!(action.keyframes ?? []).some((item) => item.id === keyframeId)) throw new DirectorNotFoundError(`找不到人物关键帧 ${keyframeId}`)
        doc.plans = doc.plans.map((plan) => normalizeShotTimes({
          ...plan,
          shots: plan.shots.map((item) => (item.id !== shotId ? item : {
            ...item,
            actions: item.actions.map((a) => (a.id !== actionId ? a : { ...a, keyframes: a.keyframes?.map((frame) => (frame.id === keyframeId ? { ...frame, locked } : frame)) })),
          })),
        }))
        return `keyframe:${keyframeId} locked:${locked}`
      }
      if (target === "camera_keyframe") {
        const keyframeId = str(op.keyframe_id, "keyframe_id")
        if (!(shot.cameraKeyframes ?? []).some((item) => item.id === keyframeId)) throw new DirectorNotFoundError(`找不到摄影机关键帧 ${keyframeId}`)
        doc.plans = doc.plans.map((plan) => normalizeShotTimes({
          ...plan,
          shots: plan.shots.map((item) => (item.id !== shotId ? item : { ...item, cameraKeyframes: item.cameraKeyframes?.map((frame) => (frame.id === keyframeId ? { ...frame, locked } : frame)) })),
        }))
        return `keyframe:${keyframeId} locked:${locked}`
      }
      throw new DirectorValidationError("不支持的锁定目标")
    }
    // kunpeng deleteTool：motion_keyframe/camera_keyframe 删除（locked 守卫 + override）
    case "delete_keyframe": {
      const shotId = str(op.shot_id, "shot_id")
      const keyframeId = str(op.keyframe_id, "keyframe_id")
      const shot = doc.plans.flatMap((plan) => plan.shots).find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      if (op.target === "motion_keyframe") {
        const actionId = str(op.action_id, "action_id")
        const action = shot.actions.find((a) => a.id === actionId)
        if (!action) throw new DirectorNotFoundError(`找不到动作 ${actionId}`)
        const frame = action.keyframes?.find((item) => item.id === keyframeId)
        if (!frame) throw new DirectorNotFoundError(`找不到人物关键帧 ${keyframeId}`)
        if (frame.locked && op.override_locked !== true) throw new DirectorBlockedError("人物关键帧已锁定，未删除")
        doc.plans = doc.plans.map((plan) => normalizeShotTimes({
          ...plan,
          shots: plan.shots.map((item) => (item.id !== shotId ? item : {
            ...item,
            actions: item.actions.map((a) => (a.id !== actionId ? a : { ...a, keyframes: a.keyframes?.filter((k) => k.id !== keyframeId) })),
          })),
        }))
        return `keyframe:${keyframeId}`
      }
      if (op.target === "camera_keyframe") {
        const frame = shot.cameraKeyframes?.find((item) => item.id === keyframeId)
        if (!frame) throw new DirectorNotFoundError(`找不到摄影机关键帧 ${keyframeId}`)
        if (frame.locked && op.override_locked !== true) throw new DirectorBlockedError("摄影机关键帧已锁定，未删除")
        doc.plans = doc.plans.map((plan) => normalizeShotTimes({
          ...plan,
          shots: plan.shots.map((item) => (item.id !== shotId ? item : { ...item, cameraKeyframes: item.cameraKeyframes?.filter((k) => k.id !== keyframeId) })),
        }))
        return `keyframe:${keyframeId}`
      }
      throw new DirectorValidationError("不支持的删除目标")
    }
    // 2026-09-03 验尸修复 R3-⑤（群组写路径）：建群组——元素存在性校验 + 与 element.groupId 双向同步。
    // 一个元素至多属一个群组：入新组时从其他组的 elementIds 剔除，保持两处真相一致。
    case "addGroup": {
      const name = str(op.name, "name")
      const ids = Array.isArray(op.element_ids) ? op.element_ids : []
      if (ids.length === 0) throw new DirectorValidationError("element_ids 必须是非空数组")
      const unique = [...new Set(ids.map((id) => str(id, "element_ids[]")))]
      for (const id of unique) {
        if (!doc.elements.some((e) => e.id === id)) throw new DirectorNotFoundError(`找不到对象 ${id}`)
      }
      const group: DirectorGroup = { id: `group-${nanoid(7)}`, name, elementIds: unique }
      doc.groups = [...doc.groups, group]
      const memberSet = new Set(unique)
      for (const element of doc.elements) if (memberSet.has(element.id)) element.groupId = group.id
      doc.groups = doc.groups.map((g) => (g.id === group.id ? g : { ...g, elementIds: g.elementIds.filter((id) => !memberSet.has(id)) }))
      return `group_added:${group.id}`
    }
    // R3-⑤：删群组——只删组不删元素，成员 groupId 复位 null。
    case "removeGroup": {
      const groupId = str(op.group_id, "group_id")
      const group = doc.groups.find((g) => g.id === groupId)
      if (!group) throw new DirectorNotFoundError(`找不到群组 ${groupId}`)
      doc.groups = doc.groups.filter((g) => g.id !== groupId)
      for (const element of doc.elements) if (element.groupId === groupId) element.groupId = null
      return `group_removed:${groupId}`
    }
    // wheel undo：JSON 快照回滚
    case "undo": {
      const previous = doc.undoStack[doc.undoStack.length - 1]
      if (!previous) throw new DirectorBlockedError("没有可撤销的历史")
      doc.redoStack = [...doc.redoStack, snapshotDoc(doc)]
      doc.elements = clone(previous.elements)
      doc.groups = clone(previous.groups)
      doc.plans = clone(previous.plans)
      doc.activePlanId = previous.activePlanId
      doc.activeShotId = previous.activeShotId
      doc.undoStack = doc.undoStack.slice(0, -1)
      return "undo"
    }
    // wheel redo
    case "redo": {
      const next = doc.redoStack[doc.redoStack.length - 1]
      if (!next) throw new DirectorBlockedError("没有可重做的历史")
      doc.undoStack = [...doc.undoStack, snapshotDoc(doc)]
      doc.elements = clone(next.elements)
      doc.groups = clone(next.groups)
      doc.plans = clone(next.plans)
      doc.activePlanId = next.activePlanId
      doc.activeShotId = next.activeShotId
      doc.redoStack = doc.redoStack.slice(0, -1)
      return "redo"
    }
    // wheel checkpoint：同状态去重 + 上限 40
    case "checkpoint": {
      const next = snapshotDoc(doc)
      const previous = doc.undoStack[doc.undoStack.length - 1]
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return "checkpoint"
      doc.undoStack = [...doc.undoStack.slice(-39), next]
      doc.redoStack = []
      return "checkpoint"
    }
    // wheel save：写入路径统一走 applyWithinLock，此处仅标记
    case "save":
      return "save"
    default:
      throw new DirectorValidationError(`不支持的操作 ${(op as { op?: string }).op}，可用：${KNOWN_OPS.join("、")}`)
  }
}
