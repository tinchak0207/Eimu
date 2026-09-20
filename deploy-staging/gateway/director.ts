/**
 * director.ts — 3D 導演台服務端生命週期層（施工片3，2026-09-02）。
 *
 * 需求源：docs/director-console-integration-spec.md §3（HTTP 路由契約）§4（director.done 事件契約）。
 * 存儲範式：./timeline.ts（$WORKSPACE_DIR/director/<sid>/current.json + versions/ last 20
 * + 每第 10 里程碑 + log.jsonl + withSessionLock + pruneVersions），逐段照搬。
 * 語義真源：kunpeng-vendor @872a58b src/stores/directorStore.ts（mutation 逐一對齊：
 * normalizeShotTimes / upgradePlanKeyframes / makeSequenceShot / makeDefaultPlan /
 * stateOfElement / snapshot / undo-redo JSON 快照 / removePlan 至少留一 / replacePlans
 * 空列表拒絕 / setActive* 重置 currentTime 與 playing）；守衛真源：kunpeng
 * src/lib/agent/tools/directorTools.ts（set_lock/delete 守衛、apply_proposal 無確認拒絕、
 * proposals 30 分 TTL）。純函數層一律 import director-engine（片1+2 產物，禁改動）。
 *
 * 白名單聲明：wheel 的 id 生成本用 `nanoid(7/8)`——本檔逐字保留 nanoid 調用。
 * 文案紀律：本檔所有工具錯誤/欄位描述一律簡體（用戶裁定，agent-gateway-copy-rules）。
 */
import { mkdir, readFile, readdir, rm, appendFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nanoid } from "nanoid"
import type {
  AspectId,
  DirectorActionClip,
  DirectorCameraMove,
  DirectorElement,
  DirectorElementState,
  DirectorMotionKeyframe,
  DirectorPlan,
  DirectorSceneFile,
  DirectorSequenceShot,
  Vec3,
} from "./director-engine/types"
import { vec3 } from "./director-engine/types"
import { MOTION_TEMPLATES, createMotionKeyframes } from "./director-engine/motionTemplates"
import { CAMERA_TEMPLATES } from "./director-engine/cameraTemplates"
import { POSE_PRESETS } from "./director-engine/poses"
import { planDuration, inspectDirectorPlan, evaluateDirectorFrame } from "./director-engine/playback"
import { renderTopViewSvg, renderCameraViewSvg } from "./director-engine/svgSchematic"
import { fallbackPlans } from "./director-engine/planning-core"
import { applyCanvasNodeCreated, applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"

// 與 gateway/index.ts 同值；env 可覆蓋（測試用）。timeline.ts L29 同款。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
// 2026-09-03 驗屍修復 R3-⑧（隔離）：director 存儲根可經 DIRECTOR_DATA_ROOT 移出 agent 可讀區。
// 極限評測實錘（REPORT P1-3）：agent bash 在 workspace/ 內可讀「其他會話」的 director/<sid>/current.json
// （本場讀了 3 個別案 JSON）——數據隔離面 + 誘惑 agent 抄別案。
// 默認值保持現狀（WORKSPACE_DIR/director）兼容本地測試；VPS 部署時 env 指 workspace 外新址
// （如 /opt/agent-harness/director-data），遷移用 `sudo mv` 舊目錄（保留在途會話數據）。
const DIRECTOR_DIR = process.env.DIRECTOR_DATA_ROOT || path.join(WORKSPACE_DIR, "director")

// 保留策略：最近 20 版 + 每 10 版里程碑版（v % 10 === 0），其餘刪（timeline.ts 同款）。
const KEEP_RECENT = 20
const MILESTONE_EVERY = 10

// proposals 暫存 TTL：30 分鐘（kunpeng directorTools.ts pendingProposals 同款）。
const PROPOSAL_TTL_MS = 30 * 60_000

/**
 * 2026-09-03 驗屍修復 R3-⑦：已知 op 清單（未知 op 報錯帶可用清單；同時供 capabilities 暴露）。
 * 與 DirectorOp 聯合逐項對齊，新增 op 必須同步此表。
 */
const KNOWN_OPS: string[] = [
  "addElement", "removeElements", "updateShotElementState",
  "addShot", "updateShot", "removeShot", "reorderShot",
  "addPlan", "updatePlan", "removePlan", "duplicatePlan", "replacePlans",
  "setActivePlan", "setActiveShot", "setCurrentTime", "setPlaying",
  "addAction", "updateAction", "removeAction",
  "set_lock", "delete_element", "delete_action", "delete_keyframe",
  "addGroup", "removeGroup",
  "undo", "redo", "checkpoint", "save",
]

/**
 * 2026-09-03 驗屍修復 R3-②：能力清單進 state。
 * 極限評測實錘（REPORT P1-2）：state 無能力清單，agent 思維鏈 4 次抱怨「didn't return capabilities」，
 * 被迫 bash 翻檔 130s（還翻到別會話工程檔）。此處把 action/camera/pose 註冊表 + op 集 + 群組/導出邊界
 * 一次性如實暴露，agent 不再需要翻檔猜能力。純靜態小數據，summary/full 兩態都帶。
 */
export interface DirectorCapabilities {
  /** 動作模板 key 清單（MOTION_TEMPLATES 註冊表） */
  action_templates: string[]
  /** 運鏡 key 清單（CAMERA_TEMPLATES 註冊表） */
  camera_moves: string[]
  /** 素模姿勢 key 清單（POSE_PRESETS 註冊表） */
  poses: string[]
  /** 服務端支持的 op 清單（與 DirectorOp 聯合對齊） */
  supported_ops: string[]
  /** 群組寫路徑邊界聲明（R3-⑤ 完成後如實標 true） */
  group_write: boolean
  /** 導出邊界誠實聲明：工具面只能設範圍+save，渲染/序列帧導出在前端畫布 */
  export_boundary: string
}

const DIRECTOR_CAPABILITIES: DirectorCapabilities = {
  action_templates: MOTION_TEMPLATES.map((t) => t.id),
  camera_moves: CAMERA_TEMPLATES.map((t) => t.id),
  poses: POSE_PRESETS.map((p) => p.id),
  supported_ops: KNOWN_OPS,
  group_write: true,
  export_boundary: "prepare_export 仅设置导出范围与保存标记，不会执行渲染导出；白模渲染/序列帧导出在前端画布",
}

/** undo 歷史快照（kunpeng directorStore.ts L39-45 HistorySnapshot 同構：JSON 序列化） */
interface HistorySnapshot {
  elements: DirectorElement[]
  groups: DirectorGroup[]
  plans: DirectorPlan[]
  activePlanId: string | null
  activeShotId: string | null
}

interface DirectorGroup {
  id: string
  name: string
  /** 2026-09-03 驗屍修復 R3-⑤：群組寫路徑——成員元素 id 清單（與 element.groupId 雙向同步）。 */
  elementIds: string[]
}

/**
 * 服務端導演工程文檔 = kunpeng DirectorSceneFile（schema v2 欄位逐一同構：version/elements/
 * groups/plans/activePlanId/aspect/origin/exports/updatedAt）+ 會話擴展（revision/activeShotId/
 * currentTimeSec/playing/undo-redo 棧）。存盤兼容 wheel save() 產物。
 */
export interface DirectorDoc {
  session_id: string
  revision: number
  version: 2
  elements: DirectorElement[]
  groups: DirectorGroup[]
  plans: DirectorPlan[]
  activePlanId: string | null
  activeShotId: string | null
  aspect: AspectId
  origin: DirectorSceneFile["origin"]
  exports: DirectorSceneFile["exports"]
  /** 播放狀態（服務端擴展；wheel 在 store 內存，重開回 0） */
  currentTimeSec: number
  playing: boolean
  /** undo/redo JSON 快照棧（kunpeng HistorySnapshot 逐字同構） */
  undoStack: HistorySnapshot[]
  redoStack: HistorySnapshot[]
  updated_at: string
}

/** 決策日誌條目（log.jsonl，append-only；timeline LogEntry 簡化形） */
export interface DirectorLogEntry {
  at: string
  action: string
  revision: number
  changed: string[]
}

/** 健康檢查形狀（spec §4；wheel DirectorHealthIssue = {id, severity, shotId, message}） */
export interface DirectorHealth {
  ok: boolean
  issues: Array<{ code: string; message: string; shot_id?: string }>
}

// ── 錯誤（HTTP 層映射：not_initialized→409；invalid→400；not_found→404；blocked→409）──

export class DirectorNotInitializedError extends Error {
  constructor() {
    super("导演工程尚未初始化；请先用 add_plan 或 add_element 建立工程")
    this.name = "DirectorNotInitializedError"
  }
}

export class DirectorValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectorValidationError"
  }
}

