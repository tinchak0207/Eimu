// 计划模式（EnterPlanMode / ExitPlanMode / plan floor）移植自 Claude Code 2.1.302。
// 行为取证：m0602 ExitPlanMode、m0245 plans 目录与文件读写、m0432 planModeWriteFloor。
//
// 约束：
// - 计划文件目录默认 HARNESS_STATE/plans；显式配置的目录必须落在工作区内。
// - 审批必须复用网关既有 confirm 卡（pendingConfirms + SSE + 用户答复端点），不得自动通过。
// - 计划模式下写操作由 planModeGuard 统一回 ask；只读工具放行。
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { CONFIRM_TIMEOUT_MS } from "./constants-gateway"
import { waitFor } from "./internal-waiters"
import { settleConfirm } from "./media-internal-routes"
import { PLAN_READ_ONLY_TOOLS, getPolicyState, isPermissionMode, updateRules } from "./permission-policy"
import { loadHarnessSecurityState, saveHarnessSecurityState, withHarnessSecurityTransaction } from "./persistence"
import { billingPermissionTenant } from "./charge-approval-policy"
import { resolveSession } from "./sessions-core"
import { emitToSession } from "./sse-core"
import { subagentParentState } from "./subagent"
import type { SessionState } from "./types-gateway"

// H6：计划只读清单单一真源在 permission-policy；plan-http 下发给插件。
export { PLAN_READ_ONLY_TOOLS }

export const NOT_IN_PLAN_MODE_MESSAGE =
  "You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first."
export const PLAN_FILE_MAX_BYTES = 2_000_000

export interface PlanSessionState {
  durableRevision: number
  sessionId: string
  mode: "plan" | "exited"
  prePlanMode: string
  planSlug: string
  filePath: string
  createdAt: number
  exitedAt?: number
  pendingRequestId?: string
  pendingPlanHash?: string
  permissionTenant?: string
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
    | "empty_plan"
    | "symlinked_plan_file"
    | "plan_changed"
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
const MAX_PLAN_STATES = 500
const PLAN_STATE_TTL_MS = 24 * 60 * 60 * 1000
const planStates = new Map<string, PlanSessionState>()

function readPlanState(sessionId: string): PlanSessionState | undefined {
  const saved = loadHarnessSecurityState("plan", sessionId)
  if (!saved) {
    planStates.delete(sessionId)
    return undefined
  }
  const cached = planStates.get(sessionId)
  if (cached && cached.durableRevision === saved.revision) return cached
  const raw = saved.data as PlanSessionState | null
  if (!raw || raw.sessionId !== sessionId || (raw.mode !== "plan" && raw.mode !== "exited") ||
      !isPermissionMode(raw.prePlanMode) || raw.prePlanMode === "bypassPermissions" ||
      typeof raw.planSlug !== "string" || !PLAN_SLUG_RE.test(raw.planSlug) ||
      typeof raw.filePath !== "string" || resolve(raw.filePath) !== raw.filePath ||
      (raw.permissionTenant !== undefined && (typeof raw.permissionTenant !== "string" || !raw.permissionTenant)) ||
      !Number.isFinite(raw.createdAt)) throw new Error("harness_plan_state_invalid")
  // 审批是当前进程的一次性状态，重启/跨进程加载必须重新发卡，不恢复旧授权。
  const record: PlanSessionState = { ...raw, durableRevision: saved.revision, pendingRequestId: undefined, pendingPlanHash: undefined }
  planStates.set(sessionId, record)
  trimPlanCache()
  return record
}

/** 计划文件仍是进入时写入的 scaffold（或只有空白/注释）：视为未写计划。 */
function isScaffoldOrEmptyPlan(text: string): boolean {
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#\s*Plan\s*$/gim, "")
    .trim()
  if (!stripped) return true
  return stripped === PLAN_SCAFFOLD.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#\s*Plan\s*$/gim, "").trim()
}

/** 审批中的记录不能淘汰；其他计划可随时从数据库恢复。 */
function rememberPlanState(record: PlanSessionState): void {
  try {
    const revision = saveHarnessSecurityState("plan", record.sessionId, {
      ...record, durableRevision: undefined, pendingRequestId: undefined, pendingPlanHash: undefined,
      prePlanMode: record.prePlanMode === "bypassPermissions" ? "default" : record.prePlanMode,
    }, record.durableRevision)
    record.durableRevision = revision
  } catch (error) {
    planStates.delete(record.sessionId)
    throw error
  }
  planStates.set(record.sessionId, record)
  trimPlanCache()
}

function trimPlanCache(): void {
  const cutoff = Date.now() - PLAN_STATE_TTL_MS
  for (const [id, candidate] of planStates) {
    if (candidate.mode !== "plan" && (candidate.exitedAt ?? candidate.createdAt) < cutoff) {
      planStates.delete(id)
    }
  }
  while (planStates.size > MAX_PLAN_STATES) {
    let removed = false
    for (const [id, candidate] of planStates) {
      if (candidate.pendingRequestId) continue
      planStates.delete(id)
      removed = true
      break
    }
    // 淘汰只移除缓存，活跃计划仍可从数据库恢复。
    if (!removed) break
  }
}

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
  const workspacePath = resolve(workspaceRoot())
  // 请求指定目录先做词法包含检查，拒绝前不能在任意位置创建目录。
  if (explicit && (!isWithin(workspacePath, dir) || dir === workspacePath)) {
    throw new Error("plans directory must be within workspace and below its root")
  }
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
  await sharePlanAccess(real, true)
  return real
}

