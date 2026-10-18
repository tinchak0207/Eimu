// 计划模式（EnterPlanMode / ExitPlanMode / plan floor）移植自 Claude Code 2.1.302。
// 行为取证：m0602 ExitPlanMode、m0245 plans 目录与文件读写、m0432 planModeWriteFloor。
//
// 约束：
// - 计划文件目录默认 HARNESS_STATE/plans；显式配置的目录必须落在工作区内。
// - 审批必须复用网关既有 confirm 卡（pendingConfirms + SSE + 用户答复端点），不得自动通过。
// - 计划模式下写操作由 planModeGuard 统一回 ask；只读工具放行。
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { CONFIRM_TIMEOUT_MS } from "./constants-gateway"
import { waitFor } from "./internal-waiters"
import { settleConfirm } from "./media-internal-routes"
import { getPolicyState, isPermissionMode, updateRules } from "./permission-policy"
import { resolveSession } from "./sessions-core"
import { emitToSession } from "./sse-core"
import { subagentParentState } from "./subagent"
import type { SessionState } from "./types-gateway"

export const NOT_IN_PLAN_MODE_MESSAGE =
  "You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first."
export const PLAN_FILE_MAX_BYTES = 2_000_000

export interface PlanSessionState {
  sessionId: string
  mode: "plan" | "exited"
  prePlanMode: string
  planSlug: string
  filePath: string
  createdAt: number
  exitedAt?: number
  pendingRequestId?: string
}

export interface EnterPlanModeResult {
  mode: "plan"
  planFilePath: string
  planSlug: string
  prePlanMode: string
}

export interface ExitPlanModeApproved {
  plan: string
  filePath: string
  approved: true
  prePlanMode: string
}

export interface ExitPlanModePending {
  plan: string
  filePath: string
  approved: false
  pending: true
  requestId: string
  reason: "pending"
}

export interface ExitPlanModeRejected {
  plan: string
  filePath: string
  approved: false
  pending: false
  requestId: string
  reason: "denied" | "expired"
}

export interface ExitPlanModeFailure {
  approved: false
  error: string
  code:
    | "not_in_plan_mode"
    | "missing_plan_file"
    | "session_not_found"
    | "plan_too_large"
    | "symlinked_plan_file"
}

export type ExitPlanModeResult =
  | ExitPlanModeApproved
  | ExitPlanModePending
  | ExitPlanModeRejected
  | ExitPlanModeFailure

export interface PlanGuardVerdict {
  behavior: "deny" | "ask" | "allow"
  reason: string
}

const PLAN_SCAFFOLD = "# Plan\n\n<!-- 在调用 ExitPlanMode 前，把完整计划写入本文件。 -->\n"
const PLAN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 计划目录不得落进控制目录（与写路径 safetyCheck 对齐）。 */
const FORBIDDEN_PLAN_DIR_SEGMENTS = new Set([".git", ".claude", ".ssh"])
const planStates = new Map<string, PlanSessionState>()

function workspaceRoot(): string {
  return process.env.HARNESS_WORKSPACE?.trim() || "/opt/agent-harness/workspace"
}

function stateRoot(): string {
  return process.env.HARNESS_STATE?.trim() || "/opt/agent-harness/state"
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function assertSafePlansDir(path: string): void {
  for (const segment of path.split(sep)) {
    if (FORBIDDEN_PLAN_DIR_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`plans directory must not contain a control directory segment: ${path}`)
    }
  }
}

/**
 * 计划目录解析：显式目录必须位于工作区内；缺省为 HARNESS_STATE/plans。
 * H6：拒绝落在 .git/.claude/.ssh 或工作区根；创建前后各校验一次，防 symlink 逃逸。
 */
