import path from "node:path"
import type { AspectId, DirectorElement, DirectorPlan, DirectorSceneFile } from "../../lib/director-engine/types"
import { MOTION_TEMPLATES } from "../../lib/director-engine/motionTemplates"
import { CAMERA_TEMPLATES } from "../../lib/director-engine/cameraTemplates"
import { POSE_PRESETS } from "../../lib/director-engine/poses"

// 与 gateway/index.ts 同值；env 可覆盖（测试用）。timeline.ts L29 同款。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
// 2026-09-03 验尸修复 R3-⑧（隔离）：director 存储根可经 DIRECTOR_DATA_ROOT 移出 agent 可读区。
// 极限评测实锤（REPORT P1-3）：agent bash 在 workspace/ 内可读「其他会话」的 director/<sid>/current.json
// （本场读了 3 个别案 JSON）——数据隔离面 + 诱惑 agent 抄别案。
// 默认值保持现状（WORKSPACE_DIR/director）兼容本地测试；VPS 部署时 env 指 workspace 外新址
// （如 /opt/agent-harness/director-data），迁移用 `sudo mv` 旧目录（保留在途会话数据）。
export const DIRECTOR_DIR = process.env.DIRECTOR_DATA_ROOT || path.join(WORKSPACE_DIR, "director")

// 保留策略：最近 20 版 + 每 10 版里程碑版（v % 10 === 0），其余删（timeline.ts 同款）。
export const KEEP_RECENT = 20
export const MILESTONE_EVERY = 10

// proposals 暂存 TTL：30 分钟（kunpeng directorTools.ts pendingProposals 同款）。
export const PROPOSAL_TTL_MS = 30 * 60_000

/**
 * 2026-09-03 验尸修复 R3-⑦：已知 op 清单（未知 op 报错带可用清单；同时供 capabilities 暴露）。
 * 与 DirectorOp 联合逐项对齐，新增 op 必须同步此表。
 */
export const KNOWN_OPS: string[] = [
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
 * 2026-09-03 验尸修复 R3-②：能力清单进 state。
 * 极限评测实锤（REPORT P1-2）：state 无能力清单，agent 思维链 4 次抱怨「didn't return capabilities」，
 * 被迫 bash 翻档 130s（还翻到别会话工程档）。此处把 action/camera/pose 注册表 + op 集 + 群组/导出边界
 * 一次性如实暴露，agent 不再需要翻档猜能力。纯静态小数据，summary/full 两态都带。
 */
export interface DirectorCapabilities {
  /** 动作模板 key 清单（MOTION_TEMPLATES 注册表） */
  action_templates: string[]
  /** 运镜 key 清单（CAMERA_TEMPLATES 注册表） */
  camera_moves: string[]
  /** 素模姿势 key 清单（POSE_PRESETS 注册表） */
  poses: string[]
  /** 服务端支持的 op 清单（与 DirectorOp 联合对齐） */
  supported_ops: string[]
  /** 群组写路径边界声明（R3-⑤ 完成后如实标 true） */
  group_write: boolean
  /** 导出边界诚实声明：可截关键帧写 previz.keyframes；仍不保证 MP4 */
  export_boundary: string
}

export const DIRECTOR_CAPABILITIES: DirectorCapabilities = {
  action_templates: MOTION_TEMPLATES.map((t) => t.id),
  camera_moves: CAMERA_TEMPLATES.map((t) => t.id),
  poses: POSE_PRESETS.map((p) => p.id),
  supported_ops: KNOWN_OPS,
  group_write: true,
  export_boundary: "可截关键帧并写 previz.keyframes（director_capture_previz / 前端 capturePlanKeyframes）；仍不保证 MP4",
}

/** undo 历史快照（kunpeng directorStore.ts L39-45 HistorySnapshot 同构：JSON 序列化） */
export interface HistorySnapshot {
  elements: DirectorElement[]
  groups: DirectorGroup[]
  plans: DirectorPlan[]
  activePlanId: string | null
  activeShotId: string | null
}

export interface DirectorGroup {
  id: string
  name: string
  /** 2026-09-03 验尸修复 R3-⑤：群组写路径——成员元素 id 清单（与 element.groupId 双向同步）。 */
  elementIds: string[]
}

/**
 * 服务端导演工程文档 = kunpeng DirectorSceneFile（schema v2 栏位逐一同构：version/elements/
 * groups/plans/activePlanId/aspect/origin/exports/updatedAt）+ 会话扩展（revision/activeShotId/
 * currentTimeSec/playing/undo-redo 栈）。存盘兼容 wheel save() 产物。
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
  /** 播放状态（服务端扩展；wheel 在 store 内存，重开回 0） */
  currentTimeSec: number
  playing: boolean
  /** undo/redo JSON 快照栈（kunpeng HistorySnapshot 逐字同构） */
  undoStack: HistorySnapshot[]
  redoStack: HistorySnapshot[]
  updated_at: string
}

/** 决策日志条目（log.jsonl，append-only；timeline LogEntry 简化形） */
export interface DirectorLogEntry {
  at: string
  action: string
  revision: number
  changed: string[]
}

/** 健康检查形状（spec §4；wheel DirectorHealthIssue = {id, severity, shotId, message}） */
export interface DirectorHealth {
  ok: boolean
  issues: Array<{ code: string; message: string; shot_id?: string }>
}

// ── 错误（HTTP 层映射：not_initialized→409；invalid→400；not_found→404；blocked→409）──

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
