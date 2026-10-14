// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave3）：handleRequest 全函数（原 index.ts
// 7497–8058 行，562 行）——B5 混音/G4 成片/TTS 静态服务、health、/internal/* loopback 家族
// （confirm/canvas/subagent/memory-batch/workflow）、ticket SSE/附件直读/影片直传、
// Bearer 闸门＋两步鉴权并行、公开路由（settings/sessions/timeline/director/transcript/
// messages/events/confirm/question/sse-ticket/uploads-ticket/abort/attachments/canvas/
// memory-trace/memory-recall）全部路由分派。逐行机械抽取（python），仅加 export 前缀＋
// 本档头＋单行 import，其余一字未动；handleRequest 内逻辑一行未动。
import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { MemoryDocLite } from "./types-gateway.ts"
import { WORKSPACE_DIR, TTS_AUDIO_DIR, UPLOADS_DIR, VIDEO_UPLOAD_MAX_BYTES, VIDEO_UPLOAD_EXTS } from "./constants-gateway.ts"
import { jsonError, getBearer } from "./gw-lib.ts"
import { isLoopback, validateApiKey, resolveCanonicalKey, resolveCanonicalIdentity, redeemUploadTicket, issueUploadTicket, UPLOAD_TICKET_TTL_MS, SSE_TICKET_TTL_MS, DEVICE_TICKET_PREFIX, redeemDeviceTicket } from "./auth-gw.ts"
import { sessions, markDirty, getOwnedSession, resolveSession, issueSseTicket, redeemSseTicket, handleDeleteSession } from "./sessions-core.ts"
import { normalizeUserSettings, USER_SETTINGS_ENUMS, handleGetSession, handleGetSessionMessages, type UserSettingsShape } from "./sessions-http.ts"
import { loadUserSettings, saveUserSettings, listSessionRows, setRowTitle, persistenceStatus } from "./persistence.ts"
import { fetchOpencodeTitle } from "./opencode-client.ts"
import { openEventStream } from "./sse-core.ts"
import { handleAttachmentUpload, sanitizeUploadName, reserveUniqueUploadName, contentTypeForExt } from "./uploads-media.ts"
import { handleConfirmRequest, handleInternalEmit, handleTts, handleCanvasDispatchOps, handleCanvasOpsResultInternal, handleMediaUpload, handleCanvasStatePublic, handleCanvasStatePublicGet, handleCanvasOpsResultPublic } from "./media-internal-routes.ts"
import { handleCanvasStateWrite, handleCanvasSnapshotRead } from "./canvas-cascade-state.ts"
import { handleSubagentDispatch, handleSubagentStatus, handleSubagentStop, subagentParentState, handleLoopBreaker, handleSubagentMessage, handleSubagentNotify, handleSubagentAskParent, handleSubagentCheckpoint, handleSubagentScratchpad, handleSubagentArtifact, handleSubagentSuspend, handleSubagentResume } from "./subagent.ts"
import { workflowServiceTemplates, handleWorkflowInternal, pushWorkflowCompletion } from "./workflow-gw.ts"
import { handleDirectorRoutes } from "./director.ts"
import { handleCreateSession, handleEventStream, handleConfirm } from "./session-lifecycle.ts"
import { handleSendMessage } from "./messages-gw.ts"
import { turnMetricsSnapshot } from "./metrics-gw.ts"
import { handleQuestion } from "./questions-gw.ts"
// REQ-D2（2026-09-22）：steer 回合中引导受理端点（纯代数在 steer-core.ts）。
import { handleSteer } from "./steer-gw.ts"
import { handleTranscript, handleAbortSession } from "./session-read.ts"
import { handleQuota } from "./quota-ledger.ts"
import { handleCanvasStateRead, handleTimelineRoutes, handleConfirmStatus, handleResumeSession, handleSessionKey, handleSessionTasks, handleOptimizePrompt, handleExtractLessons } from "./internal-http.ts"
import { handleGenerationDelivery } from "./job-delivery"
import { generationMaintenanceEnabled } from "./job-store"
import { handleMemoryBatchRunInternal, handleMemoryTrace, handleMemoryRecallSearch, MEMORY_PRIVATE_DOCS_MAX } from "./memory-wiring.ts"
// W6a（2026-10-04）：装置桥云端侧（本机 daemon 出站注册／取件）。总开关 EIMU_DEVICE_BRIDGE，预设 OFF。
import { deviceBridgeEnabled, handleDeviceBridgeRoutes, handleInternalDeviceAuthorize, handleInternalDeviceInvoke, handleInternalDeviceStatus } from "./device-bridge.ts"
// TODO(整合 Wave3)：以下符号同波在建（questions-gw/session-read/quota-ledger/internal-http/
// memory-wiring.ts），bun build 对 named import 硬查（未 export 即报错），故先 declare 占位
// （第一阶段占位符法，记忆 gateway-index-refactor-stage1-0919）；整合 subagent 统一换真 import。
// TODO(来自 questions-gw.ts；原 index.ts:5339) handleQuestion
// TODO(来自 session-read.ts；原 index.ts:5538) handleTranscript
// TODO(来自 session-read.ts；原 index.ts:5578) handleAbortSession
// TODO(来自 quota-ledger.ts；原 index.ts:5655) handleQuota
// TODO(来自 internal-http.ts；原 index.ts:6417) handleCanvasStateRead
// TODO(来自 internal-http.ts；原 index.ts:6438) handleTimelineRoutes
// TODO(来自 internal-http.ts；原 index.ts:6561) handleConfirmStatus
// TODO(来自 internal-http.ts；原 index.ts:6588) handleResumeSession
// TODO(来自 internal-http.ts；原 index.ts:6636) handleSessionKey
// TODO(来自 internal-http.ts；原 index.ts:6665) handleSessionTasks
// TODO(来自 internal-http.ts；原 index.ts:6735) handleOptimizePrompt
// TODO(来自 internal-http.ts；原 index.ts:6806) handleExtractLessons
// TODO(来自 memory-wiring.ts；原 index.ts:7316) handleMemoryBatchRunInternal
// TODO(来自 memory-wiring.ts；原 index.ts:7338) handleMemoryTrace
// TODO(来自 memory-wiring.ts；原 index.ts:7351) handleMemoryRecallSearch
// TODO(整合)：MEMORY_PRIVATE_DOCS_MAX 仍住 index.ts:6883（const 未 export，补 export 后改真 import，
// session-lifecycle.ts 已用同款占位）。