export async function resolvePlansDir(configured?: string): Promise<string> {
  const explicit = (configured?.trim() || process.env.HARNESS_PLANS_DIR?.trim() || "").trim()
  const dir = explicit ? resolve(explicit) : join(stateRoot(), "plans")
  assertSafePlansDir(dir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await lstat(dir)
  if (stat.isSymbolicLink()) throw new Error(`plans directory must not be a symlink: ${dir}`)
  const real = await realpath(dir)
  assertSafePlansDir(real)
  const workspace = await realpath(resolve(workspaceRoot())).catch(() => resolve(workspaceRoot()))
  if (real === workspace) throw new Error(`plans directory must not be the workspace root: ${dir}`)
  if (explicit) {
    if (!isWithin(workspace, real)) throw new Error(`plans directory must be within workspace: ${dir}`)
  } else {
    const root = await realpath(resolve(stateRoot())).catch(() => resolve(stateRoot()))
    if (!isWithin(root, real)) throw new Error(`plans directory escapes state root: ${dir}`)
  }
  return real
}

function planSlugFor(sessionId: string): string {
  const base =
    sessionId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "session"
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8)
  const slug = `${base}-${hash}`.slice(0, 100)
  if (!PLAN_SLUG_RE.test(slug)) throw new Error(`invalid plan slug derived from session id: ${sessionId}`)
  return slug
}

async function ensurePlanFile(filePath: string): Promise<void> {
  try {
    const stat = await lstat(filePath)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlinked plan file: ${filePath}`)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    await writeFile(filePath, PLAN_SCAFFOLD, { encoding: "utf-8", flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

async function readPlanFile(filePath: string): Promise<{ plan: string } | { failure: ExitPlanModeFailure }> {
  let stat
  try {
    stat = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        failure: {
          approved: false,
          code: "missing_plan_file",
          error: `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        },
      }
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    return {
      failure: { approved: false, code: "symlinked_plan_file", error: `Refusing symlinked plan file at ${filePath}.` },
    }
  }
  if (!stat.isFile()) {
    return { failure: { approved: false, code: "missing_plan_file", error: `No plan file found at ${filePath}.` } }
  }
  if (stat.size > PLAN_FILE_MAX_BYTES) {
    return {
      failure: { approved: false, code: "plan_too_large", error: `Plan file at ${filePath} exceeds ${PLAN_FILE_MAX_BYTES} bytes.` },
    }
  }
  return { plan: await readFile(filePath, "utf-8") }
}

function findSession(sessionId: string): SessionState | null {
  return resolveSession(sessionId) ?? subagentParentState(sessionId) ?? null
}

export async function enterPlanMode(
  sessionId: string,
  options: { prePlanMode?: string; plansDir?: string } = {},
): Promise<EnterPlanModeResult> {
  const sid = sessionId?.trim()
  if (!sid) throw new Error("sessionId is required")
  const existing = planStates.get(sid)
  if (existing?.mode === "plan") {
    await ensurePlanFile(existing.filePath)
    // H6：权限引擎与计划状态保持一致（幂等）。
    updateRules({ sessionId: sid, action: "setMode", mode: "plan" })
    return {
      mode: "plan",
      planFilePath: existing.filePath,
      planSlug: existing.planSlug,
      prePlanMode: existing.prePlanMode,
    }
  }
  const dir = await resolvePlansDir(options.plansDir)
  const slug = planSlugFor(sid)
  const filePath = join(dir, `${slug}.md`)
  await ensurePlanFile(filePath)
  // prePlanMode 只能取自服务端权限状态；请求体不能借此指定 bypassPermissions。
  const policy = getPolicyState(sid)
  const currentMode = policy.mode === "plan" ? policy.prePlanMode ?? "default" : policy.mode
  const requested = options.prePlanMode?.trim()
  const prePlanMode =
    requested && isPermissionMode(requested) && requested !== "bypassPermissions" ? requested : currentMode
  const record: PlanSessionState = {
    sessionId: sid,
    mode: "plan",
    prePlanMode,
    planSlug: slug,
    filePath,
    createdAt: Date.now(),
  }
  planStates.set(sid, record)
  // H6：进入计划模式同时驱动权限引擎（prePlanMode 由权限内核记录）。
  updateRules({ sessionId: sid, action: "setMode", mode: "plan" })
  const state = findSession(sid)
  if (state) emitToSession(state, "plan.mode", { mode: "plan", pre_plan_mode: prePlanMode, plan_file_path: filePath })
  return { mode: "plan", planFilePath: filePath, planSlug: slug, prePlanMode }
}

