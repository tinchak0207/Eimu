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

export async function handleTaskBoard(req: Request, pathname: string): Promise<Response> {
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
          if (typeof payload.owner === "string") {
            // M1：先 trim、再按该会话（已归一化到父会话）团队校验收件人；
            // 未知 owner 返回 404，绝不落库后再假装投递成功。
            const owner = payload.owner.trim()
            if (!owner) return jsonError(400, "owner must not be blank", "bad_request", "bad_request")
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
            patch.owner = owner
          } else {
            patch.owner = null
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
        const result = updateTask(sessionId, taskId, patch)
        // CC 任务板联动：owner 变更（含首次认领）后把 task_assignment 帧投给新 owner。
        // 只读 task-board 的 Task 类型、不改它；投递失败不影响任务更新结果。
        // M1：owner 已在上面校验并 trim；同一 owner 重复赋值不重复发帧；delivered 如实回传。
        let delivered = false
        if (result.success && typeof patch.owner === "string" && result.task) {
          const previousOwner = typeof before?.owner === "string" ? before.owner.trim() : null
          if (patch.owner !== previousOwner) {
            try {
              const frame = sendTaskAssignment(sessionId, patch.owner, {
                id: result.task.id,
                subject: result.task.subject,
                description: result.task.description,
              })
              delivered = frame.delivered === true
            } catch (e) {
              console.error("[gateway] task assignment frame failed:", e)
            }
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