export class DirectorNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectorNotFoundError"
  }
}

export class DirectorBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectorBlockedError"
  }
}

// ── 存儲層（timeline.ts L164-709 逐段照搬：timelines→director、Timeline→DirectorDoc） ──

function assertSessionId(sid: string): void {
  if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) {
    throw new DirectorValidationError("session_id must match [A-Za-z0-9_-]{1,64}")
  }
}

function sessionDir(sid: string): string {
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

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** kunpeng directorStore.ts L215-225 normalizeShotTimes 逐行等價 */
function normalizeShotTimes(plan: DirectorPlan): DirectorPlan {
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
 * kunpeng directorStore.ts L227-245 upgradePlanKeyframes 逐行等價：
 * 舊工程鏡頭補 cameraKeyframes 首尾兩幀；動作補 templateId/intensity/source/keyframes。
 */
function upgradePlanKeyframes(plan: DirectorPlan): DirectorPlan {
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

/** kunpeng directorStore.ts L125-132 stateOfElement 逐行等價 */
function stateOfElement(element: DirectorElement): DirectorElementState {
  return {
    position: clone(element.position),
    rotationDeg: clone(element.rotationDeg),
    scale: clone(element.scale),
    visible: element.visible,
  }
}

/** kunpeng directorStore.ts L134-136 elementStateMap 逐行等價 */
function elementStateMap(elements: DirectorElement[]): Record<string, DirectorElementState> {
  return Object.fromEntries(elements.map((element) => [element.id, stateOfElement(element)]))
}

/** kunpeng directorStore.ts L205-213 snapshot 逐行等價 */
function snapshotDoc(doc: DirectorDoc): HistorySnapshot {
  return clone({
    elements: doc.elements,
    groups: doc.groups,
    plans: doc.plans,
    activePlanId: doc.activePlanId,
    activeShotId: doc.activeShotId,
  })
}

async function loadCurrent(sid: string): Promise<DirectorDoc | null> {
  try {
    const raw = await readFile(currentPath(sid), "utf-8")
    const doc = JSON.parse(raw) as DirectorDoc
    // 防禦：缺欄位補默認，避免舊檔炸後續 op（timeline.ts 同款）
    doc.elements ??= []
    // R3-⑤：舊檔群組無 elementIds（僅 {id,name}），補空陣列避免後續 op 讀 undefined
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

async function writeCurrent(sid: string, doc: DirectorDoc): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(currentPath(sid), JSON.stringify(doc, null, 2), "utf-8")
}

async function writeVersion(sid: string, doc: DirectorDoc): Promise<void> {
  await mkdir(path.join(sessionDir(sid), "versions"), { recursive: true })
  await writeFile(versionPath(sid, doc.revision), JSON.stringify(doc, null, 2), "utf-8")
}

async function appendLog(sid: string, entry: DirectorLogEntry): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await appendFile(logPath(sid), JSON.stringify(entry) + "\n", "utf-8")
}

/** 保留策略：最近 KEEP_RECENT 版 + 每 MILESTONE_EVERY 版里程碑，其餘刪 */
async function pruneVersions(sid: string, latest: number): Promise<void> {
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

// ── 並發鎖（timeline.ts L628-648 逐字照搬：per-session 串行化 read-modify-write） ──

const sessionLocks = new Map<string, { tail: Promise<void>; pending: number }>()

async function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
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

// ── 事件發射（index.ts 注入 emitToSession；模組層不 import index 防環） ─────────

/** index.ts 補丁注入：emitToSession(stateFor(sid), name, data)——含會話解析 */
export type DirectorEmitter = (sid: string, name: string, data: unknown) => void

let emitFn: DirectorEmitter | null = null

/** index.ts 補丁啟動時呼叫一次 */
export function setDirectorEmitter(fn: DirectorEmitter): void {
  emitFn = fn
}

/** index.ts 補丁注入：resolveSession——sid（gateway UUID 或 opencode session id）→ 會話狀態 */
export type DirectorSessionResolver = (sid: string) => { sessionId: string; apiKey: string } | undefined

let resolveFn: DirectorSessionResolver | null = null

/** index.ts 補丁啟動時呼叫一次 */
export function setDirectorSessionResolver(fn: DirectorSessionResolver): void {
  resolveFn = fn
}

function emitToSessionBySid(sid: string, name: string, data: unknown): void {
  try {
    emitFn?.(sid, name, data)
  } catch {
    /* 事件發射失敗不擋寫入路徑 */
  }
}

// ── SVG / 健康 / 計數（spec §4 payload 組裝；渲染輪子錨 = svgSchematic/shotDescription） ──

function activePlanOf(doc: DirectorDoc): DirectorPlan | null {
  return doc.plans.find((p) => p.id === doc.activePlanId) ?? doc.plans[0] ?? null
}

function healthOf(doc: DirectorDoc): DirectorHealth {
  const activePlan = activePlanOf(doc)
  if (!activePlan) return { ok: true, issues: [] }
  const issues = inspectDirectorPlan(activePlan, doc.elements)
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues: issues.map((i) => ({ code: i.id, message: i.message, shot_id: i.shotId || undefined })),
  }
}

function renderSchematics(doc: DirectorDoc, plan?: DirectorPlan, shot?: DirectorSequenceShot): { top_view_svg: string; camera_view_svg: string } {
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

function countsOf(doc: DirectorDoc): { shots: number; elements: number; actions: number } {
  return {
    shots: doc.plans.reduce((s, p) => s + p.shots.length, 0),
    elements: doc.elements.length,
    actions: doc.plans.reduce((s, p) => s + p.shots.reduce((s2, sh) => s2 + sh.actions.length, 0), 0),
  }
}

/**
 * spec §4 director.done + canvas 側（首次 canvas.node.created / 後續 canvas.node.updated，
 * node.type "director"；SVG 合計 >48KB 時 canvas metadata 省略 SVG，director.done 內不省）。
 */
const announcedDirectorNodes = new Set<string>()

function emitDirectorDone(sid: string, doc: DirectorDoc, action: string, svg?: { top_view_svg: string; camera_view_svg: string }): void {
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
    // doc.revision 透傳（刷新缺口修復）：已掛載視口比對 revision 變化重拉 state。
    revision: doc.revision,
    ...(includeSvg ? { topViewSvg: schematic.top_view_svg, cameraViewSvg: schematic.camera_view_svg } : {}),
  }
  if (!announcedDirectorNodes.has(nodeId)) {
    announcedDirectorNodes.add(nodeId)
    // 事件形狀照 index.ts autoCreateCanvasUnit 的 canvas.node.created：{unit_id, node}
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
    // 2026-09-20 寫穿：SSE 幀發出即落 canvasStates（同一 node 物件，冪等 upsert）。
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
    // 事件形狀照 index.ts emitCanvasResult 的 canvas.node.updated：{unit_id, node_id, patch}
    // 前端 reducer（canvas/reducer.ts reduceCanvasNodeUpdated）把 patch 攤平進 node.metadata，
    // 故 patch = metadata 欄位本身（不包 metadata 鍵）。
    emitToSessionBySid(sid, "canvas.node.updated", { unit_id: nodeId, node_id: nodeId, patch: metadata })
    // 2026-09-20 寫穿：同一 patch 淺合併進快照節點 metadata（冪等 last-write-wins）。
    applyCanvasNodeUpdated(sid, { unit_id: nodeId, node_id: nodeId, patch: metadata })
  }
}

// ── proposals 暫存（kunpeng directorTools.ts L26/812-815 同款：Map + 30 分 TTL） ──
//
// 2026-09-04 持久化（複測實錘病灶：agent-gateway 重啟清零內存 Map → 用戶手裡提案卡全部過期，
// R3 部署窗口恰逢提案在途，apply 必 EXPIRED）：內存 Map 保留為熱路徑，新增落盤
// `<sid>/proposals.json`（與 current.json/versions/log.jsonl 同目錄同 fs 範式）：
// - create：生成後在既有 withSessionLock(sid) 內合併寫盤；寫盤失敗降級純內存 + console.error，不阻塞提案。
// - apply：內存 miss → 惰性按 sid 讀盤（進程啟動無全量預載）；TTL 仍按 createdAt 校驗，過期即刪盤上條目。
// - 死鎖紀律：proposals.json 的所有變更（create 合併寫、apply 消費刪、過期刪）都收斂在
//   withSessionLock(sid) 域內串行；apply 的刪盤發生在 applyDirectorOps（自持鎖）返回之後，
//   兩段鎖順序不嵌套。純讀（loadCurrent/讀 proposals.json）不取鎖。

const pendingProposals = new Map<string, { plans: DirectorPlan[]; createdAt: number }>()

function pruneProposals(): void {
  for (const [id, proposal] of pendingProposals) {
    if (Date.now() - proposal.createdAt > PROPOSAL_TTL_MS) pendingProposals.delete(id)
  }
}

function proposalsPath(sid: string): string {
  return path.join(sessionDir(sid), "proposals.json")
}

type StoredProposal = { plans: DirectorPlan[]; createdAt: number }

/** 盤上條目防呆：結構異常（非物件 plans / createdAt 非數）視同損壞 */
function isUsableProposal(p: unknown): p is StoredProposal {
  const c = p as StoredProposal | null
  return !!c && typeof c === "object" && typeof c.createdAt === "number" && Array.isArray(c.plans) && c.plans.length > 0
}

/** 讀盤上 proposals；任何異常（缺檔/損壞）收斂為空表——內存路徑必須不被輔助持久化拖死 */
async function readProposalsFile(sid: string): Promise<Record<string, StoredProposal>> {
  try {
    const parsed = JSON.parse(await readFile(proposalsPath(sid), "utf-8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map = parsed as Record<string, StoredProposal>
      for (const [pid, p] of Object.entries(map)) if (!isUsableProposal(p)) delete map[pid]
      return map
    }
    return {}
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      console.error(`[director] proposals.json 不可讀（sid=${sid}），按空處理:`, e)
    }
    return {}
  }
}

/** 合併新提案進盤上檔案並清掉過期條目；調用方必須已持有 withSessionLock(sid)。 */
async function mergeProposalsOntoDisk(sid: string, entries: Array<{ id: string; proposal: StoredProposal }>): Promise<void> {
  const stored = await readProposalsFile(sid)
  const now = Date.now()
  for (const [pid, p] of Object.entries(stored)) {
    if (now - p.createdAt > PROPOSAL_TTL_MS) delete stored[pid]
  }
  for (const { id, proposal } of entries) stored[id] = proposal
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(proposalsPath(sid), JSON.stringify(stored), "utf-8")
}

/** 刪盤上單條（不存在則 no-op，不無故建檔）；調用方必須已持有 withSessionLock(sid)。 */
async function dropProposalFromDisk(sid: string, id: string): Promise<void> {
  const stored = await readProposalsFile(sid)
  if (!(id in stored)) return
  delete stored[id]
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(proposalsPath(sid), JSON.stringify(stored), "utf-8")
}

/** applyDirectorOps 之外調用的刪盤包裝：自取會話鎖 + 失敗僅記日誌（不反噬已成功的 apply）。 */
async function dropProposalWithLock(sid: string, id: string): Promise<void> {
  try {
    await withSessionLock(sid, () => dropProposalFromDisk(sid, id))
  } catch (e) {
    console.error(`[director] proposal 盤上刪除失敗（sid=${sid}, id=${id}）:`, e)
  }
}

/** 測試鉤子：模擬 gateway 重啟（僅清內存 Map，盤上保留），驗證 apply 走盤載入路徑。 */
export function __clearPendingProposalsForTest(): void {
  pendingProposals.clear()
}

// ── op 聯合（~20 個純文檔操作；語義逐一對齊 directorStore mutation + directorTools 守衛） ──

/** addAction 入參（kunpeng upsert_action 的新建路徑；欄位名走 HTTP snake_case） */
export interface DirectorActionSeed {
  element_id: string
  action: DirectorActionClip["action"]
  start_sec?: number
  duration_sec: number
  /** 2026-09-03 R1-#2：顯式起點覆蓋；省略時默認取「前一鏡末幀（或同鏡頭前序動作結束時）」求解位置 */
  from?: Vec3
  to?: Vec3
  from_rotation_deg?: Vec3
  to_rotation_deg?: Vec3
  intensity?: number
  locked?: boolean
  /** 2026-09-03 驗屍修復 R3-⑥：同元素同鏡動作時間重疊時強制覆蓋（默認 false → 重疊報錯） */
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

/** 首個 op 需要已初始化工程嗎？addPlan/addElement/save/undo/redo/checkpoint/播放控制/群組可在空工程上跑。 */
function requiresPlan(op: DirectorOp): boolean {
  return !["addPlan", "addElement", "save", "undo", "redo", "checkpoint", "setCurrentTime", "setPlaying", "replacePlans", "addGroup", "removeGroup"].includes(op.op)
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !isFinite(v)) throw new DirectorValidationError(`${name} must be a finite number`)
  return v
}
function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new DirectorValidationError(`${name} must be a non-empty string`)
  return v
}

/**
 * 2026-09-03 驗屍修復 R3-⑦（錯誤文案衛生）：manage_plan 系 op 的目標方案 id 校驗。
 * 極限評測實錘（REPORT P0-1/⑦）：無效/空 plan_id 舊路徑落 `str()` 回英文 "plan_id must be a
 * non-empty string"，或工具層拼出「找不到方案 」（尾空格+空 id）。統一為中文 not_found：
 * 空 id → 「找不到方案（未提供有效的 plan_id）」；非空但不存在 → 呼叫點回「找不到方案 <id>」（無尾空格）。
 */
function requirePlanId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : ""
  if (!id) throw new DirectorNotFoundError("找不到方案（未提供有效的 plan_id）")
  return id
}

/** R3-⑥：動作時間區間可讀化（秒，保留兩位） */
function actionRangeLabel(startSec: number, durationSec: number): string {
  const round = (n: number) => Math.round(n * 100) / 100
  return `${round(startSec)}-${round(startSec + durationSec)}s`
}

/** kunpeng directorStore.ts L138-166 makeSequenceShot 逐行等價 */
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

/** kunpeng directorStore.ts L168-177 makeDefaultPlan 逐行等價 */
function makeDefaultPlan(elements: DirectorElement[], aspect: AspectId, name = "稳定叙事"): DirectorPlan {
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
 * 2026-09-03 驗屍修復 R1-#3：bare 方案殼（shots: []，摘要同步空工程口徑）。
 * 工具觸發的 auto-seed 用此殼——極限會話實錘：makeDefaultPlan 播種的 4 個模板鏡頭
 * 在 agent 從零搭建時要逐個 delete 清垃圾。makeDefaultPlan 模板語義保留給前端 open()（二期）。
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

/** 2026-09-03 驗屍修復 R1-#6：方案摘要動態口徑（鏡頭數 · 總秒數） */
function planSummaryOf(plan: DirectorPlan): string {
  const totalSec = Math.round(plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0) * 100) / 100
  return `${plan.shots.length} 个镜头 · ${totalSec} 秒`
}

/** R1-#6：結構性鏡頭操作後同步所在方案 summary */
function withSyncedSummary(plan: DirectorPlan): DirectorPlan {
  return { ...plan, summary: planSummaryOf(plan) }
}

/**
 * 2026-09-03 驗屍修復 R3-④（propose_plans 尊重鏡頭數）：從 instruction 解析「N 个镜头 / N 镜头 / N 镜」。
 * 極限評測實錘（REPORT P1-5）：指令明寫六鏡，提案 4 鏡，agent 手補 2。
 * 正則照 spec 原樣：(\d+)\s*[个個]?\s*镜头|(\d+)\s*镜；解析不出回 null（維持模板默認）。
 */
function parseShotCountFromInstruction(instruction: string): number | null {
  const m = instruction.match(/(\d+)\s*[个個]?\s*镜头|(\d+)\s*镜/)
  if (!m) return null
  const n = Number(m[1] ?? m[2])
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null
}

/** R3-④：克隆鏡頭並換全套 id（循環湊數時避免 id 重複；名稱統一「镜头 N」口徑）。 */
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
 * R3-④：把方案鏡頭序列調整為 count 個——不足循環模板序列湊數（克隆換 id），超出截斷；
 * 之後 normalizeShotTimes 重排 startSec。空序列無從循環，原樣返回。
 */
function resizePlanShotCount(plan: DirectorPlan, count: number): DirectorPlan {
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
 * 2026-09-03 驗屍修復 R1-#2：動作起點接續求解（見 addAction 註釋）。
 * 用 evaluateDirectorFrame 在目標時刻解算該元素位置：
 * 同鏡頭前序動作 → 動作 startSec 時刻；否則上一鏡末幀（末幀前 1ms 落在前鏡內）；
 * 首鏡頭無前序 → 回退 fallback（elementStates/element.position，現狀語義）。
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

/** 2026-09-03 驗屍修復 R1-#4：K 幀規整——按 timeSec 升冪重排 + 同幀去重（一個 24fps 幀槽內視為同幀）。
 * 真實會話彈跳實錘（fd22bd6e rev49/55「step-back 末帧时间轴异常，重建干净版本」）：
 * 用戶 K 幀 t=1.0（位置 15,-2，提前到達語義）與模板填充 K 幀 t=1.025（11.4,-1.64，0.6 幀間隔）共存，
 * 回放位置 15,-2 → 11.4,-1.64 → 15,-2 來回彈跳；舊去重窗僅半幀（1/48）攔不住 0.6 幀間隔。
 * 本規整窗寬 = 1/24（同幀槽），同槽保留時間較早者（保住「提前到達」意圖；模板殘留填充丟棄）。
 * 意圖感知的精細去重（用戶幀 next 優先，一幀窗）在工具層 set_motion_keyframe，先於本規整執行。 */
const KF_DEDUPE_SEC = 1 / 24

function normalizeMotionKeyframes(keyframes: DirectorMotionKeyframe[]): DirectorMotionKeyframe[] {
  const sorted = keyframes
    .filter((keyframe) => keyframe && typeof keyframe.timeSec === "number" && Number.isFinite(keyframe.timeSec))
    .sort((a, b) => a.timeSec - b.timeSec)
  const out: DirectorMotionKeyframe[] = []
  for (const keyframe of sorted) {
    const previous = out[out.length - 1]
    if (previous && keyframe.timeSec - previous.timeSec < KF_DEDUPE_SEC) {
      // 人工鎖定幀永不丟棄：同幀槽撞上鎖定幀時保留鎖定者
      if (!previous.locked && keyframe.locked) out[out.length - 1] = keyframe
      continue
    }
    out.push(keyframe)
  }
  return out
}

/**
 * 單 op 套用（draft 就地修改；語義註釋標 wheel mutation 名；錯誤文案全簡體，照 directorTools）。
 * 回傳 changed 摘要（log.jsonl changed 欄位）。
 */
function applyDirectorOp(doc: DirectorDoc, op: DirectorOp): string {
  switch (op.op) {
    // wheel addElement：push + 全 plan 全 shot elementStates 補 baseState
    // （API 邊界防禦：部分形狀補默認——wheel 假設 UI 工廠傳完整元素，裸 API/agent 補丁層可能缺欄，
    // 不補會在 clone(undefined) 處炸 JSON.parse）
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
    // wheel removeElements（delete_element 為 director_delete target=element 路徑，含存在性守衛）
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
    // wheel updateShotElementState：全 plan 中目標 shot 的 elementStates 合併
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
    // wheel addShot：目標=activePlan；追加後 normalizeShotTimes；activeShot 切新鏡頭
    case "addShot": {
      const plan = doc.plans.find((p) => p.id === doc.activePlanId)
      if (!plan) throw new DirectorNotFoundError("当前没有活动方案")
      const duration = op.shot?.durationSec ?? 3.75
      const start = plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0)
      const shot = { ...makeSequenceShot(plan.shots.length, start, duration, doc.aspect, doc.elements), ...(op.shot ?? {}), id: op.shot?.id ?? `shot-${nanoid(7)}` } as DirectorSequenceShot
      // R1-#6：結構變更後同步方案摘要
      doc.plans = doc.plans.map((item) => (item.id === plan.id ? withSyncedSummary(normalizeShotTimes({ ...item, shots: [...item.shots, shot] })) : item))
      doc.activeShotId = shot.id
      doc.currentTimeSec = start
      return `shot:${shot.id}`
    }
    // wheel updateShot：patch 合併 + durationSec 比例縮放 cameraKeyframes/actions + normalizeShotTimes
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
    // wheel removeShot：activePlan；至少留一鏡頭；normalizeShotTimes；activeShot 回退首鏡頭
    case "removeShot": {
      const shotId = str(op.shot_id, "shot_id")
      const plan = doc.plans.find((p) => p.id === doc.activePlanId)
      if (!plan) throw new DirectorNotFoundError("当前没有活动方案")
      if (plan.shots.length <= 1) throw new DirectorBlockedError("方案至少保留一个镜头")
      // R1-#6：結構變更後同步方案摘要
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
        // R1-#6：結構變更後同步方案摘要
        return withSyncedSummary(normalizeShotTimes({ ...plan, shots }))
      })
      return `shot:${shotId}`
    }
    // wheel addPlan：partial 覆蓋；activePlan/activeShot 切過去
    // R1-#3：帶 shots 陣列的 addPlan 以 bare 殼為基底（工具 auto-seed / 從零搭建語義，
    // 不再先造 4 個模板鏡頭再整體覆蓋）；無 shots 參數維持 makeDefaultPlan 模板（前端 open() 二期）。
    case "addPlan": {
      const base = Array.isArray(op.plan?.shots) ? makeBarePlan(op.plan?.name) : makeDefaultPlan(doc.elements, doc.aspect, op.plan?.name)
      const plan = { ...base, ...(op.plan ?? {}), id: op.plan?.id ?? base.id } as DirectorPlan
      doc.plans = [...doc.plans, upgradePlanKeyframes(plan)]
      doc.activePlanId = plan.id
      doc.activeShotId = plan.shots[0]?.id ?? null
      doc.currentTimeSec = 0
      return `plan:${plan.id}`
    }
    // wheel updatePlan：name/summary patch（rename 語義，kunpeng manage_plan rename 同款守衛）
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
    // wheel duplicatePlan：深拷貝 + 全 id 換新
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
    // wheel replacePlans：空列表拒絕；normalizeShotTimes；activePlan=首方案
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
    // wheel setActivePlan：切方案 + activeShot=首鏡頭 + currentTime=0 + playing=false
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
    // wheel setActiveShot：跨方案找鏡頭；currentTime=該鏡頭 startSec；playing=false
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
    // wheel addAction：補 id/templateId/intensity/source/keyframes（createMotionKeyframes 輪子）
    case "addAction": {
      const shotId = str(op.shot_id, "shot_id")
      const seed = op.action
      if (!seed || typeof seed !== "object") throw new DirectorValidationError("action is required")
      const elementId = str(seed.element_id, "action.element_id")
      const actionId = str(seed.action, "action.action") as DirectorActionClip["action"]
      // R1-#2：定位所在方案（from 接續求解需要完整 plan 上下文）
      const containingPlan = doc.plans.find((plan) => plan.shots.some((item) => item.id === shotId))
      const shot = containingPlan?.shots.find((item) => item.id === shotId)
      if (!shot) throw new DirectorNotFoundError(`找不到镜头 ${shotId}`)
      const element = doc.elements.find((e) => e.id === elementId)
      if (!element) throw new DirectorNotFoundError(`找不到对象 ${elementId}`)
      const durationSec = num(seed.duration_sec, "action.duration_sec")
      const startSec = num(seed.start_sec ?? 0, "action.start_sec")
      const state = shot.elementStates[elementId]
      const fallback = state?.position ?? element.position
      // 2026-09-03 驗屍修復 R1-#2：from 默認接續動線——極限會話實錘 12 次手工「起点锚定 S4 终点」：
      // 舊邏輯取 shot.elementStates（可能滯留全局初始位），跨鏡動線每鏡都要手工錨一次。
      // 新默認：a) 同鏡頭有更早動作 → 取該動作進行中/結束時的求解位置；
      //         b) 無同鏡頭前序但有上一鏡 → 取上一鏡末幀（startSec+durationSec 邊界內）求解位置；
      //         c) 首鏡頭 → 維持現狀（elementStates/element.position）。
      // 顯式 from 參數永遠可覆蓋。
      const from = seed.from ? clone(seed.from) : solvedFromPosition(containingPlan!, doc.elements, shot, elementId, startSec, fallback)
      const to = seed.to ? clone(seed.to) : { ...from }
      // 2026-09-03 驗屍修復 R3-⑥（動作重疊守衛）：同元素同鏡頭時間區間重疊 → 舊行為直接追加，
      // 回放時兩動作搶同一元素造成位置跳變（REPORT P2-7：look-back+raise-hand 靠 agent 自查自刪）。
      // 新默認：重疊回結構化錯誤帶兩動作 id+區間；force:true 保留舊覆蓋出口。
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
    // wheel updateAction：patch 合併 + durationSec 比例縮放 keyframes
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
            // R1-#4：寫入前規整（升冪重排 + 同幀去重；縮放 clamp 造成的同刻重複也在此收斂）
            if (next.keyframes) next.keyframes = normalizeMotionKeyframes(next.keyframes)
            return next
          }),
        })),
      }))
      return `action:${actionId}`
    }
    // wheel removeAction / delete_action（含 locked 守衛，kunpeng deleteTool 同款文案）
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
    // wheel set_lock（kunpeng lockTool）：action/motion_keyframe/camera_keyframe 三目標
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
    // kunpeng deleteTool：motion_keyframe/camera_keyframe 刪除（locked 守衛 + override）
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
    // 2026-09-03 驗屍修復 R3-⑤（群組寫路徑）：建群組——元素存在性校驗 + 與 element.groupId 雙向同步。
    // 一個元素至多屬一個群組：入新組時從其他組的 elementIds 剔除，保持兩處真相一致。
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
    // R3-⑤：刪群組——只刪組不刪元素，成員 groupId 復位 null。
    case "removeGroup": {
      const groupId = str(op.group_id, "group_id")
      const group = doc.groups.find((g) => g.id === groupId)
      if (!group) throw new DirectorNotFoundError(`找不到群组 ${groupId}`)
      doc.groups = doc.groups.filter((g) => g.id !== groupId)
      for (const element of doc.elements) if (element.groupId === groupId) element.groupId = null
      return `group_removed:${groupId}`
    }
    // wheel undo：JSON 快照回滾
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
    // wheel checkpoint：同狀態去重 + 上限 40
    case "checkpoint": {
      const next = snapshotDoc(doc)
      const previous = doc.undoStack[doc.undoStack.length - 1]
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return "checkpoint"
      doc.undoStack = [...doc.undoStack.slice(-39), next]
      doc.redoStack = []
      return "checkpoint"
    }
    // wheel save：寫入路徑統一走 applyWithinLock，此處僅標記
    case "save":
      return "save"
    default:
      throw new DirectorValidationError(`不支持的操作 ${(op as { op?: string }).op}，可用：${KNOWN_OPS.join("、")}`)
  }
}