/** H6：退出计划模式时恢复原权限模式；不可用则降级 default。 */
function restorePolicyMode(sessionId: string, prePlanMode: string): void {
  const target = isPermissionMode(prePlanMode) ? prePlanMode : "default"
  const restored = updateRules({ sessionId, action: "setMode", mode: target })
  if (!restored.ok && target !== "default") {
    updateRules({ sessionId, action: "setMode", mode: "default" })
  }
}

function finalizeApproval(record: PlanSessionState, plan: string, state: SessionState | null): ExitPlanModeApproved {
  record.mode = "exited"
  record.exitedAt = Date.now()
  record.pendingRequestId = undefined
  restorePolicyMode(record.sessionId, record.prePlanMode)
  if (state) {
    emitToSession(state, "plan.mode", {
      mode: record.prePlanMode,
      approved: true,
      plan_file_path: record.filePath,
    })
  }
  return { plan, filePath: record.filePath, approved: true, prePlanMode: record.prePlanMode }
}

/**
 * 退出计划模式。waitMs>0 时在网关内等待用户答复（分片 waitFor，避免超过 HTTP idle timeout）。
 * 审批卡 request_id = plan_<id>，走既有 /agent/v1/sessions/:id/confirm 答复端点。
 */
export async function exitPlanMode(
  sessionId: string,
  options: { waitMs?: number } = {},
): Promise<ExitPlanModeResult> {
  const sid = sessionId?.trim()
  if (!sid) throw new Error("sessionId is required")
  const record = planStates.get(sid)
  if (!record || record.mode !== "plan") {
    return { approved: false, code: "not_in_plan_mode", error: NOT_IN_PLAN_MODE_MESSAGE }
  }
  const read = await readPlanFile(record.filePath)
  if ("failure" in read) return read.failure
  const plan = read.plan
  const state = findSession(sid)
  if (!state) {
    return {
      approved: false,
      code: "session_not_found",
      error: `session not found: ${sid}`,
    }
  }

  let requestId = record.pendingRequestId
  const prior = requestId ? state.resolvedConfirms.get(requestId) : undefined
  if (prior) {
    if (prior.outcome === "approved") return finalizeApproval(record, plan, state)
    // 上一次被拒/过期：清掉后重新发一张卡。
    record.pendingRequestId = undefined
    requestId = undefined
  }
  if (!requestId || !state.pendingConfirms.has(requestId)) {
    requestId = `plan_${randomUUID().replace(/-/g, "").slice(0, 12)}`
    const timer = setTimeout(() => settleConfirm(state, requestId as string, "expired"), CONFIRM_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    state.pendingConfirms.set(requestId, { timer })
    record.pendingRequestId = requestId
    const preview = plan.length > 4_000 ? `${plan.slice(0, 4_000)}\n…` : plan
    emitToSession(state, "confirm.request", {
      request_id: requestId,
      amount_coins: 0,
      kind: "plan_mode",
      plan_file_path: record.filePath,
      description: `计划模式审批：批准后恢复 ${record.prePlanMode} 模式并开始执行。\n计划文件：${record.filePath}\n\n${preview}`,
    })
  }

  const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, CONFIRM_TIMEOUT_MS))
  const deadline = Date.now() + waitMs
  for (;;) {
    const settled = state.resolvedConfirms.get(requestId)
    if (settled) {
      if (settled.outcome === "approved") return finalizeApproval(record, plan, state)
      record.pendingRequestId = undefined
      if (state) emitToSession(state, "plan.mode", { mode: "plan", approved: false, plan_file_path: record.filePath })
      return {
        plan,
        filePath: record.filePath,
        approved: false,
        pending: false,
        requestId,
        reason: settled.outcome === "denied" ? "denied" : "expired",
      }
    }
    if (!state.pendingConfirms.has(requestId)) {
      // 已从 pending 移除但没留下 outcome（保留窗口被挤掉）：fail closed。
      record.pendingRequestId = undefined
      return {
        plan,
        filePath: record.filePath,
        approved: false,
        pending: false,
        requestId,
        reason: "expired",
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { plan, filePath: record.filePath, approved: false, pending: true, requestId, reason: "pending" }
    }
    await waitFor(`confirm:${state.sessionId}:${requestId}`, Math.min(remaining, 25_000))
  }
}