/**
 * W6a（2026-10-04）：装置桥内部路由的 session → 租户解析。
 * 与 `/internal/media/upload` **同源**的 session 解析（`resolveSession` → `subagentParentState`
 * 兜底子会话），owner 由既有正典化身分路径 `resolveCanonicalIdentity(session.apiKey)` 取得
 * （与装置注册时 `tenant = u:<userId>` 的推导同源，不自造第二套）。解析不到回 `null`。
 */
async function internalDeviceResolveTenant(sessionId: string): Promise<string | null> {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!state) return null
  const key = typeof state.apiKey === "string" ? state.apiKey : ""
  if (!key) return null
  const identity = await resolveCanonicalIdentity(key)
  return identity.userId == null ? null : `u:${identity.userId}`
}

/**
 * G2（2026-10-14 协作总线修复）：`/internal/subagent/*` 端点组的统一错误兜底。
 * 这些 handler 读 body／解析字段，任何未预期抛错此前会冒到 Bun 顶层 → **HTML 500**，
 * 机器调用方（opencode 工具）`res.json()` 直接失败。此处捕获后一律回**同形状 JSON**
 * `{ok:false, code:"internal_error", error}`，500。error 只给一句话原因（不泄漏栈）。
 */
async function guardedSubagentEndpoint(label: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error(`[gateway] subagent endpoint error (${label}):`, e)
    return Response.json({ ok: false, code: "internal_error", error: `子代理端点内部错误（${label}）：${reason}` }, { status: 500 })
  }
}