// ── 對外 API（spec §3 六條路由的服務層） ─────────────────────────────────────

/** wheel save() 產物形狀（DirectorSceneFile v2）——spec §3 GET /state 出參 project 欄位 */
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
 * 2026-09-03 驗屍修復 R1-#1：state 分級輸出。
 * 極限會話實錘（fd22bd6e）：GET /state project 載荷 55KB，joints（動作 K 幀內嵌 10+ 關節座標）
 * 佔 44%，agent 覆核被迫派子代理落盤定點查。summary 模式：保留 plan/shots 結構與每個 action 的
 * {id, elementId, action, startSec, durationSec, from, to, keyframe_count, 首末位置}、
 * cameraKeyframes 摘要（id/幀位/位置）、health/issues/counts；剝除所有 joints 與 keyframes 陣列。
 * 默認仍是 full（前端 viewport 的 evaluateDirectorFrame 需要完整 keyframes，兼容零風險）；
 * 工具層 director_get_state 顯式傳 ?mode=summary（R2 跟進）。
 */
export type DirectorStateMode = "summary" | "full"

/** summary 模式動作摘要（keyframes 陣列 → keyframe_count + 首末位置） */
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
  /** R3-⑤：群組進 state 兩態；summary 帶 id/name/element_ids（elementIds 同值保留，兼容 camel 讀法） */
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
    // R3-⑤：summary 群組帶雙寫法成員清單（契約 element_ids；elementIds 為存儲原形）
    groups: (scene.groups as Array<{ id: string; name: string; elementIds?: string[] }>).map((g) => ({
      id: g.id,
      name: g.name,
      elementIds: [...(g.elementIds ?? [])],
      element_ids: [...(g.elementIds ?? [])],
    })),
    // mannequin 元素的 joints 關節覆蓋屬於大體積低頻欄位，summary 剝除（poseId 保留）
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
  /** R1-#1：本回包的分級（默認 full） */
  mode: DirectorStateMode
  project: DirectorSceneFile | DirectorStateSummary
  active_plan_id: string | null
  active_shot_id: string | null
  health: DirectorHealth
  counts: { shots: number; elements: number; actions: number }
  revision: number
  initialized: boolean
  /** R3-②：能力清單（action/camera/pose 模板 + op 集 + 群組/導出邊界），summary/full 兩態都帶 */
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
   * 2026-09-03 驗屍修復 R3-⑤（群組寫路徑契約，工具層按此調用）：批內含 addGroup 時回
   * 新建群組 `{id, name, element_ids}`；含 removeGroup 時回 `removed_group_id`。無則不帶。
   */
  group?: { id: string; name: string; element_ids: string[] }
  removed_group_id?: string
}