/** 分离服务账户时，仅向配置的运行时组开放计划目录；默认仍保持私有。 */
async function sharePlanAccess(target: string, directory: boolean): Promise<void> {
  const raw = process.env.HARNESS_PLAN_GID?.trim()
  if (!raw) return
  const gid = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(gid) || gid > 0xfffffffe) {
    throw new Error("invalid HARNESS_PLAN_GID")
  }
  // 使用不跟随链接的 fd 修改权限，避免共享目录中的换链改到其他文件。
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0))
  try {
    const stat = await handle.stat()
    if (stat.uid !== process.getuid?.() || (!directory && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error("refusing to share a plan path not owned by the gateway")
    }
    await handle.chown(stat.uid, gid)
    await handle.chmod(directory ? 0o770 : 0o660)
  } finally {
    await handle.close()
  }
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
    await sharePlanAccess(filePath, false)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    await writeFile(filePath, PLAN_SCAFFOLD, { encoding: "utf-8", flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  await sharePlanAccess(filePath, false)
}

async function readPlanFile(filePath: string): Promise<{ plan: string; sha256: string } | { failure: ExitPlanModeFailure }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // 直接打开拒绝链接的 fd，校验与读取使用同一个对象，避免 lstat → readFile 换链。
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) {
      return { failure: { approved: false, code: "missing_plan_file", error: "Plan must be a regular file with one link." } }
    }
    const buffer = Buffer.alloc(PLAN_FILE_MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
    }
    if (stat.size > PLAN_FILE_MAX_BYTES || bytes > PLAN_FILE_MAX_BYTES) {
      return { failure: { approved: false, code: "plan_too_large", error: `Plan exceeds ${PLAN_FILE_MAX_BYTES} bytes.` } }
    }
    const content = buffer.subarray(0, bytes)
    return { plan: content.toString("utf-8"), sha256: createHash("sha256").update(content).digest("hex") }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { failure: { approved: false, code: "missing_plan_file", error: `No plan file found at ${filePath}.` } }
    if (code === "ELOOP") return { failure: { approved: false, code: "symlinked_plan_file", error: "Refusing symlinked plan file." } }
    throw error
  } finally {
    await handle?.close()
  }
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
  const state = findSession(sid)
  const tenant = state ? await billingPermissionTenant(state) : "default"
  if (!tenant) throw new Error("plan_session_has_no_tenant")
  const existing = readPlanState(sid)
  if (existing?.mode === "plan") {
    await sharePlanAccess(dirname(existing.filePath), true)
    await ensurePlanFile(existing.filePath)
    // H6：权限引擎与计划状态保持一致（幂等）。内部转移不改会话显式 setMode。
    setPlanPolicyMode(sid, existing.permissionTenant ?? tenant)
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
  const policy = getPolicyState(sid, tenant)
  const currentMode = policy.mode === "plan" ? policy.prePlanMode ?? "default" : policy.mode
  const prePlanMode = currentMode
  const record: PlanSessionState = {
    durableRevision: existing?.durableRevision ?? 0,
    sessionId: sid,
    permissionTenant: tenant,
    mode: "plan",
    prePlanMode,
    planSlug: slug,
    filePath,
    createdAt: Date.now(),
  }
  withHarnessSecurityTransaction(() => {
    setPlanPolicyMode(sid, tenant)
    rememberPlanState(record)
  })
  if (state) emitToSession(state, "plan.mode", { mode: "plan", pre_plan_mode: prePlanMode, plan_file_path: filePath })
  return { mode: "plan", planFilePath: filePath, planSlug: slug, prePlanMode }
}

function setPlanPolicyMode(sessionId: string, tenant: string): void {
  const result = updateRules({ sessionId, tenant, action: "setMode", mode: "plan", fromPlanTransition: true })
  if (!result.ok) throw new Error(`plan_permission_transition_failed: ${result.code}`)
}

/** H6：退出计划模式时恢复原权限模式；不可用则降级 default。 */
function restorePolicyMode(sessionId: string, prePlanMode: string, tenant: string): void {
  const target = isPermissionMode(prePlanMode) ? prePlanMode : "default"
  const restored = updateRules({ sessionId, tenant, action: "setMode", mode: target, fromPlanTransition: true })
  if (!restored.ok && target !== "default") {
    const fallback = updateRules({ sessionId, tenant, action: "setMode", mode: "default", fromPlanTransition: true })
    if (!fallback.ok) throw new Error(`plan_permission_transition_failed: ${fallback.code}`)
  } else if (!restored.ok) {
    throw new Error(`plan_permission_transition_failed: ${restored.code}`)
  }
}

