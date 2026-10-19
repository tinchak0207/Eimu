import { bindGenerationConsumer, generationParent, generationReceipt, generationReceipts, registerGenerationReceipt,
  completeGenerationReceipt, acknowledgeGeneration, notifyGeneration, claimGenerationMessages, renderedGeneration, transferGeneration, generationUserAdmissions, generationMaintenanceEnabled, setGenerationMaintenance, generationProjectAuthorization, knownGenerationOwner } from "./job-store"
import { resolveSession, markDirty } from "./sessions-core"
import { opencodeFetch } from "./opencode-client"
import { beastAgentField } from "./session-lifecycle"
import { armWatchdogTimer } from "./timers-gw"
import { emitImageDone, emitVideoDone } from "./events-translate"
import { emitImageFailed } from "./media-internal-routes"
import { realpath, stat } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { probeMedia } from "./media-quality"
import { PLATFORM_BASE } from "./constants-gateway"
import { resolveCanonicalIdentity } from "./auth-gw"

function parentOf(session: string): any {
  return resolveSession(session) ?? (generationParent(session) ? resolveSession(generationParent(session)!.parent_gw) : undefined)
}
export async function stableGenerationOwnerScope(session: string): Promise<string | undefined> {
  const parent = parentOf(session)
  if (!parent) return undefined
  const identity = await resolveCanonicalIdentity(parent.apiKey)
  const userId = knownGenerationOwner(parent.sessionId, identity.userId || undefined)
  return userId ? `owner:${createHash("sha256").update(`web:${userId}`).digest("hex")}` : undefined
}
export function durableSessionTasks(session: string): any[] {
  const parent = parentOf(session)
  const parentId = parent?.sessionId ?? generationParent(session)?.parent_gw
  return parentId ? generationReceipts(parentId) : []
}
export async function handleGenerationDelivery(req: Request, route: string): Promise<Response> {
  let input: any
  try { input = await req.json() } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }) }
  try {
    if (route === "/internal/project-budget") {
      const parent = parentOf(input.session_id || "")
      if (!parent || typeof input.project !== "string" || !input.project.trim()) return Response.json({ ok: false, error: "known owner and project required" }, { status: 409 })
      const ownerScope = await stableGenerationOwnerScope(input.session_id)
      if (!ownerScope) return Response.json({ ok: false, durable: true, authorized: false, error: "trusted stable owner identity unavailable; no new paid submission" }, { status: 503 })
      const scope = `project:${createHash("sha256").update(ownerScope + "\0" + input.project).digest("hex")}`
      const authorization = generationProjectAuthorization(ownerScope, input.project)
      return Response.json({ ok: true, durable: true, scope, authorized: !!authorization, ...(authorization || {}) })
    }
    if (route === "/internal/job-maintenance") {
      if (typeof input.enabled === "boolean") setGenerationMaintenance(input.enabled)
      return Response.json({ ok: true, durable: true, enabled: generationMaintenanceEnabled() })
    }
    if (route === "/internal/job-bind") {
      const parent = resolveSession(input.parent_gw || "")
      if (!parent || !String(input.child_oc || "").startsWith("ses_")) return Response.json({ ok: false, error: "existing parent and child OC required" }, { status: 400 })
      const child = await opencodeFetch(`/session/${input.child_oc}`, { timeoutMs: 5000 })
      const existing = generationParent(input.child_oc)
      const info: any = child.ok ? await child.json() : null
      if (!existing && info?.parentID !== parent.opencodeSessionId && info?.parent_id !== parent.opencodeSessionId)
        return Response.json({ ok: false, error: "unproven child ownership; import existing jobs via tenant-scoped lookup instead" }, { status: 409 })
      bindGenerationConsumer(input.child_oc, parent.sessionId, parent.opencodeSessionId)
      return Response.json({ ok: true, durable: true, consumer_available: child.ok, collector_transfer_required: !child.ok })
    }
    if (route === "/internal/job-pending") return Response.json({ ok: true, durable: true, tasks: generationReceipts(undefined, true) })
    if (route === "/internal/job-import") {
      const parent = parentOf(input.session_id || "")
      if (!parent || !input.task_id) return Response.json({ ok: false, error: "existing owner and task_id required" }, { status: 400 })
      // Historical orphan producers do not gain a key or child binding. Verify tenant ownership with a free GET.
      const lookup = await fetch(`${PLATFORM_BASE}/v1/images/${encodeURIComponent(input.task_id)}`, {
        headers: { Authorization: `Bearer ${parent.apiKey}` }, signal: AbortSignal.timeout(15000) })
      if (!lookup.ok) return Response.json({ ok: false, error: "tenant-scoped job ownership could not be verified" }, { status: 409 })
      const task: any = await lookup.json()
      const producer = input.producer_oc || parent.opencodeSessionId
      const consumer = input.consumer_session_id || parent.opencodeSessionId
      if (consumer !== parent.opencodeSessionId && generationParent(consumer)?.parent_gw !== parent.sessionId)
        return Response.json({ ok: false, error: "collector ownership mismatch" }, { status: 403 })
      const receipt = registerGenerationReceipt({ task_id: input.task_id, parent_gw: parent.sessionId, producer_oc: producer,
        consumer_oc: consumer, credential_session_id: parent.opencodeSessionId,
        kind: task.kind?.startsWith("video") ? "video" : input.kind || "image", frame: input.frame, project: input.project,
        requested_count: task.request_config?.n || input.requested_count || 1, size: task.request_config?.size, model: task.model || task.request_config?.model })
      return Response.json({ ok: true, durable: true, task_id: receipt.task_id, delivery_id: `generation:${receipt.task_id}` })
    }
    if (route === "/internal/job-register") {
      if (!input.task_id || !input.session_id || !["image", "video"].includes(input.kind)) return Response.json({ ok: false, error: "task_id/session_id/kind required" }, { status: 400 })
      const parent = parentOf(input.session_id)
      if (!parent) return Response.json({ ok: false, error: "owner mapping unavailable; registration must retry" }, { status: 409 })
      const producer = input.session_id.startsWith("ses_") ? input.session_id : parent.opencodeSessionId
      const consumer = input.consumer_session_id || producer
      if (consumer !== producer && consumer !== parent.opencodeSessionId && generationParent(consumer)?.parent_gw !== parent.sessionId)
        return Response.json({ ok: false, error: "consumer owner mismatch" }, { status: 403 })
      const receipt = registerGenerationReceipt({ task_id: input.task_id, parent_gw: parent.sessionId,
        producer_oc: producer, consumer_oc: consumer, kind: input.kind,
        model: input.model, cost_coins: input.cost_coins, frame: input.frame, project: input.project, request_id: input.request_id,
        requested_count: input.requested_count || 1, size: input.size, reference_version: input.reference_version, style_version: input.style_version })
      return Response.json({ ok: true, durable: true, task_id: receipt.task_id, delivery_id: `generation:${receipt.task_id}` })
    }
    const receipt = generationReceipt(input.task_id)
    if (!receipt) return Response.json({ ok: false, error: "job not durably registered" }, { status: 409 })
    if (route === "/internal/job-completion") {
      if (!["succeeded", "failed", "refunded", "cancelled"].includes(input.status)) return Response.json({ ok: false, error: "authoritative terminal status required" }, { status: 400 })
      const artifacts = Array.isArray(input.artifacts) ? input.artifacts : []
      if ((input.status === "succeeded" && !artifacts.length) || artifacts.some((a: any) => typeof a.url !== "string" || !/^https?:\/\//.test(a.url)))
        return Response.json({ ok: false, error: "success requires all public artifact URLs" }, { status: 400 })
      completeGenerationReceipt(input.task_id, input.status, artifacts, { reason: input.reason, cost_coins: input.cost_coins })
      // A durable receipt is not a consumer ACK. Rendering is independently retried by the drain.
      return Response.json({ ok: true, durable: true, task_id: receipt.task_id, acknowledged: !!receipt.observed_at })
    }
    const parent = parentOf(input.session_id || "")
    if (!parent || parent.sessionId !== receipt.parent_gw) return Response.json({ ok: false, error: "job owner mismatch" }, { status: 403 })
    if (route === "/internal/job-ack") {
      if (!["observed", "downloaded"].includes(input.stage)) return Response.json({ ok: false, error: "stage required" }, { status: 400 })
      let verified: any[] | undefined
      if (input.stage === "downloaded") {
        const urls = Array.isArray(input.artifact_urls) ? input.artifact_urls : []
        if (new Set(urls).size !== urls.length || urls.length !== receipt.artifacts.length || !receipt.artifacts.every((a) => urls.includes(a.url)))
          return Response.json({ ok: false, error: "ACK must include every authoritative artifact exactly once" }, { status: 400 })
        const items = Array.isArray(input.artifacts) ? input.artifacts : []
        if (items.length !== urls.length || new Set(items.map((a: any) => a.url)).size !== items.length)
          return Response.json({ ok: false, error: "download ACK requires every URL/path/hash receipt" }, { status: 400 })
        const workspace = await realpath(process.env.WORKSPACE_ROOT || "/opt/agent-harness/workspace")
        verified = []
        for (const artifact of receipt.artifacts) {
          const item = items.find((a: any) => a.url === artifact.url)
          if (!item || typeof item.path !== "string") throw new Error("artifact path missing")
          const local = await realpath(path.isAbsolute(item.path) ? item.path : path.join(workspace, item.path))
          if (!local.startsWith(workspace + path.sep)) throw new Error("artifact outside shared workspace")
          const info = await stat(local)
          if (!info.isFile() || !info.size) throw new Error("artifact has no downloaded bytes")
          const hash = createHash("sha256")
          for await (const bytes of createReadStream(local)) hash.update(bytes)
          const sha256 = hash.digest("hex")
          if (item.sha256 !== sha256 || item.bytes !== info.size) throw new Error("artifact byte/hash receipt mismatch")
          if (typeof artifact.sha256 === "string" && artifact.sha256.toLowerCase().replace(/^sha256:/, "") !== sha256) throw new Error("downloaded bytes differ from authoritative artifact hash")
          const media = await probeMedia(local)
          if (media.status !== "ok" || !media.video?.width || !media.video.height) throw new Error("downloaded artifact is not a decodable image/video")
          const { width, height } = media.video
          const requestedSize = typeof receipt.size === "string" ? /^(\d+)x(\d+)$/i.exec(receipt.size) : null
          if (receipt.kind === "image" && requestedSize && (width !== Number(requestedSize[1]) || height !== Number(requestedSize[2]))) throw new Error("downloaded image does not meet requested dimensions")
          if ((item.width != null && item.width !== width) || (item.height != null && item.height !== height) ||
              (artifact.width != null && artifact.width !== width) || (artifact.height != null && artifact.height !== height))
            throw new Error("artifact dimensions do not match actual bytes")
          verified.push({ ...item, path: local, bytes: info.size, sha256, width, height })
        }
      }
      const actor = input.session_id.startsWith("ses_") ? input.session_id : parent.opencodeSessionId
      if (actor !== receipt.consumer_oc) transferGeneration(receipt.task_id, actor)
      acknowledgeGeneration(receipt.task_id, input.stage, { local_path: input.local_path, artifact_urls: input.artifact_urls, ...(verified ? { downloaded_artifacts: verified } : {}), consumed_by: actor })
      return Response.json({ ok: true, acknowledged: true, stage: input.stage })
    }
    if (route === "/internal/job-transfer") {
      const target = input.consumer_session_id
      if (!target || (target !== parent.opencodeSessionId && generationParent(target)?.parent_gw !== parent.sessionId))
        return Response.json({ ok: false, error: "collector must share job owner" }, { status: 403 })
      transferGeneration(receipt.task_id, target)
      return Response.json({ ok: true, durable: true, task_id: receipt.task_id })
    }
    return Response.json({ ok: false, error: "unknown route" }, { status: 404 })
  } catch (error) {
    // Fail closed for durability, unlike ordinary SSE persistence's fail-open policy.
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "delivery store unavailable" }, { status: 503 })
  }
}