/**
 * 一批 ops：變更類 op 先 checkpoint（wheel mutation 慣例）後套用；有實際變化 → revision+1、
 * 寫 current + versions/<n>.json + log.jsonl、按策略裁剪、emit director.done + canvas.node.*。
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
    // 空工程文檔殼（無 doc 時用；wheel open() 語義：kunpeng directorStore.open() 對空目錄首開即播種）
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
    // 2026-09-03 驗屍修復 R3-①（P0：無 plan 即播種）：舊門禁只在 `!current`（無 doc）時 auto-seed，
    // 首 op 為 addElement 時 doc 建了但 plans 空、activePlanId:null → 後續需 plan 的 op（addShot 等）
    // 全撞「当前没有活动方案」死路且無出口（REPORT P0-1：agent 連續撞牆 3 次）。
    // 新守衛：只要「無 activePlan（plans 空）」且本批 ops 含 requiresPlan 且批內無自建 plan op（addPlan/
    // replacePlans）→ 注入 bare addPlan（R1-#3 的 bare 殼語義，不帶模板鏡頭垃圾）。
    // 已有 plan 的用戶（前端已建方案）activePlanOf 非 null → 零影響。
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
    // wheel 慣例：變更類 mutation 先 checkpoint（快照去重 + 上限 40，同 checkpoint()）
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

  // R3-⑤：群組 op 響應契約——從 changed 提取本批 addGroup/removeGroup 結果
  // （changed 與 ops 逐位對齊；批內多個同類 op 取最後一個）。
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
    // 冪等 op：不 bump 版本、不寫日誌（timeline.ts 同款），但仍回當前狀態
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

/** spec §3 POST /proposals 出參（每案帶 requires_user_confirmation: true） */
export interface DirectorProposalSummary {
  proposal_id: string
  requires_user_confirmation: true
  name: string
  summary: string
  duration_sec: number
  shots: Array<{ name: string; duration_sec: number; camera_move: DirectorCameraMove; actions: number }>
}

