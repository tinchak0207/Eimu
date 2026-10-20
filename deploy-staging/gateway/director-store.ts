import { mkdir, readFile, readdir, rm, appendFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nanoid } from "nanoid"
import type { DirectorElement, DirectorElementState, DirectorPlan, DirectorSequenceShot } from "./director-engine/types"
import { createMotionKeyframes } from "./director-engine/motionTemplates"
import { DirectorDoc, DirectorLogEntry, DirectorNotFoundError, DirectorValidationError, HistorySnapshot } from "./director-types.ts"

// 与 gateway/index.ts 同值；env 可覆盖（测试用）。timeline.ts L29 同款。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
// 2026-09-03 验尸修复 R3-⑧（隔离）：director 存储根可经 DIRECTOR_DATA_ROOT 移出 agent 可读区。
// 极限评测实锤（REPORT P1-3）：agent bash 在 workspace/ 内可读「其他会话」的 director/<sid>/current.json
// （本场读了 3 个别案 JSON）——数据隔离面 + 诱惑 agent 抄别案。
// 默认值保持现状（WORKSPACE_DIR/director）兼容本地测试；VPS 部署时 env 指 workspace 外新址
// （如 /opt/agent-harness/director-data），迁移用 `sudo mv` 旧目录（保留在途会话数据）。
const DIRECTOR_DIR = process.env.DIRECTOR_DATA_ROOT || path.join(WORKSPACE_DIR, "director")

// 保留策略：最近 20 版 + 每 10 版里程碑版（v % 10 === 0），其余删（timeline.ts 同款）。
const KEEP_RECENT = 20
const MILESTONE_EVERY = 10

// proposals 暂存 TTL：30 分钟（kunpeng directorTools.ts pendingProposals 同款）。
export const PROPOSAL_TTL_MS = 30 * 60_000

// ── 存储层（timeline.ts L164-709 逐段照搬：timelines→director、Timeline→DirectorDoc） ──

export function assertSessionId(sid: string): void {
  if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) {
    throw new DirectorValidationError("session_id must match [A-Za-z0-9_-]{1,64}")
  }
}

