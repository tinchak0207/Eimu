import {
  createTask,
  getTask,
  updateTask,
  listTasks,
  TaskValidationError,
  TASK_SUBJECT_MAX_CHARS,
  TASK_DESCRIPTION_MAX_CHARS,
  type TaskUpdatePatch,
} from "./task-board"
import { sendTaskAssignment, resolveRecipient, MailboxRecipientError, MailboxValidationError } from "./agent-mailbox"
import { jsonError } from "./gw-lib"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"

// POST /internal/task/{create,get,update,list}。
// loopback 鉴权由 router 上游的 /internal/* 闸门负责，这里不重复。
// 子会话（opencode subagent session）一律归一到父 gateway 会话，
// 与 goal-http.ts / mailbox-http.ts 同一套 resolveSession/subagentParentState 轮子。

const PREFIX = "/internal/task/"

/**
 * P2-13：可选内部令牌。设置 HARNESS_INTERNAL_TOKEN 时，本轮 12 组 harness 家族一律要求
 * `X-Internal-Token`；未设置时保持既有 loopback 信任边界（并只告警一次）。
 */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function internalTokenRejection(req: Request): Response | null {
  const expected = process.env.HARNESS_INTERNAL_TOKEN
  if (typeof expected === "string" && expected) {
    const supplied = req.headers.get("x-internal-token") ?? ""
    if (!tokensEqual(supplied, expected)) {
      return jsonError(403, "invalid or missing X-Internal-Token", "forbidden", "internal_token_required")
    }
    return null
  }
  const global = globalThis as { __harnessInternalTokenWarned?: boolean }
  if (!global.__harnessInternalTokenWarned) {
    global.__harnessInternalTokenWarned = true
    console.warn(
      "[gateway] HARNESS_INTERNAL_TOKEN unset; harness internal routes rely on the loopback trust boundary only",
    )
  }
  return null
}

const OWNER_NAME_MAX_CHARS = 64

/**
 * P2-4：owner 是「任意合法 agent 名」而不是必须已注册的收件人。默认只做形状校验；
 * HARNESS_TASK_OWNER_STRICT=1 时恢复「必须已在邮箱团队注册」的旧校验（可配置）。
 */
function validateOwnerName(owner: string): string | null {
  if (!owner) return null
  if (owner.length > OWNER_NAME_MAX_CHARS) return `owner must be at most ${OWNER_NAME_MAX_CHARS} characters`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(owner)) return "owner must not contain control characters"
  if (owner === "*") return 'owner must be a single agent name (broadcast "*" is not supported)'
  if (owner.includes("@")) return "owner must be a bare agent name"
  return null
}

function ownerStrictMode(): boolean {
  const raw = (process.env.HARNESS_TASK_OWNER_STRICT ?? "").trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes"
}

/** 把 opencode 子会话 id 收敛到父 gateway 会话 id；解析不到时保持原值。 */
export function canonicalTaskSessionId(sessionId: string): string {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : sessionId
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payloadOf(body: Record<string, unknown>): Record<string, unknown> {
  return isPlainRecord(body.payload) ? body.payload : body
}

function taskIdOf(payload: Record<string, unknown>): number | null {
  const value = payload.taskId
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function positiveIdArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0) ? (value as number[]) : null
}

// ── assignment 补投（P1）────────────────────────────────────────────────────
// delivered:false / 投递抛错时不再一次性丢掉：同一份帧（含稳定 msg_id 与 timestamp）
// 留在待投队列，下一次 update 或 30s ticker 补投；同一 task 只保留最新一帧。
type PendingAssignment = {
  sessionId: string
  to: string
  task: { id: number; subject: string; description: string }
  msgId: string
  timestamp: string
}
const pendingAssignments = new Map<string, PendingAssignment>()
let assignmentRetryTimer: ReturnType<typeof setInterval> | undefined

function assignmentKey(sessionId: string, taskId: number): string {
  return `${sessionId}:${taskId}`
}