/**
 * spec §3 POST /proposals：planning-core 輪子（fallbackPlans 內部含 inferPromptActionsByShot
 * + ensurePlanActions + buildPlans 鏈，見片1 白名單④）對 instruction 生成 2-3 案；
 * 暫存 30 分 TTL。無已初始化工程 → DirectorNotInitializedError（守衛同 requireDirector）。
 */
export async function createDirectorProposals(
  sid: string,
  instruction: string,
  /** R3-④：可選目標鏡頭數（1-12）；未傳時從 instruction 解析「N 个镜头/N 镜」 */
  shotCount?: number,
): Promise<{ ok: true; proposal_ids: string[]; plans: DirectorProposalSummary[] }> {
  assertSessionId(sid)
  const trimmed = str(instruction, "instruction")
  // R3-④：顯式 shot_count 優先並嚴格校驗；未傳走正則解析；都無 → null 維持模板默認
  let targetCount: number | null = null
  if (shotCount !== undefined && shotCount !== null) {
    if (!Number.isInteger(shotCount) || shotCount < 1 || shotCount > 12) {
      throw new DirectorValidationError("shot_count 必须是 1-12 的整数")
    }
    targetCount = shotCount
  } else {
    targetCount = parseShotCountFromInstruction(trimmed)
  }
  return withSessionLock(sid, async () => {
    let doc = await loadCurrent(sid)
    if (!doc || doc.plans.length === 0) {
      // 空工程：用默認方案當 base 生成候選（wheel open() 播種語義）；apply_proposal 的
      // replacePlans 是 seedable op，確認後會真正落盤。已有 elements/origin 時保留。
      const elements = doc?.elements ?? []
      const aspect = doc?.aspect ?? "16:9"
      doc = {
        session_id: sid,
        revision: doc?.revision ?? 0,
        version: 2,
        elements,
        groups: doc?.groups ?? [],
        plans: [makeDefaultPlan(elements, aspect, "稳定叙事")],
        activePlanId: null,
        activeShotId: null,
        aspect,
        origin: doc?.origin ?? { kind: "free", title: "" },
        exports: doc?.exports ?? [],
        currentTimeSec: 0,
        playing: false,
        undoStack: doc?.undoStack ?? [],
        redoStack: doc?.redoStack ?? [],
        updated_at: new Date(0).toISOString(),
      }
    }
    const base = doc.plans.find((p) => p.id === doc.activePlanId) ?? doc.plans[0]
    // R3-④：生成鏈湊數——先按目標數預調 base（≤8：planning-core adaptBaseForMotion 硬上限 8，
    // 讓運鏡交替與動作推理按目標鏡頭數自然分佈），生成後再兜底 resize
    // （覆蓋 >8 循環、prompt「镜头N」節區數量與目標不一致、bare base 默認 4 鏡等路徑）。
    const genBase = targetCount ? resizePlanShotCount(clone(base), Math.min(targetCount, 8)) : base
    let plans = fallbackPlans(clone(genBase), clone(doc.elements), trimmed)
    if (targetCount) plans = plans.map((plan) => resizePlanShotCount(plan, targetCount))
    pruneProposals()
    const ids: string[] = []
    const summaries: DirectorProposalSummary[] = []
    const diskEntries: Array<{ id: string; proposal: StoredProposal }> = []
    for (const plan of plans.slice(0, 3)) {
      const id = `director-proposal-${nanoid(8)}`
      const proposal: StoredProposal = { plans: [plan], createdAt: Date.now() }
      pendingProposals.set(id, proposal)
      diskEntries.push({ id, proposal })
      ids.push(id)
      summaries.push({
        proposal_id: id,
        requires_user_confirmation: true,
        name: plan.name,
        summary: plan.summary,
        duration_sec: Math.round(planDuration(plan) * 1000) / 1000,
        shots: plan.shots.map((shot) => ({ name: shot.name, duration_sec: shot.durationSec, camera_move: shot.cameraMove, actions: shot.actions.length })),
      })
    }
    // 2026-09-04 持久化：本處已在 withSessionLock(sid) 內，直接合併寫盤；失敗降級純內存（舊行為）不阻塞提案。
    try {
      await mergeProposalsOntoDisk(sid, diskEntries)
    } catch (e) {
      console.error(`[director] proposals 落盤失敗（sid=${sid}，降級純內存）:`, e)
    }
    return { ok: true, proposal_ids: ids, plans: summaries }
  })
}