export function sessionDir(sid: string): string {
  return path.join(DIRECTOR_DIR, sid)
}
function currentPath(sid: string): string {
  return path.join(sessionDir(sid), "current.json")
}
function versionPath(sid: string, v: number): string {
  return path.join(sessionDir(sid), "versions", `${v}.json`)
}
function logPath(sid: string): string {
  return path.join(sessionDir(sid), "log.jsonl")
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** kunpeng directorStore.ts L215-225 normalizeShotTimes 逐行等价 */
export function normalizeShotTimes(plan: DirectorPlan): DirectorPlan {
  let cursor = 0
  return {
    ...plan,
    shots: plan.shots.map((shot) => {
      const next = { ...shot, startSec: cursor, durationSec: Math.max(0.25, shot.durationSec) }
      cursor += next.durationSec
      return next
    }),
  }
}

/**
 * kunpeng directorStore.ts L227-245 upgradePlanKeyframes 逐行等价：
 * 旧工程镜头补 cameraKeyframes 首尾两帧；动作补 templateId/intensity/source/keyframes。
 */
export function upgradePlanKeyframes(plan: DirectorPlan): DirectorPlan {
  return {
    ...plan,
    shots: plan.shots.map((shot) => ({
      ...shot,
      cameraKeyframes: shot.cameraKeyframes?.length ? shot.cameraKeyframes : [
        { id: `ckf-${nanoid(7)}`, timeSec: 0, position: clone(shot.position), target: clone(shot.target), fov: shot.fov, rollDeg: shot.rollDeg ?? 0, interpolation: "smooth", source: "template", note: "旧工程起始机位" },
        { id: `ckf-${nanoid(7)}`, timeSec: shot.durationSec, position: clone(shot.cameraEnd.position), target: clone(shot.cameraEnd.target), fov: shot.cameraEnd.fov, rollDeg: shot.cameraEnd.rollDeg ?? shot.rollDeg ?? 0, interpolation: "smooth", source: "template", note: "旧工程结束机位" },
      ],
      actions: shot.actions.map((action) => ({
        ...action,
        templateId: action.templateId ?? action.action,
        intensity: action.intensity ?? 1,
        source: action.source ?? "legacy",
        keyframes: action.keyframes?.length ? action.keyframes : createMotionKeyframes(action.action, action.durationSec, action.from, action.to, "template"),
      })),
    })),
  }
}

/** kunpeng directorStore.ts L125-132 stateOfElement 逐行等价 */
export function stateOfElement(element: DirectorElement): DirectorElementState {
  return {
    position: clone(element.position),
    rotationDeg: clone(element.rotationDeg),
    scale: clone(element.scale),
    visible: element.visible,
  }
}

/** kunpeng directorStore.ts L134-136 elementStateMap 逐行等价 */
export function elementStateMap(elements: DirectorElement[]): Record<string, DirectorElementState> {
  return Object.fromEntries(elements.map((element) => [element.id, stateOfElement(element)]))
}

/** kunpeng directorStore.ts L205-213 snapshot 逐行等价 */
export function snapshotDoc(doc: DirectorDoc): HistorySnapshot {
  return clone({
    elements: doc.elements,
    groups: doc.groups,
    plans: doc.plans,
    activePlanId: doc.activePlanId,
    activeShotId: doc.activeShotId,
  })
}

export async function loadCurrent(sid: string): Promise<DirectorDoc | null> {
  try {
    const raw = await readFile(currentPath(sid), "utf-8")
    const doc = JSON.parse(raw) as DirectorDoc
    // 防御：缺栏位补默认，避免旧档炸后续 op（timeline.ts 同款）
    doc.elements ??= []
    // R3-⑤：旧档群组无 elementIds（仅 {id,name}），补空阵列避免后续 op 读 undefined
    doc.groups = (doc.groups ?? []).map((g) => ({ ...g, elementIds: Array.isArray(g.elementIds) ? g.elementIds : [] }))
    doc.plans ??= []
    doc.exports ??= []
    doc.undoStack ??= []
    doc.redoStack ??= []
    doc.currentTimeSec ??= 0
    doc.playing ??= false
    return doc
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null
    throw e
  }
}

async function loadVersion(sid: string, v: number): Promise<DirectorDoc> {
  try {
    return JSON.parse(await readFile(versionPath(sid, v), "utf-8")) as DirectorDoc
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new DirectorNotFoundError(`version ${v} not found`)
    throw e
  }
}

export async function writeCurrent(sid: string, doc: DirectorDoc): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(currentPath(sid), JSON.stringify(doc, null, 2), "utf-8")
}

export async function writeVersion(sid: string, doc: DirectorDoc): Promise<void> {
  await mkdir(path.join(sessionDir(sid), "versions"), { recursive: true })
  await writeFile(versionPath(sid, doc.revision), JSON.stringify(doc, null, 2), "utf-8")
}

export async function appendLog(sid: string, entry: DirectorLogEntry): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await appendFile(logPath(sid), JSON.stringify(entry) + "\n", "utf-8")
}

/** 保留策略：最近 KEEP_RECENT 版 + 每 MILESTONE_EVERY 版里程碑，其余删 */
export async function pruneVersions(sid: string, latest: number): Promise<void> {
  const dir = path.join(sessionDir(sid), "versions")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/)
    if (!m) continue
    const v = Number(m[1])
    const keep = v > latest - KEEP_RECENT || v % MILESTONE_EVERY === 0
    if (!keep) await rm(path.join(dir, name), { force: true }).catch(() => {})
  }
}

// ── 并发锁（timeline.ts L628-648 逐字照搬：per-session 串行化 read-modify-write） ──

const sessionLocks = new Map<string, { tail: Promise<void>; pending: number }>()

export async function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  let entry = sessionLocks.get(sid)
  if (!entry) {
    entry = { tail: Promise.resolve(), pending: 0 }
    sessionLocks.set(sid, entry)
  }
  entry.pending++
  const prev = entry.tail
  let release!: () => void
  entry.tail = new Promise<void>((r) => (release = r))
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    entry.pending--
    if (entry.pending === 0) sessionLocks.delete(sid)
  }
}