function flushPendingAssignments(): void {
  for (const [key, pending] of pendingAssignments) {
    try {
      // 补投是派工动作，必须以任务当前归属和生命周期为准。
      // 释放认领、改派、删除或完成后，旧帧不能再启动旧 worker。
      const task = getTask(pending.sessionId, pending.task.id)
      if (!task || task.owner !== pending.to || task.status === "completed") {
        pendingAssignments.delete(key)
        continue
      }
      // 只有尚未成功落库的帧会保留在队列；使用当前任务内容，稳定投递ID不变。
      const frame = sendTaskAssignment(pending.sessionId, pending.to, task, undefined, {
        msgId: pending.msgId,
        timestamp: pending.timestamp,
      })
      // duplicate=true 表示同一帧已在邮箱里（幂等命中），等价于已投递成功。
      if (frame.delivered === true || frame.duplicate === true) pendingAssignments.delete(key)
    } catch (e) {
      if (!(e instanceof MailboxRecipientError)) {
        console.error("[gateway] task assignment retry failed:", e)
      }
    }
  }
  if (pendingAssignments.size === 0 && assignmentRetryTimer) {
    clearInterval(assignmentRetryTimer)
    assignmentRetryTimer = undefined
  }
}

function queueAssignment(pending: PendingAssignment): void {
  pendingAssignments.set(assignmentKey(pending.sessionId, pending.task.id), pending)
  if (!assignmentRetryTimer) {
    assignmentRetryTimer = setInterval(flushPendingAssignments, 30_000)
    // 不让补投 ticker 阻止进程退出（bun/node 均有 unref）。
    ;(assignmentRetryTimer as unknown as { unref?: () => void }).unref?.()
  }
}

function deliverAssignment(pending: PendingAssignment): boolean {
  try {
    const frame = sendTaskAssignment(pending.sessionId, pending.to, pending.task, undefined, {
      msgId: pending.msgId,
      timestamp: pending.timestamp,
    })
    if (frame.delivered === true || frame.duplicate === true) {
      pendingAssignments.delete(assignmentKey(pending.sessionId, pending.task.id))
      return true
    }
    queueAssignment(pending)
    return false
  } catch (e) {
    // P2-4：非严格模式下 owner 可以是未注册的合法 agent 名——任务归属成立，邮箱帧进
    // 待投队列，等成员登记后的下一次 update / ticker 补投；不刷错误日志。
    if (!(e instanceof MailboxRecipientError)) {
      console.error("[gateway] task assignment frame failed:", e)
    }
    queueAssignment(pending)
    return false
  }
}