/**
 * spec §3 POST /apply_proposal：無暫存記錄 → DirectorNotFoundError（守衛照搬 kunpeng
 * applyProposalTool「候选方案不存在或已过期，请重新生成」）；成功 → replacePlans + emit。
 * 2026-09-04 持久化：內存 miss → 惰性讀 `<sid>/proposals.json`（重啟後仍可批准在途提案）；
 * 盤上條目同樣按 createdAt 校 TTL，過期即刪。成功後盤上殘留一併清除（內存命中時也清，冪等 no-op）。
 */
export async function applyDirectorProposal(sid: string, proposalId: string): Promise<ApplyDirectorOpsResult> {
  assertSessionId(sid)
  const id = str(proposalId, "proposal_id")
  pruneProposals()
  let proposal = pendingProposals.get(id)
  if (!proposal) {
    const disk = (await readProposalsFile(sid))[id]
    if (disk) {
      if (Date.now() - disk.createdAt > PROPOSAL_TTL_MS) {
        await dropProposalWithLock(sid, id)
      } else {
        proposal = disk
      }
    }
  }
  if (!proposal) {
    // 2026-09-03 驗屍修復 R3-③（提案過期禁止靜默換案）：極限評測實錘（REPORT P1-4/摩擦點 2）——
    // 用戶選定方案過期後，agent 重新 propose 直接 apply 新 id，用戶批准被靜默替換。
    // 錯誤文案顯式封死該路徑：過期必須重新出卡請示，不許生成新 proposal 後直接套用。
    throw new DirectorNotFoundError("候选方案不存在或已过期，请重新生成；必须重新向用户出提案卡并等待用户批准，禁止生成新 proposal 后直接 apply")
  }
  pendingProposals.delete(id)
  const result = await applyDirectorOps(sid, [{ op: "replacePlans", plans: proposal.plans }], `apply ${id}`)
  await dropProposalWithLock(sid, id)
  return result
}

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