export async function handleRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> {
  {
    const url = new URL(req.url)
    const pathname = url.pathname
    // B5 混音产物静态服务（无鉴权，镜像 TTS 音频公开 blob 模型；MIX_PUBLIC_BASE=/agent/v1/timeline-mix/<sid>/mix.wav）。放在 Bearer 闸门之前。
    {
      const m = pathname.match(/^\/agent\/v1\/timeline-mix\/([A-Za-z0-9_-]+)\/mix\.wav$/)
      if (req.method === "GET" && m) {
        const mixBase = path.resolve(path.join(WORKSPACE_DIR, "timelines"))
        const mixFile = path.resolve(path.join(mixBase, m[1], "mix.wav"))
        if (!mixFile.startsWith(mixBase + path.sep)) {
          return jsonError(400, "invalid path", "bad_request", "bad_request")
        }
        const file = Bun.file(mixFile)
        if (!(await file.exists())) {
          return jsonError(404, "mix not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "public, max-age=86400",
          },
        })
      }
    }

    // G4 成片静态服务（2026-09-17）：导出档与封面帧公开直链（delivery_url 进成片索引，
    // B 端 /v1/masters 直接下载）。无鉴权镜像 mix.wav／TTS 公开 blob 模型；放 Bearer 闸门之前。
    {
      const m = pathname.match(/^\/agent\/v1\/masters\/([A-Za-z0-9_-]+)\/(master_[a-z0-9_]+\.mp4|master_[a-z0-9_]+_cover\.jpg)$/)
      if (req.method === "GET" && m) {
        const mastersBase = path.resolve(path.join(WORKSPACE_DIR, "timelines"))
        const mastersFile = path.resolve(path.join(mastersBase, m[1], m[2]))
        if (!mastersFile.startsWith(mastersBase + path.sep)) {
          return jsonError(400, "invalid path", "bad_request", "bad_request")
        }
        const file = Bun.file(mastersFile)
        if (!(await file.exists())) {
          return jsonError(404, "master not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: {
            "Content-Type": m[2].endsWith(".mp4") ? "video/mp4" : "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        })
      }
    }
    let clientIp: string | null = null
    try {
      clientIp = srv.requestIP(req)?.address ?? null
    } catch {
      clientIp = null
    }

    // TTS 音频静态服务（无鉴权，同平台公开 blob 模型）。放在 Bearer 闸门之前。
    {
      const m = pathname.match(/^\/agent\/v1\/audio\/([A-Za-z0-9_.-]+)$/)
      if (req.method === "GET" && m) {
        const fileName = m[1]
        const filePath = path.join(TTS_AUDIO_DIR, fileName)
        if (!path.resolve(filePath).startsWith(path.resolve(TTS_AUDIO_DIR))) {
          return jsonError(400, "invalid path", "bad_request", "bad_request")
        }
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          return jsonError(404, "audio not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: {
            "Content-Type": fileName.endsWith(".mp4") ? "video/mp4" : fileName.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
            "Cache-Control": "public, max-age=86400",
          },
        })
      }
    }

    // Health (no auth). Also served under /agent/healthz because nginx proxies
    // /agent/ to this port WITHOUT stripping the prefix, so /healthz alone is
    // not reachable from outside and an external uptime check would get 401.
    if (req.method === "GET" && (pathname === "/healthz" || pathname === "/agent/healthz")) {
      // persistence.ready=false 表示「现在起新建的会话重启会丢」——这是 2026-10-13
      // 事故期间**没人看得见**的信号，现在做成可观测的（只读，无副作用）。
      return Response.json({ ok: true, timestamp: new Date().toISOString(), sessions: sessions.size, persistence: persistenceStatus() })
    }

    // Internal routes: loopback-only, no API key
    if (pathname.startsWith("/internal/")) {
      if (!isLoopback(clientIp)) {
        return jsonError(403, "internal endpoint only reachable from localhost", "forbidden", "forbidden")
      }
      if (req.method === "POST" && ["/internal/job-register", "/internal/job-completion", "/internal/job-ack", "/internal/job-transfer", "/internal/job-pending", "/internal/job-bind", "/internal/job-import", "/internal/job-maintenance", "/internal/project-budget"].includes(pathname)) {
        return handleGenerationDelivery(req, pathname)
      }
      if (req.method === "POST" && pathname === "/internal/confirm-request") {
        return handleConfirmRequest(req)
      }
      if (req.method === "POST" && pathname === "/internal/confirm-status") {
        return handleConfirmStatus(req)
      }
      if (req.method === "POST" && pathname === "/internal/resume-session") {
        return handleResumeSession(req)
      }
      if (req.method === "POST" && pathname === "/internal/session-key") {
        return handleSessionKey(req)
      }
      if (req.method === "POST" && pathname === "/internal/session-tasks") {
        return handleSessionTasks(req)
      }
      if (req.method === "POST" && pathname === "/internal/emit") {
        return handleInternalEmit(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/state") {
        return handleCanvasStateRead(req)
      }
      // Wave C：画布快照写入 / 工具快照读取 / ops 下发 / 回执（皆 loopback）。
      if (req.method === "POST" && pathname === "/internal/canvas/state") {
        return handleCanvasStateWrite(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/snapshot") {
        return handleCanvasSnapshotRead(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/dispatch-ops") {
        return handleCanvasDispatchOps(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/ops-result") {
        return handleCanvasOpsResultInternal(req)
      }
      // 素材入库：opencode video_upload 工具经此把外部影片/音频下载进平台存储。
      if (req.method === "POST" && pathname === "/internal/media/upload") {
        return handleMediaUpload(req)
      }
      // W6a（2026-10-04）：装置桥**内部**入口。agent 工具跑在 opencode-server（同机
      // loopback），只知道 session_id、不持有装置凭证；由 session 解析租户 → 挑该租户
      // 唯一在线装置 → 转发既有 invoke。本路由只**寻址与转发**，denylist／授权根／
      // 工具白名单三道防线全在既有 invoke/sanitizeToolArgs 内，不放宽任何检查。
      if (req.method === "POST" && pathname === "/internal/device/invoke") {
        return handleInternalDeviceInvoke(req, { resolveTenant: internalDeviceResolveTenant })
      }
      if (req.method === "GET" && pathname === "/internal/device/status") {
        return handleInternalDeviceStatus(req, { resolveTenant: internalDeviceResolveTenant })
      }
      // W6b（2026-10-04）：对话中授权本机路径（once／session／permanent）。loopback-only。
      if (req.method === "POST" && pathname === "/internal/device/authorize") {
        return handleInternalDeviceAuthorize(req, { resolveTenant: internalDeviceResolveTenant })
      }
      // 子代理运行时：派发 + 工具轮询取件（loopback，鉴权同其他 internal 端点）。
      // G2（2026-10-14 协作总线修复）：这一组 handler 加统一 try/catch——它们内部读 body／
      // 解析字段，任何未预期抛错都必须回 **JSON** 而非 Bun 默认的 HTML 500（机器调用方
      // 收 HTML 会直接解析失败）。code=internal_error，语义＝网关内部错误，非呼叫方输入错。
      if (req.method === "POST" && pathname === "/internal/subagent/dispatch") {
        return await guardedSubagentEndpoint("dispatch", () => handleSubagentDispatch(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/status") {
        return await guardedSubagentEndpoint("status", () => handleSubagentStatus(req))
      }
      // 0920 停止闸：orchestrator 的主动停止入口（此前只有 dispatch/status，
      // orchestrator 眼睁睁看著子代理跑飞却无权刹车）。body: { session_id, subagent_id?, all? }
      //   - 带 subagent_id：停那一个（id 或 label 前缀）
      //   - all:true 或缺 subagent_id：停该会话名下全部在跑子代理
      if (req.method === "POST" && pathname === "/internal/subagent/stop") {
        return await guardedSubagentEndpoint("stop", () => handleSubagentStop(req))
      }
      // 2026-10-14 子代理协作总线（spec §3.1）：父→子消息（mode 三态＋expected_turn_id
      // 精确 steer，回应带 submission_id 与「接受≠已处理」）与子→父回报（notify_orchestrator：
      // 父忙只入队不打断、父闲唤醒一次）。与上面三端点同风格：同一 loopback 门内，不加二次鉴权。
      if (req.method === "POST" && pathname === "/internal/subagent/message") {
        return await guardedSubagentEndpoint("message", () => handleSubagentMessage(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/notify") {
        return await guardedSubagentEndpoint("notify", () => handleSubagentNotify(req))
      }
      // 2026-10-14 协作总线四大支柱：RPC(ask-parent)、检查点(checkpoint)、白板(scratchpad)、具型产物(artifact)、挂起(suspend)、恢复(resume)
      if (req.method === "POST" && pathname === "/internal/subagent/ask-parent") {
        return await guardedSubagentEndpoint("ask-parent", () => handleSubagentAskParent(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/checkpoint") {
        return await guardedSubagentEndpoint("checkpoint", () => handleSubagentCheckpoint(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/scratchpad") {
        return await guardedSubagentEndpoint("scratchpad", () => handleSubagentScratchpad(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/artifact") {
        return await guardedSubagentEndpoint("artifact", () => handleSubagentArtifact(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/suspend") {
        return await guardedSubagentEndpoint("suspend", () => handleSubagentSuspend(req))
      }
      if (req.method === "POST" && pathname === "/internal/subagent/resume") {
        return await guardedSubagentEndpoint("resume", () => handleSubagentResume(req))
      }
      // D1（2026-10-02）：工具层重复呼叫断路器的强制收尾（plugin eimu-guard 在 N+5 次时呼叫）。
      if (req.method === "POST" && pathname === "/internal/session/loop-breaker") {
        return handleLoopBreaker(req)
      }
      // ── 契约 §3.5：记忆批次手动触发（每日 ticker 之外的运维入口）。──
      // 鉴权＝与现状同构的 loopback-only 门（本 /internal/ 区块上层已裁定：既有
      // /internal/* 全部只验 isLoopback、无 HARNESS key；契约 §3.5 写的
      // HARNESS_API_KEY 与现场冲突，上层裁决照现场、不加 key——偏离契约处已回报）。
      if (req.method === "POST" && pathname === "/internal/memory/batch-run") {
        return handleMemoryBatchRunInternal(req)
      }
      // 工作流引擎端点：接受 session_id（opencode 或 gateway id）解析 session。
      if (pathname === "/internal/workflow/templates" && req.method === "GET") {
        return workflowServiceTemplates()
      }
      if (pathname.startsWith("/internal/workflow/")) {
        const m = new URL(req.url)
        // 0920 回归修复（重构引入）：原版是 `searchParams.get(...) || (await req.json())`
        // ——短路，query 带 session_id（工具一律带）时 body 不被读。重构拆档时改成
        // 无条件先读 body，下游 handleWorkflowInternal 再读同一条已消费的 body →
        // 一律 400「invalid json body」。实锤：任何 template/workflow_start POST
        // 都建不起骨架（野兽模式因此只能裸跑）。还原短路＝body 只在必要时才读。
        const qsid = m.searchParams.get("session_id")
        const sessionId = qsid || ((await req.json().catch(() => ({}))) as { session_id?: string }).session_id || ""
        // 0920：Expert（子代理）的工具呼叫带自己的 opencode session id——三段解析
        // 全 miss（子会话不进 sessions map）→ 此前一律 404，模板骨架永远建不起来
        // （事故：野兽模式裸跑无角色卡）。兜底回父会话＝工作流落在用户看得见的画布。
        const session = sessionId ? resolveSession(sessionId) ?? subagentParentState(sessionId) : undefined
        if (!session) return jsonError(404, "session not found", "not_found", "not_found")
        // 2026-09-20 Phase 1：跑批完成推送的手动触发入口（自动触发在
        // runWfGenerate 的 generate .then）。语义＝「现在就把本会话当前
        // 工作流的完成态推给站点」，幂等（pushWorkflowCompletion 内
        // workflowCompletionPushed 去重）。放此处而非 handleWorkflowInternal：
        // 不需 body，且避免动到 /workflow/* 的 body 读取契约（0920 血泪短路）。
        if (pathname === "/internal/workflow/complete" && req.method === "POST") {
          await pushWorkflowCompletion(session)
          return Response.json({ ok: true })
        }
        return handleWorkflowInternal(req, session)
      }
      return jsonError(404, "not found", "not_found", "not_found")
    }

    // Ticket-authenticated SSE. Checked before the Bearer gate because the
    // browser EventSource cannot send a header at all; the ticket IS the
    // credential here. Read-only and single-session — see issueSseTicket.
    {
      const m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("ticket")
        if (ticket) {
          const state = redeemSseTicket(ticket, m[1])
          if (!state) return jsonError(401, "invalid or expired SSE ticket", "unauthorized", "unauthorized")
          let lastEventId: number | undefined
          const raw = req.headers.get("last-event-id") || url.searchParams.get("last_event_id")
          if (raw) {
            const n = Number.parseInt(raw, 10)
            if (!Number.isNaN(n)) lastEventId = n
          }
          return openEventStream(state, lastEventId, req)
        }
      }
    }

    // 附件静态直读（票据鉴权，与上方 ticket SSE 同理：浏览器 <img> 带不了
    // Authorization 头）。路径约束在 UPLOADS_DIR 内防目录穿越；无效/过期票据
    // 与不存在的文件一律 404，不泄露存在性。
    {
      const m = pathname.match(/^\/agent\/v1\/uploads\/([^/]+)\/([^/]+)$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("t") ?? ""
        // decodeURIComponent 可能因畸形 % 序列抛 URIError：整段包裹，异常即 404。
        let sessionId = ""
        let fileName = ""
        try {
          sessionId = decodeURIComponent(m[1])
          fileName = decodeURIComponent(m[2])
        } catch {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        // 穿越防御：白名单字符集（与 sanitizeUploadName 产物同款 \w.\- 空格，
        // 天然排除 / 与 \）+ 显式拒 ".." + resolve 前缀兜底（同上传写入 L485 写法）。
        const segSafe = /^[\w.\- ]+$/
        if (!ticket || !redeemUploadTicket(ticket, sessionId) || !segSafe.test(sessionId) || !segSafe.test(fileName) || fileName.includes("..") || sessionId.includes("..")) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const filePath = path.join(UPLOADS_DIR, sessionId, fileName)
        if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        return new Response(file, {
          headers: { "Content-Type": contentTypeForExt(path.extname(fileName).toLowerCase()) },
        })
      }
    }

    // 浏览器原片直传影片／音频（票据鉴权，与上方附件静态直读同理：浏览器带不了
    // Authorization 头，且原片超过站内代理 body 上限，前端绕开 Vercel 直连网关
    // origin）。读票复用（redeemUploadTicket 非一次性）；落盘进同一 UPLOADS_DIR
    // 会话目录，上传后读票路由即可直接读回。不动 4MB attachments 端点。
    {
      const m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/video-upload$/)
      if (req.method === "POST" && m) {
        let sessionId = ""
        try {
          sessionId = decodeURIComponent(m[1])
        } catch {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        const segSafe = /^[\w.\- ]+$/
        const ticket = url.searchParams.get("t") ?? ""
        if (!ticket || !redeemUploadTicket(ticket, sessionId) || !segSafe.test(sessionId) || sessionId.includes("..")) {
          return jsonError(401, "invalid or expired upload ticket", "unauthorized", "unauthorized")
        }
        const ct = req.headers.get("content-type") || ""
        if (!ct.includes("multipart/form-data")) {
          return jsonError(400, "multipart/form-data required", "bad_request", "bad_request")
        }
        try {
          const form = await req.formData()
          const files = form.getAll("file") as File[]
          if (files.length === 0) return jsonError(400, "no file field", "bad_request", "bad_request")
          const file = files[0]
          if (file.size > VIDEO_UPLOAD_MAX_BYTES) {
            return jsonError(413, "media exceeds 100MB limit", "payload_too_large", "payload_too_large")
          }
          const ext = path.extname(file.name).toLowerCase()
          // 大档直传接受**影片或音频**（音频＝本地参考素材，如翻唱 source_audio）。
          // 扩展名语义不另立白名单：音频一律经 contentTypeForExt 推导，最终落盘仍由
          // 下方 sanitizeUploadName 依 ALLOWED_UPLOAD_EXTS 把关；非媒体（.pdf/.zip…）
          // 在此即 415，不因大档路由放宽型别。
          const extMime = contentTypeForExt(ext)
          const isMediaUpload =
            file.type.startsWith("video/") ||
            file.type.startsWith("audio/") ||
            VIDEO_UPLOAD_EXTS.has(ext) ||
            extMime.startsWith("audio/")
          if (!isMediaUpload) {
            return jsonError(415, "only video or audio files accepted", "unsupported_media_type", "unsupported_media_type")
          }
          const safeName = sanitizeUploadName(file.name)
          if (!safeName) {
            return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
          }
          const uploadDir = path.join(UPLOADS_DIR, sessionId)
          await mkdir(uploadDir, { recursive: true })
          // 同名不覆盖：与 attachments 端点同款原子改名，清单回传实际落盘名。
          const finalName = await reserveUniqueUploadName(uploadDir, safeName)
          const dest = path.join(uploadDir, finalName)
          if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
            return jsonError(400, "invalid path", "bad_request", "bad_request")
          }
          await Bun.write(dest, await file.arrayBuffer())
          // 回传 mime 优先信浏览器；空 MIME 时用副档名推导（音频 .flac/.ogg 等），
          // 推不出媒体型别才落回 video/mp4（维持既有契约）。
          const fallbackMime = extMime.startsWith("video/") || extMime.startsWith("audio/") ? extMime : "video/mp4"
          return Response.json({ ok: true, path: `uploads/${sessionId}/${finalName}`, name: finalName, size: file.size, mime: file.type || fallbackMime })
        } catch (e) {
          console.error("[gateway] media-upload error:", e)
          return jsonError(500, "media upload failed", "server_error", "server_error")
        }
      }
    }

    // Public routes: require a valid Bearer sk-biz-* key
    const rawKey = getBearer(req)
    // W7a（2026-10-05）：装置桥的**短效票**路径。桌面壳拿不到 sk-biz-*（页面是远端内容），
    // 旧设计只剩「使用者手放 0600 key 档」⇒ 对真实使用者等于功能不存在。票由
    // `POST /agent/v1/device-bridge/token`（下面 sk-biz 闸门之后）铸造，此处只核销。
    // 三条硬纪律：① 只放行 device-bridge 四个端点，**`/token` 本身不得以票铸票**；
    // ② 票无效/过期一律 401（不泄露存在性）；③ 完全不动下方 sk-biz-* 路径的行为与顺序。
    if (
      rawKey &&
      rawKey.startsWith(DEVICE_TICKET_PREFIX) &&
      pathname !== "/agent/v1/device-bridge/token" &&
      pathname.startsWith("/agent/v1/device-bridge/") &&
      deviceBridgeEnabled()
    ) {
      const deviceIdentity = redeemDeviceTicket(rawKey)
      if (!deviceIdentity) return jsonError(401, "invalid device ticket", "unauthorized", "unauthorized")
      return handleDeviceBridgeRoutes(req, { rawKey, pathname, deviceIdentity })
    }
    if (!rawKey || !rawKey.startsWith("sk-biz-")) {
      return jsonError(401, "missing or invalid API key", "unauthorized", "unauthorized")
    }
    // 2026-09-13 刀3：两步鉴权改并行。读码判定无真依赖——两者都只吃 rawKey、各打
    // 独立 PLATFORM_BASE 端点（validate→/v1/models；resolve→/biz/resolve-owner，
    // 后者本身以 Bearer rawKey 自证归属），串行只是「先验权后正典」的顺序惯例。
    // 语义恒等：ok=false 仍 401（此时 canonicalKey 弃用）；resolve 对无效 key 只是
    // 拿 non-200 → 负缓存 60s＋fallback rawKey，无副作用。串行 miss 24–533ms×2 →
    // 并行取 max。
    const [keyOk, canonicalKey] = await Promise.all([validateApiKey(rawKey), resolveCanonicalKey(rawKey)])
    if (!keyOk) {
      return jsonError(401, "invalid API key", "unauthorized", "unauthorized")
    }
    // R6 身份正典化：raw B key → 属主派生 key——直连与 /api/agent/biz 代理从此同一
    // 身份空间（settings/sessions/野兽开关一致）。解析失败一律 fallback rawKey：
    // 站点抖动不能变成网关故障（负缓存防风暴）。
    const key = canonicalKey

    // W6a：装置桥（云端侧闸道，挂在既有 Bearer sk-biz-* 闸门之后）。
    // 硬性约束：预设 OFF——EIMU_DEVICE_BRIDGE 未开时，这行只是一次前缀判定，
    // 路由照旧落到既有 404，对既有生产行为零影响。开启：EIMU_DEVICE_BRIDGE=1。
    if (pathname.startsWith("/agent/v1/device-bridge/") && deviceBridgeEnabled()) {
      return handleDeviceBridgeRoutes(req, { rawKey, pathname })
    }

    if (req.method === "GET" && pathname === "/agent/v1/quota") {
      return handleQuota(key)
    }

    // Phase 0 观测（2026-09-18）：per-turn 分段延迟与 event-loop lag 的记忆体
    // 聚合视图（p50/p95/p99 + 样本数）。鉴权沿用本区块既有惯例（Bearer
    // sk-biz-* 闸门 + 上游验证），纯读记忆体、无状态、无副作用。
    if (req.method === "GET" && pathname === "/agent/v1/metrics") {
      return Response.json(turnMetricsSnapshot())
    }

    // 画布 workflow 节点操作（rerun/update）：站点 /api/agent/sessions/:id/workflow-node-*
    // 代理进来。/internal/workflow/* 是 loopback-only，Vercel 站点打不进——这里挂
    // Bearer 家族等价入口（同一 handleWorkflowInternal，endsWith 匹配前缀无关）。
    // 会话归属 getOwnedSession 防跨 key 越权；Bun Request.json() 重复读取有缓存，
    // 与 /internal 家族「先读 session_id 再交 handler」同款模式。
    if (req.method === "POST" && (pathname.endsWith("/workflow/node/rerun") || pathname.endsWith("/workflow/node/update"))) {
      // Bun Request body 只能读一次：这里只准用 query 拿 session_id，body 原样留给
      // handleWorkflowInternal 再读（与 /internal 家族 query 优先同款）。
      const wfSid = new URL(req.url).searchParams.get("session_id") || ""
      if (!wfSid) return jsonError(400, "session_id (query) is required", "bad_request", "bad_request")
      const wfState = getOwnedSession(key, wfSid)
      if (!wfState) return jsonError(404, "session not found", "not_found", "not_found")
      return handleWorkflowInternal(req, wfState)
    }

    

// 会话记忆补注（契约 §4）：resume/switch 的老会话事后补上帐户画像/教训与
// memory_docs/memory_index_md。
// D1 修复（2026-09-15 PRD P0-4）：原实作只翻 memoryInjected 这面无人读的死旗标
// → 对已注入 system 的会话完全无效（与原注释宣称相反）。真闸是 vettingInjected：
// 到达时重置为 false，并卸除 onboarding 指引（画像非空，重建时不该再重复注入）；
// 下一回合按最新记忆重建 system。directiveInjected 刻意不重置——模板指引一次性，
// 重建时不会重复注入。
if (req.method === "POST" && pathname === "/agent/v1/sessions/memory-patch") {
  const body = (await req.json().catch(() => null)) as {
    session_id?: string
    user_profile?: Record<string, unknown>
    lessons?: string[]
    memory_docs?: MemoryDocLite[]
    memory_index_md?: string
  } | null
  const sid = body?.session_id ?? ""
  if (!sid) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const state = getOwnedSession(key, sid)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const up = body.user_profile ?? {}
  const docs = Array.isArray(body.memory_docs) ? body.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
  const indexMd = typeof body.memory_index_md === "string" ? body.memory_index_md : ""
  if (Object.keys(up).length > 0 || docs.length > 0 || indexMd.trim().length > 0) {
    state.userMemory = { user_profile: up, lessons: body.lessons ?? [], memory_docs: docs, memory_index_md: indexMd }
    state.vettingInjected = false
    state.profileOnboardingPending = false
    markDirty(state)
    return Response.json({ patched: true, has_profile: true })
  }
  return Response.json({ patched: false, has_profile: false })
}
// 会话目录：当前 key 的历史会话列表（对话历史 dropdown 的数据源）。
if (req.method === "GET" && pathname === "/agent/v1/sessions") {
  // 09-12：零回合会话（预建未用）不出现在目录；数据保留，按 id 直连仍可达
  // （GET :id / :id/messages / SSE 回放 / DELETE 均不经此过滤，深链 switchSession 可用）。
  // 判据=持久化 eventCounter：只有 emit 任何 SSE 帧才会涨，而建号不 emit——
  // 「曾开始过回合」的结构性讯号。刻意不用 lastTurnActiveAt：它是 in-flight 打点、
  // turn 正常结束即清零（L4624 打点/L3975 清零），按它过滤会误杀全部已完成会话
  // （实测 104 行真会话里 102 行清零残留）。过滤放在标题回填之前＝僵尸行不占回填配额。
  const rows = listSessionRows(key).filter((r) => {
    const live = sessions.get(r.sessionId)
    return (live?.eventCounter ?? r.data.eventCounter ?? 0) > 0
  })
  // 会话摘要标题有界回填（2026-09-12）：idle 挂钩上线前的存量会话 data 无
  // title；每次调用最多取 10 个缺栏行并发向 opencode 抓（3s 超时），拿到即
  // setRowTitle 落盘＋同步内存态（防在飞的 saveSession 把旧无标题镜像盖回去）。
  // 缺 opencode_session_id 的理论上不该存在，一并跳过；失败静默 null 不挡目录。
  const titleMissing = rows.filter((r) => !r.data.title && r.opencodeSessionId).slice(0, 10)
  if (titleMissing.length > 0) {
    await Promise.all(
      titleMissing.map(async (r) => {
        try {
          const title = await fetchOpencodeTitle(r.opencodeSessionId)
          if (!title) return
          r.data.title = title
          const live = sessions.get(r.sessionId)
          if (live) live.sessionTitle = title
          setRowTitle(r.sessionId, title)
        } catch {
          // 静默降级：目录返回不受单行回填影响
        }
      }),
    )
  }
  // 0831 历史会话状态标识（前端 dropdown 的圆点）：三态优先级
  // waiting（有未答的 question/confirm）> running（turn 在飞 或 有在途生成任务）> idle。
  // pendingQuestions/pendingConfirms 只在记忆体（重启即清）；lastTurnActiveAt 是持久化
  // 栏位、turn 正常结束清零，但异常死亡的 turn 会留残值 → 加 15 分钟窗口，
  // 否则僵尸会话永远挂著「运转中」骗用户。
  const TURN_RUNNING_WINDOW_MS = 15 * 60 * 1000
  return Response.json({
    object: "agent.session.list",
    sessions: rows.map((r) => {
      const live = sessions.get(r.sessionId)
      const waiting = (live?.pendingQuestions?.size ?? 0) + (live?.pendingConfirms?.size ?? 0) > 0
      const startedAt = live?.lastTurnActiveAt ?? r.data.lastTurnActiveAt ?? 0
      const turnInFlight = startedAt > 0 && Date.now() - startedAt < TURN_RUNNING_WINDOW_MS
      const genInFlight = live && live.sessionTasks
        ? [...live.sessionTasks.values()].some((t) => t.status === "queued" || t.status === "running")
        : false
      const status = waiting ? "waiting" : turnInFlight || genInFlight ? "running" : "idle"
      return {
        session_id: r.sessionId,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        last_activity_at: r.data.lastActivityAt ?? r.updatedAt,
        status,
        // 选填栏位契约：旧前端不读不崩；null=尚未生成（降级时间标签）。
        title: r.data.title ?? null,
      }
    }),
  })
}

// S7（2026-08-29）：用户级 settings（key 维度，持久化 sessions.db，重启不丢）。
// GET 无记录回默认值 steer/efficient/balanced；POST 同 shape 部分更新，
// 未知栏位/非法值一律 400，不静默吞。
if (req.method === "GET" && pathname === "/agent/v1/settings") {
  return Response.json({ ...normalizeUserSettings(loadUserSettings(key)), beast_mode: loadUserSettings(key)?.beast_mode === true })
}
if (req.method === "POST" && pathname === "/agent/v1/settings") {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  for (const k of Object.keys(body)) {
    if (k === "beast_mode") {
      if (typeof body[k] !== "boolean") {
        return jsonError(400, `invalid settings field: ${k}`, "bad_request", "bad_request")
      }
      continue
    }
    const allowed = USER_SETTINGS_ENUMS[k as keyof typeof USER_SETTINGS_ENUMS]
    const v = body[k]
    if (!allowed || typeof v !== "string" || !allowed.includes(v)) {
      return jsonError(400, `invalid settings field: ${k}`, "bad_request", "bad_request")
    }
  }
  const next: UserSettingsShape = { ...normalizeUserSettings(loadUserSettings(key)), ...(body as Partial<UserSettingsShape>) }
  // beast_mode sanitize：显式栏位放行（显式列出、缺栏=保持现值；枚举白名单会剥布林栏）。
  if (typeof body.beast_mode === "boolean") next.beast_mode = body.beast_mode
  else delete next.beast_mode
  saveUserSettings(key, next)
  return Response.json(next)
}


    if (req.method === "POST" && /^\/agent\/v1\/sessions(?:\/[^/]+\/messages)?$/.test(pathname) && generationMaintenanceEnabled()) {
      return Response.json({ ok: false, code: "maintenance", error: "服务更新中，已受理任务继续处理，请稍后重试。" }, { status: 503, headers: { "Retry-After": "60" } })
    }
    if (req.method === "POST" && pathname === "/agent/v1/sessions") {
      return handleCreateSession(key, req)
    }

    if (req.method === "POST" && pathname === "/agent/v1/optimize-prompt") {
      return handleOptimizePrompt(key, req)
    }

    // TTS（配音）：同步快速调用，不走 poller。上游可用时直接回音频 URL；
    // 上游不可用时诚实报错（tts_unavailable），不造假成功。
    if (req.method === "POST" && pathname === "/agent/v1/tts") {
      return handleTts(key, req)
    }

    // 时间线（B1，2026-08-31）：/agent/v1/timeline 家族——session_id 一律走 query
    // （Bun Request body 只能读一次，workflow 家族同款坑）；鉴权=上游 Bearer 闸门
    // + getOwnedSession 防跨 key 越权，不发明新机制。
    if (pathname === "/agent/v1/timeline" || pathname.startsWith("/agent/v1/timeline/")) {
      return handleTimelineRoutes(key, req, pathname)
    }

    // Director（片3，2026-09-02）：/agent/v1/director 家族——session_id 走 query 或 path，
    // 鉴权同款（Bearer 闸门 + resolveSession + apiKey 比对防跨 key 越权）。
    if (pathname === "/agent/v1/director" || pathname.startsWith("/agent/v1/director/")) {
      return handleDirectorRoutes(key, req, pathname)
    }

    if (req.method === "POST" && pathname === "/agent/v1/extract-lessons") {
      return handleExtractLessons(key, req)
    }

    const tm = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/transcript$/)
    if (req.method === "GET" && tm) {
      return handleTranscript(key, tm[1], req)
    }

    let m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/messages$/)
    if (req.method === "POST" && m) {
      return handleSendMessage(key, m[1], req)
    }
    if (req.method === "GET" && m) {
      return handleGetSessionMessages(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
    if (req.method === "GET" && m) {
      return handleEventStream(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/confirm$/)
    if (req.method === "POST" && m) {
      return handleConfirm(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/question$/)
    if (req.method === "POST" && m) {
      return handleQuestion(key, m[1], req)
    }

    // Mint a query-string credential for EventSource. Authenticated with the
    // Bearer key, so only the session owner can obtain one.
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/sse-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueSseTicket(key, m[1]), expires_in_ms: SSE_TICKET_TTL_MS })
    }

    // 附件直读票据（2026-08-29）：前端 <img> GET 带不了 Authorization 头，
    // 用认证 POST 换一张只读票据（TTL 1 小时，与 sse-ticket 同构，key 校验同款）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/uploads-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueUploadTicket(m[1]), expires_in_ms: UPLOAD_TICKET_TTL_MS })
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/abort$/)
    if (req.method === "POST" && m) {
      return handleAbortSession(key, m[1])
    }

    // REQ-D2：回合中追加指引（steer）。与 /messages 分开是刻意的——语义不同
    //（不终止当前回合、不另起用户讯息），前端据回应的 status 显示
    // 「已注入本回合」或「已排队，下一回合生效」。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/steer$/)
    if (req.method === "POST" && m) {
      return handleSteer(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      return handleGetSession(key, m[1])
    }
    if (req.method === "DELETE" && m) {
      return handleDeleteSession(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/attachments$/)
    if (req.method === "POST" && m) {
      return handleAttachmentUpload(key, m[1], req)
    }

    // Wave C：画布快照上行与 canvas.ops 回执（前端经站点代理呼叫）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/state$/)
    if (req.method === "POST" && m) {
      return handleCanvasStatePublic(key, m[1], req)
    }
    if (req.method === "GET" && m) {
      return handleCanvasStatePublicGet(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/ops-result$/)
    if (req.method === "POST" && m) {
      return handleCanvasOpsResultPublic(key, m[1], req)
    }

    // ── PRD P0-4（2026-09-15）记忆 trace 与召回路由（认证＝同族 Bearer 闸门）──
    // 契约 §3.6：注入 trace（R2 尺观测点）；站点 /api/agent/sessions/[id]/memory-trace 只做代理。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/memory-trace$/)
    if (req.method === "GET" && m) {
      return handleMemoryTrace(key, m[1])
    }
    // 【契约外新增】memory_recall 工具（.opencode/tools 薄入口，PRD §6.2）的取数后端：
    // 从共享语料跑 §7 召回。契约 §3 未列此路由，属本片新增（已在回报中标明）。
    if (req.method === "POST" && pathname === "/agent/v1/memory/recall") {
      return handleMemoryRecallSearch(key, req)
    }

    return jsonError(404, "not found", "not_found", "not_found")
  }
}