export async function handleTaskBoard(req: Request, pathname: string): Promise<Response> {
  const tokenError = internalTokenRejection(req)
  if (tokenError) return tokenError
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!isPlainRecord(parsed)) return jsonError(400, "json body must be an object", "bad_request", "bad_request")
  const body = parsed
  const sessionId = canonicalTaskSessionId(typeof body.session_id === "string" ? body.session_id.trim() : "")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const payload = payloadOf(body)

  try {
    switch (pathname.slice(PREFIX.length)) {
      case "create": {
        const subject = typeof payload.subject === "string" ? payload.subject.trim() : ""
        const description = typeof payload.description === "string" ? payload.description.trim() : ""
        if (!subject) return jsonError(400, "subject is required", "bad_request", "bad_request")
        if (!description) return jsonError(400, "description is required", "bad_request", "bad_request")
        if (subject.length > TASK_SUBJECT_MAX_CHARS) {
          return jsonError(400, `subject must be at most ${TASK_SUBJECT_MAX_CHARS} characters`, "bad_request", "bad_request")
        }
        if (description.length > TASK_DESCRIPTION_MAX_CHARS) {
          return jsonError(
            400,
            `description must be at most ${TASK_DESCRIPTION_MAX_CHARS} characters`,
            "bad_request",
            "bad_request",
          )
        }
        if (payload.activeForm !== undefined && payload.activeForm !== null && typeof payload.activeForm !== "string") {
          return jsonError(400, "activeForm must be a string", "bad_request", "bad_request")
        }
        if (payload.metadata !== undefined && !isPlainRecord(payload.metadata)) {
          return jsonError(400, "metadata must be an object", "bad_request", "bad_request")
        }
        const created = createTask(sessionId, {
          subject,
          description,
          activeForm: typeof payload.activeForm === "string" ? payload.activeForm : null,
          metadata: isPlainRecord(payload.metadata) ? payload.metadata : undefined,
        })
        return Response.json({ success: true, ...created })
      }
      case "get": {
        const taskId = taskIdOf(payload)
        if (taskId === null) return jsonError(400, "taskId must be a positive integer", "bad_request", "bad_request")
        const task = getTask(sessionId, taskId)
        if (!task) return Response.json({ success: false, error: "Task not found" })
        return Response.json({ success: true, task })
      }
      case "update": {
        const taskId = taskIdOf(payload)
        if (taskId === null) return jsonError(400, "taskId must be a positive integer", "bad_request", "bad_request")
        if (payload.force !== undefined && typeof payload.force !== "boolean") {
          return jsonError(400, "force must be a boolean", "bad_request", "bad_request")
        }
        const patch: TaskUpdatePatch = {}
        if (payload.status !== undefined) {
          if (typeof payload.status !== "string") return jsonError(400, "status must be a string", "bad_request", "bad_request")
          patch.status = payload.status
        }
        if (payload.subject !== undefined) {
          if (typeof payload.subject !== "string") return jsonError(400, "subject must be a string", "bad_request", "bad_request")
          if (payload.subject.trim().length > TASK_SUBJECT_MAX_CHARS) {
            return jsonError(400, `subject must be at most ${TASK_SUBJECT_MAX_CHARS} characters`, "bad_request", "bad_request")
          }
          patch.subject = payload.subject
        }
        if (payload.description !== undefined) {
          if (typeof payload.description !== "string") {
            return jsonError(400, "description must be a string", "bad_request", "bad_request")
          }
          if (payload.description.trim().length > TASK_DESCRIPTION_MAX_CHARS) {
            return jsonError(
              400,
              `description must be at most ${TASK_DESCRIPTION_MAX_CHARS} characters`,
              "bad_request",
              "bad_request",
            )
          }
          patch.description = payload.description
        }
        if (payload.activeForm !== undefined) {
          if (payload.activeForm !== null && typeof payload.activeForm !== "string") {
            return jsonError(400, "activeForm must be a string or null", "bad_request", "bad_request")
          }
          patch.activeForm = payload.activeForm as string | null
        }
        if (payload.owner !== undefined) {
          if (payload.owner !== null && typeof payload.owner !== "string") {
            return jsonError(400, "owner must be a string or null", "bad_request", "bad_request")
          }
          if (payload.owner === null) {
            // P2-4：null 与空字符串同义＝释放认领。
            patch.owner = null
          } else {
            // 上方已把 owner 收窄到 string；strictNullChecks=false 下 unknown 不会按
            // typeof 收窄，这里用 String() 取值（对 string 是恒等，不改行为）。
            const owner = String(payload.owner).trim()
            if (!owner) {
              // 工具描述承诺「空字符串或 null 释放认领」，HTTP 必须与之一致。
              patch.owner = null
            } else {
              const nameError = validateOwnerName(owner)
              if (nameError) return jsonError(400, nameError, "bad_request", "bad_request")
              // 默认允许任意合法 agent 名（示例 owner:"director" 可用）；
              // 需要严格邮箱成员校验的部署可开 HARNESS_TASK_OWNER_STRICT=1。
              if (ownerStrictMode()) {
                try {
                  resolveRecipient(sessionId, owner)
                } catch (e) {
                  if (e instanceof MailboxRecipientError) {
                    return Response.json(
                      { ok: false, success: false, error: { message: e.message, type: "not_found", code: e.code }, candidates: e.candidates },
                      { status: 404 },
                    )
                  }
                  if (e instanceof MailboxValidationError) {
                    return jsonError(400, e.message, "bad_request", e.code)
                  }
                  throw e
                }
              }
              patch.owner = owner
            }
          }
        }
        if (payload.metadata !== undefined) {
          if (!isPlainRecord(payload.metadata)) return jsonError(400, "metadata must be an object", "bad_request", "bad_request")
          patch.metadata = payload.metadata
        }
        if (payload.addBlocks !== undefined) {
          const ids = positiveIdArray(payload.addBlocks)
          if (!ids) return jsonError(400, "addBlocks must be an array of positive integer task ids", "bad_request", "bad_request")
          patch.addBlocks = ids
        }
        if (payload.addBlockedBy !== undefined) {
          const ids = positiveIdArray(payload.addBlockedBy)
          if (!ids) {
            return jsonError(400, "addBlockedBy must be an array of positive integer task ids", "bad_request", "bad_request")
          }
          patch.addBlockedBy = ids
        }
        if (payload.removeBlocks !== undefined) {
          const ids = positiveIdArray(payload.removeBlocks)
          if (!ids) return jsonError(400, "removeBlocks must be an array of positive integer task ids", "bad_request", "bad_request")
          patch.removeBlocks = ids
        }
        if (payload.removeBlockedBy !== undefined) {
          const ids = positiveIdArray(payload.removeBlockedBy)
          if (!ids) {
            return jsonError(
              400,
              "removeBlockedBy must be an array of positive integer task ids",
              "bad_request",
              "bad_request",
            )
          }
          patch.removeBlockedBy = ids
        }
        const before = getTask(sessionId, taskId)
        // P1 认领冲突：任务已由他人 in_progress 时，改 owner 必须显式 force:true。
        if (
          typeof patch.owner === "string" &&
          payload.force !== true &&
          typeof before?.owner === "string" &&
          before.owner.trim() !== patch.owner &&
          before.status === "in_progress"
        ) {
          return Response.json(
            {
              ok: false,
              success: false,
              error: {
                message: `task #${taskId} is in_progress and owned by "${before.owner}"; pass force:true to reassign`,
                type: "conflict",
                code: "owner_claim_conflict",
              },
              owner: before.owner,
            },
            { status: 409 },
          )
        }
        const result = updateTask(sessionId, taskId, patch)
        // 先应用变更，再按最新 owner/status 淘汰旧帧，避免释放请求反而触发派工。
        if (result.success) flushPendingAssignments()
        // CC 任务板联动：owner 变更（含首次认领）后把 task_assignment 帧投给新 owner。
        // 只读 task-board 的 Task 类型、不改它；投递失败不影响任务更新结果。
        // P1：帧 from 用真实 lead（sendTaskAssignment 默认值）；同一 owner 重复赋值不重复发帧；
        // 失败进补投队列，duplicate（同一帧已在邮箱）按已投递计。
        let delivered = false
        if (result.success && typeof patch.owner === "string" && result.task && result.task.status !== "completed") {
          const previousOwner = typeof before?.owner === "string" ? before.owner.trim() : null
          if (patch.owner !== previousOwner) {
            const pending: PendingAssignment = {
              sessionId,
              to: patch.owner,
              task: {
                id: result.task.id,
                subject: result.task.subject,
                description: result.task.description,
              },
              // 稳定幂等键：补投时必须原样复用，避免重复投递。
              msgId: `task-assignment-${result.task.id}-${patch.owner}-${Date.now()}`,
              timestamp: new Date().toISOString(),
            }
            delivered = deliverAssignment(pending)
          }
        }
        return Response.json({ ...result, delivered })
      }
      case "list":
        return Response.json({ success: true, tasks: listTasks(sessionId) })
      default:
        return jsonError(404, "unknown task route", "not_found", "not_found")
    }
  } catch (e) {
    if (e instanceof TaskValidationError) {
      return jsonError(400, `${e.field}: ${e.message}`, "bad_request", "bad_request")
    }
    return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "internal_error")
  }
}