let draining = false
export async function drainGenerationInbox(): Promise<void> {
  if (draining) return
  draining = true
  try {
    const receipts = generationReceipts().filter((r) => !["queued", "running", "unknown"].includes(r.status) && (r.kind === "image" && r.artifacts.length ? !r.downloaded_at : !r.observed_at))
    if (!receipts.length) return
    const statusesResponse = await opencodeFetch("/session/status", { timeoutMs: 5000 })
    if (!statusesResponse.ok) return
    const statuses: any = await statusesResponse.json()
    const groups = new Map<string, typeof receipts>()
    for (const receipt of receipts) {
      // SSE is a display side effect; the durable inbox remains unread until tool ACK.
      const parent = resolveSession(receipt.parent_gw)
      if (parent && !receipt.rendered_at) {
        if (receipt.artifacts.length) {
          for (const [index, artifact] of receipt.artifacts.entries()) {
            const cost = index === 0 ? receipt.cost_coins : 0
            if (receipt.kind === "video") await emitVideoDone(parent, artifact.url, cost, receipt.task_id)
            else await emitImageDone(parent, artifact.url, cost, receipt.task_id)
          }
        } else if (receipt.kind !== "message") {
          emitImageFailed(parent, receipt.task_id, receipt.reason || receipt.status, receipt.status === "refunded")
        }
        renderedGeneration(receipt.task_id)
      }
      if (generationMaintenanceEnabled()) continue
      // 消息通知不是待下载媒体：已提交或结果未知的通知永不定时重投，保留真实 ACK 状态。
      if (receipt.kind === "message" && receipt.notified_at !== null) continue
      // An accepted prompt is not an ACK. Retry unread batches conservatively, never every tick.
      if (receipt.notified_at && Date.now() - receipt.notified_at < 10 * 60_000) continue
      if (statuses[receipt.consumer_oc]?.type && statuses[receipt.consumer_oc].type !== "idle") continue
      if (parent?.opencodeSessionId === receipt.consumer_oc && (parent.lastTurnActiveAt || 0) > 0) continue
      const group = groups.get(receipt.consumer_oc) || []
      group.push(receipt); groups.set(receipt.consumer_oc, group)
    }
    for (const [consumer, group] of groups) {
      // A gone child transfers durably to the same-owner parent collector; transient errors never transfer.
      const exists = await opencodeFetch(`/session/${consumer}`, { timeoutMs: 5000 })
      if (!exists.ok) {
        if (exists.status === 404) for (const receipt of group) {
          const parent = resolveSession(receipt.parent_gw)
          if (parent && parent.opencodeSessionId !== consumer) transferGeneration(receipt.task_id, parent.opencodeSessionId, "original consumer missing; same-owner parent collector")
        }
        continue
      }
      const consumerInfo: any = await exists.json()
      if (consumerInfo.time?.archived || consumerInfo.time_archived) {
        for (const receipt of group) {
          const parent = resolveSession(receipt.parent_gw)
          if (parent && parent.opencodeSessionId !== consumer) transferGeneration(receipt.task_id, parent.opencodeSessionId, "original consumer archived; same-owner parent collector")
        }
        continue
      }
      const parent = resolveSession(group[0].parent_gw)
      // No await between admission, the durable claim and sending: an accepted user turn wins.
      if (generationUserAdmissions.has(consumer) || (parent?.opencodeSessionId === consumer && (parent.lastTurnActiveAt || 0) > 0)) continue
      const claimed = new Set(claimGenerationMessages(group.filter((r) => r.kind === "message").map((r) => r.task_id), consumer))
      const pending = group.filter((r) => r.kind !== "message" || claimed.has(r.task_id))
      if (!pending.length) continue
      const jobs = pending.map((r) => ({ task_id: r.task_id, status: r.status, frame: r.frame, project: r.project,
        kind: r.kind, artifacts: r.artifacts, ...(r.kind === "message" ? { content: r.content } : {}), delivery_id: `generation:${r.task_id}` }))
      const text = `【生成结果耐久收件箱】收到 ${jobs.length} 个终态结果。image 任务用 image_get_result 读取确认，有 artifact 的图（含取消前已有产物）用 image_result_download 下载全部 artifact 后确认 downloaded；video 任务用 video_result_fetch 读取确认，再用 video_fetch {task_id} 下载全部 artifact 后确认 downloaded（直链不需要 yt-dlp；不要用 image_result_download 下载视频）。kind=message 是耐久兼容通知，直接处理 content 并向 /internal/job-ack 提交 observed，wake: ID 不是平台生成任务。按 task_id/delivery_id 幂等处理，已处理结果不重生成、不重复扣费；失败依真实终态处理，不将等待预算当失败。\n${JSON.stringify(jobs)}`
      const agent = generationParent(consumer)?.consumer_agent
      const promptBody = { ...(parent?.opencodeSessionId === consumer ? beastAgentField(parent) : agent ? { agent } : {}), parts: [{ type: "text", text }] }
      let ownTurnGen: number | undefined
      if (parent?.opencodeSessionId === consumer) {
        parent.lastPromptBody = promptBody
        parent.turnGen = (parent.turnGen || 0) + 1
        ownTurnGen = parent.turnGen
        parent.turnTextChars = 0; parent.turnReasoningChars = 0; parent.turnRetries = 0
        parent.turnAborted = false; parent.turnAbortSource = undefined; parent.retryQueued = false
        parent.turnUpstreamError = null; parent.turnToolStarted = false; parent.watchdogRetried = false
        parent.deathDeclared = false; parent.questionAnsweredThisTurn = false
        parent.lastTurnActiveAt = Date.now()
        markDirty(parent)
      }
      let response: Response
      try {
        response = await opencodeFetch(`/session/${consumer}/prompt_async`, { method: "POST", timeoutMs: 10000,
          body: JSON.stringify(promptBody) })
      } catch (error) {
        if (parent && ownTurnGen === parent.turnGen) { parent.lastTurnActiveAt = 0; markDirty(parent) }
        throw error
      }
      if (response.ok) {
        notifyGeneration(pending.map((r) => r.task_id))
        if (parent && ownTurnGen === parent.turnGen) armWatchdogTimer(parent)
      } else if (parent && ownTurnGen === parent.turnGen) {
        parent.lastTurnActiveAt = 0
        markDirty(parent)
      }
    }
  } catch (error) {
    console.error("[gateway] durable generation inbox drain deferred:", error instanceof Error ? error.message : "unavailable")
  } finally { draining = false }
}
setInterval(() => void drainGenerationInbox(), 10000).unref?.()