/** spec §3 POST /reset：清空會話導演工程（rm 目錄 + 清 announced 記錄 + 廣播重置） */
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

// ── HTTP 路由層（spec §3 六條；掛載與鑑權照 handleTimelineRoutes 慣例） ──────────
//
// index.ts 補丁在 Bearer sk-biz 閘門之後呼叫 handleDirectorRoutes(key, req, pathname)。
// 鑑權 = getOwnedSession 同款：resolveSession 三段解析（gateway UUID / opencode id 均收斂）
// + apiKey 比對防跨 key 越權；session_id 一律走 query（Bun Request body 只能讀一次）。

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
 * spec 亦允許 /agent/v1/director/:sid/* 形；兩形都收（:sid 優先，退回 query）。
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
  // 鑑權：resolveSession 收斂 opencode id → gateway UUID（timeline B2 修復同款）+ 跨 key 越權守衛
  const state = resolveFn?.(sid)
  if (!state || state.apiKey !== key) {
    return Response.json({ ok: false, error: { message: "session not found", type: "not_found", code: "not_found" } }, { status: 404 })
  }
  sid = state.sessionId
  try {
    if (req.method === "GET" && verb === "state") {
      // R1-#1：?mode=summary 剝 joints/keyframes 摘要輸出；缺省 full（前端兼容零風險）
      const mode = url.searchParams.get("mode") === "summary" ? "summary" : "full"
      return Response.json(await getDirectorState(sid, mode))
    }
    if (req.method === "POST" && verb === "op") {
      const body = (await req.json().catch(() => null)) as { op?: string; ops?: DirectorOp[]; reason?: string } & Record<string, unknown> | null
      if (!body) return Response.json({ ok: false, error: { message: "body must be JSON", type: "bad_request", code: "bad_request" } }, { status: 400 })
      // 兩形：{ops:[...]} 批量（工具層規格化）或 {op:"...", ...payload} 單發（原生形狀）
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
      // R3-⑤：群組 op 時透傳契約欄位（信封同現有 op，多回 group/removed_group_id）
      return Response.json({ ok: true, project: res.project, revision: res.revision, changed: res.changed, emitted: res.emitted, ...(res.group ? { group: res.group } : {}), ...(res.removed_group_id ? { removed_group_id: res.removed_group_id } : {}) })
    }
    if (req.method === "POST" && verb === "proposals") {
      const body = (await req.json().catch(() => null)) as { instruction?: string; shot_count?: unknown } | null
      if (!body || typeof body.instruction !== "string") {
        return Response.json({ ok: false, error: { message: "body.instruction is required", type: "bad_request", code: "bad_request" } }, { status: 400 })
      }
      // R3-④：可選 shot_count（int 1-12）；缺省由服務端從 instruction 解析
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
 * 單發 op 的 payload 欄位名轉換：HTTP 層用 snake_case（工具層慣例），op 聯合用 camelCase
 * （wheel DirectorPlan/DirectorSequenceShot 欄位名）。只轉已知鍵，值原樣透傳。
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
      // R1-#2：顯式 from 可覆蓋（工具層現不傳，raw API 逃生口）；to 缺參時不再虛構 (0,0,0)——
      // 交由 gateway 以「原地動作 to={...from}」接續求解（與原地動作語義一致）
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
          // R3-⑥：force 透傳（單發形逃生口；重疊守衛的強制覆蓋出口）
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
    // R3-⑤：群組單發形（工具層契約：{op:"addGroup", name, element_ids} / {op:"removeGroup", group_id}）
    case "addGroup": return { op, name: String(p.name ?? ""), element_ids: (p.element_ids ?? p.elementIds ?? []) as string[] }
    case "removeGroup": return { op, group_id: String(p.group_id ?? p.groupId ?? "") }
    case "undo": return { op }
    case "redo": return { op }
    case "checkpoint": return { op }
    case "save": return { op }
    default:
      // R3-⑦：未知 op 單發形與 applyDirectorOp 防衛同款文案（帶可用清單）
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