export function getPlanState(sessionId: string): {
  mode: "plan" | "default"
  /** H5：显式布尔，插件只认这个字段判定计划状态。 */
  inPlanMode: boolean
  prePlanMode?: string
  planSlug?: string
  planFilePath?: string
  pendingRequestId?: string
  enteredAt?: number
  exitedAt?: number
} {
  const sid = sessionId?.trim()
  if (!sid) throw new Error("sessionId is required")
  const record = planStates.get(sid)
  if (!record) return { mode: "default", inPlanMode: false }
  return {
    mode: record.mode === "plan" ? "plan" : "default",
    inPlanMode: record.mode === "plan",
    prePlanMode: record.prePlanMode,
    planSlug: record.planSlug,
    planFilePath: record.filePath,
    ...(record.pendingRequestId ? { pendingRequestId: record.pendingRequestId } : {}),
    enteredAt: record.createdAt,
    ...(record.exitedAt ? { exitedAt: record.exitedAt } : {}),
  }
}

/**
 * H6：计划模式只读工具的唯一真源。
 * 网关通过 /internal/plan/state 的 read_only_tools 下发；插件不再自带第二份清单。
 */
export const PLAN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  [
    "read",
    "list",
    "ls",
    "glob",
    "grep",
    "webfetch",
    "websearch",
    "whoami",
    "lsp_diagnostics",
    "task_list",
    "task_get",
    "subagent_status",
    "workflow_status",
    "workflow_history",
    "image_get_result",
    "video_result_fetch",
    "memory_recall",
    "asset_search",
    "asset_get",
    "character_card_list",
    "search_web",
    "search_aggregate",
    "smart_search",
    "video_analyze",
    "video_measure",
    "video_transcribe",
    "video_evidence",
    "vision_analyze",
    "read_image",
    "timeline_query",
    "canvas_get_state",
    "director_get_state",
    "quota",
  ].map((name) => name.toLowerCase()),
)

const PLAN_MODE_EXEMPT_TOOLS = new Set(
  ["enterplanmode", "exitplanmode", "askuserquestion", "enter_plan_mode", "exit_plan_mode", "ask_parent"].map((name) =>
    name.toLowerCase(),
  ),
)

/**
 * plan floor：plan 模式下写操作回 ask，只读与计划工具放行。
 * 集成点：opencode plugin eimu-guard 的 tool.execute.before（需要传入 sessionID）。
 */
export function planModeGuard(
  tool: string | { name?: string; isReadOnly?: boolean | ((input: unknown) => boolean) },
  input: unknown,
  options: { sessionId?: string } = {},
): PlanGuardVerdict {
  const name = (typeof tool === "string" ? tool : tool?.name) ?? ""
  const lower = name.toLowerCase()
  const inputSid =
    input && typeof input === "object"
      ? (() => {
          const record = input as Record<string, unknown>
          return typeof record.session_id === "string"
            ? record.session_id
            : typeof record.sessionId === "string"
              ? record.sessionId
              : undefined
        })()
      : undefined
  let sessionId = options.sessionId?.trim() || inputSid
  if (!sessionId) {
    const active = [...planStates.values()].filter((record) => record.mode === "plan")
    if (active.length === 1) sessionId = active[0].sessionId
  }
  const inPlanMode = sessionId ? planStates.get(sessionId)?.mode === "plan" : false
  if (!inPlanMode) return { behavior: "allow", reason: "" }
  if (!name || PLAN_MODE_EXEMPT_TOOLS.has(lower)) return { behavior: "allow", reason: "" }

  let readOnly: boolean | undefined
  if (typeof tool === "object" && tool !== null) {
    if (typeof tool.isReadOnly === "boolean") readOnly = tool.isReadOnly
    else if (typeof tool.isReadOnly === "function") {
      try {
        readOnly = tool.isReadOnly(input)
      } catch {
        readOnly = false
      }
    }
  }
  if (readOnly ?? PLAN_READ_ONLY_TOOLS.has(lower)) return { behavior: "allow", reason: "" }
  return { behavior: "ask", reason: `Cannot call ${name} while in plan mode.` }
}