async function finalizeApproval(record: PlanSessionState, plan: string, state: SessionState, requestId: string): Promise<ExitPlanModeApproved | ExitPlanModeFailure> {
  // 授权绑定发卡时的完整内容和请求；不能拿旧卡批准随后改写的计划。
  const tenant = record.permissionTenant ?? await billingPermissionTenant(state)
  if (!tenant) throw new Error("plan_session_has_no_tenant")
  const read = await readPlanFile(record.filePath)
  if ("failure" in read) return read.failure
  const current = readPlanState(record.sessionId)
  if (current !== record || current.mode !== "plan" || record.pendingRequestId !== requestId ||
      !record.pendingPlanHash || record.pendingPlanHash !== read.sha256 || read.plan !== plan) {
    return { approved: false, code: "plan_changed", error: "计划或审批请求已变化，请重新请求批准。" }
  }
  const exited: PlanSessionState = { ...record, mode: "exited", exitedAt: Date.now(), pendingRequestId: undefined, pendingPlanHash: undefined }
  withHarnessSecurityTransaction(() => {
    restorePolicyMode(record.sessionId, record.prePlanMode, tenant)
    rememberPlanState(exited)
  })
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
  const record = readPlanState(sid)
  if (!record || record.mode !== "plan") {
    return { approved: false, code: "not_in_plan_mode", error: NOT_IN_PLAN_MODE_MESSAGE }
  }
  const read = await readPlanFile(record.filePath)
  if ("failure" in read) return read.failure
  const plan = read.plan
  // 计划文件仍是进入时的 scaffold：不拿模板冒充计划去审批。
  if (isScaffoldOrEmptyPlan(plan)) {
    return {
      approved: false,
      code: "empty_plan",
      error: `计划文件 ${record.filePath} 仍是空白/模板。请先把完整计划写入 plan_file_path，再调用 exit_plan_mode。`,
    }
  }
  const state = findSession(sid)
  if (!state) {
    return {
      approved: false,
      code: "session_not_found",
      error: `session not found: ${sid}`,
    }
  }

  const planHash = read.sha256
  if (record.pendingRequestId && record.pendingPlanHash !== planHash) {
    // 计划变更作废旧卡，并唤醒持有旧请求的并发等待者。
    settleConfirm(state, record.pendingRequestId, "denied")
    record.pendingRequestId = undefined
    record.pendingPlanHash = undefined
  }
  let requestId = record.pendingRequestId
  const prior = requestId ? state.resolvedConfirms.get(requestId) : undefined
  if (requestId && prior) {
    if (prior.outcome === "approved") return finalizeApproval(record, plan, state, requestId)
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
    record.pendingPlanHash = planHash
    planStates.set(sid, record)
    trimPlanCache()
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
    if (record.pendingRequestId !== requestId) {
      return { approved: false, code: "plan_changed", error: "计划或审批请求已变化，请重新请求批准。" }
    }
    const settled = state.resolvedConfirms.get(requestId)
    if (settled) {
      if (settled.outcome === "approved") return finalizeApproval(record, plan, state, requestId)
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
  const record = readPlanState(sid)
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
 * H6：计划模式只读工具的唯一真源（permission-policy.ts 的 PLAN_READ_ONLY_TOOLS，
 * 本档再导出供 plan-http 下发；插件 fallback 必须与该表逐项一致）。
 */
const PLAN_MODE_EXEMPT_TOOLS = new Set(
  ["enterplanmode", "exitplanmode", "askuserquestion", "ask", "enter_plan_mode", "exit_plan_mode", "ask_parent"].map(
    (name) => name.toLowerCase(),
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
  const planRecord = sessionId ? readPlanState(sessionId) : undefined
  const inPlanMode = planRecord?.mode === "plan"
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

  // 写计划文件本身是计划模式的合法动作；不能把唯一的出口也挡住。
  const planFilePath = planRecord?.filePath
  if (planFilePath && isPlanFileTarget(name, input, planFilePath)) return { behavior: "allow", reason: "" }

  return { behavior: "ask", reason: `Cannot call ${name} while in plan mode.` }
}

const PLAN_FILE_WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
  "notebook_edit",
  "str_replace",
  "create_file",
])

function isPlanFileTarget(tool: string, input: unknown, planFilePath: string): boolean {
  if (!PLAN_FILE_WRITE_TOOLS.has(tool.toLowerCase())) return false
  if (!input || typeof input !== "object") return false
  const record = input as Record<string, unknown>
  const candidates: string[] = []
  for (const key of ["filePath", "file_path", "path", "notebook_path", "notebookPath"]) {
    const value = record[key]
    if (typeof value === "string" && value) candidates.push(value)
  }
  const patchText =
    typeof record.patchText === "string"
      ? record.patchText
      : typeof record.patch_text === "string"
        ? record.patch_text
        : ""
  for (const match of patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+)$/gm)) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }
  for (const match of patchText.matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm)) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }
  if (candidates.length === 0) return false
  const target = resolve(planFilePath)
  return candidates.every((candidate) => resolve(candidate.trim()) === target)
}
