// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave3）：handleRequest 全函數（原 index.ts
// 7497–8058 行，562 行）——B5 混音/G4 成片/TTS 靜態服務、health、/internal/* loopback 家族
// （confirm/canvas/subagent/memory-batch/workflow）、ticket SSE/附件直讀/影片直傳、
// Bearer 閘門＋兩步鑑權並行、公開路由（settings/sessions/timeline/director/transcript/
// messages/events/confirm/question/sse-ticket/uploads-ticket/abort/attachments/canvas/
// memory-trace/memory-recall）全部路由分派。逐行機械抽取（python），僅加 export 前綴＋
// 本檔頭＋單行 import，其餘一字未動；handleRequest 內邏輯一行未動。
import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { MemoryDocLite } from "./types-gateway.ts"
import { WORKSPACE_DIR, TTS_AUDIO_DIR, UPLOADS_DIR, VIDEO_UPLOAD_MAX_BYTES, VIDEO_UPLOAD_EXTS } from "./constants-gateway.ts"
import { jsonError, getBearer } from "./gw-lib.ts"
import { isLoopback, validateApiKey, resolveCanonicalKey, redeemUploadTicket, issueUploadTicket, UPLOAD_TICKET_TTL_MS, SSE_TICKET_TTL_MS } from "./auth-gw.ts"
import { sessions, markDirty, getOwnedSession, resolveSession, issueSseTicket, redeemSseTicket, handleDeleteSession } from "./sessions-core.ts"
import { normalizeUserSettings, USER_SETTINGS_ENUMS, handleGetSession, handleGetSessionMessages, type UserSettingsShape } from "./sessions-http.ts"
import { loadUserSettings, saveUserSettings, listSessionRows, setRowTitle } from "./persistence.ts"
import { fetchOpencodeTitle } from "./opencode-client.ts"
import { openEventStream } from "./sse-core.ts"
import { handleAttachmentUpload, sanitizeUploadName, contentTypeForExt } from "./uploads-media.ts"
import { handleConfirmRequest, handleInternalEmit, handleTts, handleCanvasDispatchOps, handleCanvasOpsResultInternal, handleMediaUpload, handleCanvasStatePublic, handleCanvasStatePublicGet, handleCanvasOpsResultPublic } from "./media-internal-routes.ts"
import { handleCanvasStateWrite, handleCanvasSnapshotRead } from "./canvas-cascade-state.ts"
import { handleSubagentDispatch, handleSubagentStatus, handleSubagentStop, subagentParentState, handleLoopBreaker } from "./subagent.ts"
import { workflowServiceTemplates, handleWorkflowInternal, pushWorkflowCompletion } from "./workflow-gw.ts"
import { handleDirectorRoutes } from "./director.ts"
import { handleCreateSession, handleEventStream, handleConfirm } from "./session-lifecycle.ts"
import { handleSendMessage } from "./messages-gw.ts"
import { turnMetricsSnapshot } from "./metrics-gw.ts"
import { handleQuestion } from "./questions-gw.ts"
// REQ-D2（2026-09-22）：steer 回合中引導受理端點（純代數在 steer-core.ts）。
import { handleSteer } from "./steer-gw.ts"
import { handleTranscript, handleAbortSession } from "./session-read.ts"
import { handleQuota } from "./quota-ledger.ts"
import { handleCanvasStateRead, handleTimelineRoutes, handleConfirmStatus, handleResumeSession, handleSessionKey, handleSessionTasks, handleOptimizePrompt, handleExtractLessons } from "./internal-http.ts"
import { handleMemoryBatchRunInternal, handleMemoryTrace, handleMemoryRecallSearch, MEMORY_PRIVATE_DOCS_MAX } from "./memory-wiring.ts"
// TODO(整合 Wave3)：以下符號同波在建（questions-gw/session-read/quota-ledger/internal-http/
// memory-wiring.ts），bun build 對 named import 硬查（未 export 即報錯），故先 declare 佔位
// （第一階段佔位符法，記憶 gateway-index-refactor-stage1-0919）；整合 subagent 統一換真 import。
// TODO(來自 questions-gw.ts；原 index.ts:5339) handleQuestion
// TODO(來自 session-read.ts；原 index.ts:5538) handleTranscript
// TODO(來自 session-read.ts；原 index.ts:5578) handleAbortSession
// TODO(來自 quota-ledger.ts；原 index.ts:5655) handleQuota
// TODO(來自 internal-http.ts；原 index.ts:6417) handleCanvasStateRead
// TODO(來自 internal-http.ts；原 index.ts:6438) handleTimelineRoutes
// TODO(來自 internal-http.ts；原 index.ts:6561) handleConfirmStatus
// TODO(來自 internal-http.ts；原 index.ts:6588) handleResumeSession
// TODO(來自 internal-http.ts；原 index.ts:6636) handleSessionKey
// TODO(來自 internal-http.ts；原 index.ts:6665) handleSessionTasks
// TODO(來自 internal-http.ts；原 index.ts:6735) handleOptimizePrompt
// TODO(來自 internal-http.ts；原 index.ts:6806) handleExtractLessons
// TODO(來自 memory-wiring.ts；原 index.ts:7316) handleMemoryBatchRunInternal
// TODO(來自 memory-wiring.ts；原 index.ts:7338) handleMemoryTrace
// TODO(來自 memory-wiring.ts；原 index.ts:7351) handleMemoryRecallSearch
// TODO(整合)：MEMORY_PRIVATE_DOCS_MAX 仍住 index.ts:6883（const 未 export，補 export 後改真 import，
// session-lifecycle.ts 已用同款佔位）。

export async function handleRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> {
  {
    const url = new URL(req.url)
    const pathname = url.pathname
    // B5 混音產物靜態服務（無鑑權，鏡像 TTS 音頻公開 blob 模型；MIX_PUBLIC_BASE=/agent/v1/timeline-mix/<sid>/mix.wav）。放在 Bearer 閘門之前。
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

    // G4 成片靜態服務（2026-09-17）：導出檔與封面幀公開直鏈（delivery_url 進成片索引，
    // B 端 /v1/masters 直接下載）。無鑑權鏡像 mix.wav／TTS 公開 blob 模型；放 Bearer 閘門之前。
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

    // TTS 音頻靜態服務（無鑑權，同平台公開 blob 模型）。放在 Bearer 閘門之前。
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
      return Response.json({ ok: true, timestamp: new Date().toISOString(), sessions: sessions.size })
    }

    // Internal routes: loopback-only, no API key
    if (pathname.startsWith("/internal/")) {
      if (!isLoopback(clientIp)) {
        return jsonError(403, "internal endpoint only reachable from localhost", "forbidden", "forbidden")
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
      // Wave C：畫布快照寫入 / 工具快照讀取 / ops 下發 / 回執（皆 loopback）。
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
      // 素材入庫：opencode video_upload 工具經此把外部影片/音頻下載進平台存儲。
      if (req.method === "POST" && pathname === "/internal/media/upload") {
        return handleMediaUpload(req)
      }
      // 子代理运行时：派发 + 工具轮询取件（loopback，鉴权同其他 internal 端点）。
      if (req.method === "POST" && pathname === "/internal/subagent/dispatch") {
        return handleSubagentDispatch(req)
      }
      if (req.method === "POST" && pathname === "/internal/subagent/status") {
        return handleSubagentStatus(req)
      }
      // 0920 停止閘：orchestrator 的主動停止入口（此前只有 dispatch/status，
      // orchestrator 眼睜睜看著子代理跑飛卻無權剎車）。body: { session_id, subagent_id?, all? }
      //   - 帶 subagent_id：停那一個（id 或 label 前綴）
      //   - all:true 或缺 subagent_id：停該會話名下全部在跑子代理
      if (req.method === "POST" && pathname === "/internal/subagent/stop") {
        return handleSubagentStop(req)
      }
      // D1（2026-10-02）：工具層重複呼叫斷路器的強制收尾（plugin eimu-guard 在 N+5 次時呼叫）。
      if (req.method === "POST" && pathname === "/internal/session/loop-breaker") {
        return handleLoopBreaker(req)
      }
      // ── 契約 §3.5：記憶批次手動觸發（每日 ticker 之外的運維入口）。──
      // 鑑權＝與現狀同構的 loopback-only 門（本 /internal/ 區塊上層已裁定：既有
      // /internal/* 全部只驗 isLoopback、無 HARNESS key；契約 §3.5 寫的
      // HARNESS_API_KEY 與現場衝突，上層裁決照現場、不加 key——偏離契約處已回報）。
      if (req.method === "POST" && pathname === "/internal/memory/batch-run") {
        return handleMemoryBatchRunInternal(req)
      }
      // 工作流引擎端點：接受 session_id（opencode 或 gateway id）解析 session。
      if (pathname === "/internal/workflow/templates" && req.method === "GET") {
        return workflowServiceTemplates()
      }
      if (pathname.startsWith("/internal/workflow/")) {
        const m = new URL(req.url)
        // 0920 回歸修復（重構引入）：原版是 `searchParams.get(...) || (await req.json())`
        // ——短路，query 帶 session_id（工具一律帶）時 body 不被讀。重構拆檔時改成
        // 無條件先讀 body，下游 handleWorkflowInternal 再讀同一條已消費的 body →
        // 一律 400「invalid json body」。實錘：任何 template/workflow_start POST
        // 都建不起骨架（野獸模式因此只能裸跑）。還原短路＝body 只在必要時才讀。
        const qsid = m.searchParams.get("session_id")
        const sessionId = qsid || ((await req.json().catch(() => ({}))) as { session_id?: string }).session_id || ""
        // 0920：Expert（子代理）的工具呼叫帶自己的 opencode session id——三段解析
        // 全 miss（子會話不進 sessions map）→ 此前一律 404，模板骨架永遠建不起來
        // （事故：野獸模式裸跑無角色卡）。兜底回父會話＝工作流落在用戶看得見的畫布。
        const session = sessionId ? resolveSession(sessionId) ?? subagentParentState(sessionId) : undefined
        if (!session) return jsonError(404, "session not found", "not_found", "not_found")
        // 2026-09-20 Phase 1：跑批完成推送的手動觸發入口（自動觸發在
        // runWfGenerate 的 generate .then）。語義＝「現在就把本會話當前
        // 工作流的完成態推給站點」，冪等（pushWorkflowCompletion 內
        // workflowCompletionPushed 去重）。放此處而非 handleWorkflowInternal：
        // 不需 body，且避免動到 /workflow/* 的 body 讀取契約（0920 血淚短路）。
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

    // 附件靜態直讀（票據鑑權，與上方 ticket SSE 同理：瀏覽器 <img> 帶不了
    // Authorization 頭）。路徑約束在 UPLOADS_DIR 內防目錄穿越；無效/過期票據
    // 與不存在的文件一律 404，不泄露存在性。
    {
      const m = pathname.match(/^\/agent\/v1\/uploads\/([^/]+)\/([^/]+)$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("t") ?? ""
        // decodeURIComponent 可能因畸形 % 序列拋 URIError：整段包裹，異常即 404。
        let sessionId = ""
        let fileName = ""
        try {
          sessionId = decodeURIComponent(m[1])
          fileName = decodeURIComponent(m[2])
        } catch {
          return jsonError(404, "not found", "not_found", "not_found")
        }
        // 穿越防禦：白名單字符集（與 sanitizeUploadName 產物同款 \w.\- 空格，
        // 天然排除 / 與 \）+ 顯式拒 ".." + resolve 前綴兜底（同上傳寫入 L485 寫法）。
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

    // 瀏覽器原片直傳影片（票據鑑權，與上方附件靜態直讀同理：瀏覽器帶不了
    // Authorization 頭，且原片超過站內代理 body 上限，前端繞開 Vercel 直連網關
    // origin）。讀票復用（redeemUploadTicket 非一次性）；落盤進同一 UPLOADS_DIR
    // 會話目錄，上傳後讀票路由即可直接讀回。不動 4MB attachments 端點。
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
            return jsonError(413, "video exceeds 100MB limit", "payload_too_large", "payload_too_large")
          }
          const ext = path.extname(file.name).toLowerCase()
          if (!file.type.startsWith("video/") && !VIDEO_UPLOAD_EXTS.has(ext)) {
            return jsonError(415, "only video files accepted", "unsupported_media_type", "unsupported_media_type")
          }
          const safeName = sanitizeUploadName(file.name)
          if (!safeName) {
            return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
          }
          const uploadDir = path.join(UPLOADS_DIR, sessionId)
          await mkdir(uploadDir, { recursive: true })
          const dest = path.join(uploadDir, safeName)
          if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
            return jsonError(400, "invalid path", "bad_request", "bad_request")
          }
          await Bun.write(dest, await file.arrayBuffer())
          return Response.json({ ok: true, path: `uploads/${sessionId}/${safeName}`, name: safeName, size: file.size, mime: file.type || "video/mp4" })
        } catch (e) {
          console.error("[gateway] video-upload error:", e)
          return jsonError(500, "video upload failed", "server_error", "server_error")
        }
      }
    }

    // Public routes: require a valid Bearer sk-biz-* key
    const rawKey = getBearer(req)
    if (!rawKey || !rawKey.startsWith("sk-biz-")) {
      return jsonError(401, "missing or invalid API key", "unauthorized", "unauthorized")
    }
    // 2026-09-13 刀3：兩步鑑權改並行。讀碼判定無真依賴——兩者都只吃 rawKey、各打
    // 獨立 PLATFORM_BASE 端點（validate→/v1/models；resolve→/biz/resolve-owner，
    // 後者本身以 Bearer rawKey 自證歸屬），串行只是「先驗權後正典」的順序慣例。
    // 語義恆等：ok=false 仍 401（此時 canonicalKey 棄用）；resolve 對無效 key 只是
    // 拿 non-200 → 負緩存 60s＋fallback rawKey，無副作用。串行 miss 24–533ms×2 →
    // 並行取 max。
    const [keyOk, canonicalKey] = await Promise.all([validateApiKey(rawKey), resolveCanonicalKey(rawKey)])
    if (!keyOk) {
      return jsonError(401, "invalid API key", "unauthorized", "unauthorized")
    }
    // R6 身份正典化：raw B key → 屬主派生 key——直連與 /api/agent/biz 代理從此同一
    // 身份空間（settings/sessions/野獸開關一致）。解析失敗一律 fallback rawKey：
    // 站点抖动不能变成网关故障（负缓存防风暴）。
    const key = canonicalKey

    if (req.method === "GET" && pathname === "/agent/v1/quota") {
      return handleQuota(key)
    }

    // Phase 0 觀測（2026-09-18）：per-turn 分段延遲與 event-loop lag 的記憶體
    // 聚合視圖（p50/p95/p99 + 樣本數）。鑑權沿用本區塊既有慣例（Bearer
    // sk-biz-* 閘門 + 上游驗證），純讀記憶體、無狀態、無副作用。
    if (req.method === "GET" && pathname === "/agent/v1/metrics") {
      return Response.json(turnMetricsSnapshot())
    }

    // 畫布 workflow 節點操作（rerun/update）：站點 /api/agent/sessions/:id/workflow-node-*
    // 代理進來。/internal/workflow/* 是 loopback-only，Vercel 站點打不進——這裡掛
    // Bearer 家族等價入口（同一 handleWorkflowInternal，endsWith 匹配前綴無關）。
    // 會話歸屬 getOwnedSession 防跨 key 越權；Bun Request.json() 重複讀取有緩存，
    // 與 /internal 家族「先讀 session_id 再交 handler」同款模式。
    if (req.method === "POST" && (pathname.endsWith("/workflow/node/rerun") || pathname.endsWith("/workflow/node/update"))) {
      // Bun Request body 只能讀一次：這裡只准用 query 拿 session_id，body 原樣留給
      // handleWorkflowInternal 再讀（與 /internal 家族 query 優先同款）。
      const wfSid = new URL(req.url).searchParams.get("session_id") || ""
      if (!wfSid) return jsonError(400, "session_id (query) is required", "bad_request", "bad_request")
      const wfState = getOwnedSession(key, wfSid)
      if (!wfState) return jsonError(404, "session not found", "not_found", "not_found")
      return handleWorkflowInternal(req, wfState)
    }

    

// 會話記憶補注（契約 §4）：resume/switch 的老會話事後補上帳戶畫像/教訓與
// memory_docs/memory_index_md。
// D1 修復（2026-09-15 PRD P0-4）：原實作只翻 memoryInjected 這面無人讀的死旗標
// → 對已注入 system 的會話完全無效（與原註釋宣稱相反）。真閘是 vettingInjected：
// 到達時重置為 false，並卸除 onboarding 指引（畫像非空，重建時不該再重複注入）；
// 下一回合按最新記憶重建 system。directiveInjected 刻意不重置——模板指引一次性，
// 重建時不會重複注入。
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
// 會話目錄：當前 key 的歷史會話列表（對話歷史 dropdown 的數據源）。
if (req.method === "GET" && pathname === "/agent/v1/sessions") {
  // 09-12：零回合會話（預建未用）不出現在目錄；數據保留，按 id 直連仍可達
  // （GET :id / :id/messages / SSE 回放 / DELETE 均不經此過濾，深鏈 switchSession 可用）。
  // 判據=持久化 eventCounter：只有 emit 任何 SSE 幀才會漲，而建號不 emit——
  // 「曾開始過回合」的結構性訊號。刻意不用 lastTurnActiveAt：它是 in-flight 打點、
  // turn 正常結束即清零（L4624 打點/L3975 清零），按它過濾會誤殺全部已完成會話
  // （實測 104 行真會話裡 102 行清零殘留）。過濾放在標題回填之前＝殭屍行不佔回填配額。
  const rows = listSessionRows(key).filter((r) => {
    const live = sessions.get(r.sessionId)
    return (live?.eventCounter ?? r.data.eventCounter ?? 0) > 0
  })
  // 會話摘要標題有界回填（2026-09-12）：idle 掛鉤上線前的存量會話 data 無
  // title；每次調用最多取 10 個缺欄行並發向 opencode 抓（3s 超時），拿到即
  // setRowTitle 落盤＋同步內存態（防在飛的 saveSession 把舊無標題鏡像蓋回去）。
  // 缺 opencode_session_id 的理論上不該存在，一併跳過；失敗靜默 null 不擋目錄。
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
          // 靜默降級：目錄返回不受單行回填影響
        }
      }),
    )
  }
  // 0831 歷史會話狀態標識（前端 dropdown 的圓點）：三態優先級
  // waiting（有未答的 question/confirm）> running（turn 在飛 或 有在途生成任務）> idle。
  // pendingQuestions/pendingConfirms 只在記憶體（重啟即清）；lastTurnActiveAt 是持久化
  // 欄位、turn 正常結束清零，但異常死亡的 turn 會留殘值 → 加 15 分鐘窗口，
  // 否則殭屍會話永遠掛著「運轉中」騙用戶。
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
        // 選填欄位契約：舊前端不讀不崩；null=尚未生成（降級時間標籤）。
        title: r.data.title ?? null,
      }
    }),
  })
}

// S7（2026-08-29）：用戶級 settings（key 維度，持久化 sessions.db，重啟不丟）。
// GET 無記錄回默認值 steer/efficient/balanced；POST 同 shape 部分更新，
// 未知欄位/非法值一律 400，不靜默吞。
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
  // beast_mode sanitize：顯式欄位放行（顯式列出、缺欄=保持現值；枚舉白名單會剝布林欄）。
  if (typeof body.beast_mode === "boolean") next.beast_mode = body.beast_mode
  else delete next.beast_mode
  saveUserSettings(key, next)
  return Response.json(next)
}


    if (req.method === "POST" && pathname === "/agent/v1/sessions") {
      return handleCreateSession(key, req)
    }

    if (req.method === "POST" && pathname === "/agent/v1/optimize-prompt") {
      return handleOptimizePrompt(key, req)
    }

    // TTS（配音）：同步快速調用，不走 poller。上游可用時直接回音頻 URL；
    // 上游不可用時誠實報錯（tts_unavailable），不造假成功。
    if (req.method === "POST" && pathname === "/agent/v1/tts") {
      return handleTts(key, req)
    }

    // 時間線（B1，2026-08-31）：/agent/v1/timeline 家族——session_id 一律走 query
    // （Bun Request body 只能讀一次，workflow 家族同款坑）；鑑權=上游 Bearer 閘門
    // + getOwnedSession 防跨 key 越權，不發明新機制。
    if (pathname === "/agent/v1/timeline" || pathname.startsWith("/agent/v1/timeline/")) {
      return handleTimelineRoutes(key, req, pathname)
    }

    // Director（片3，2026-09-02）：/agent/v1/director 家族——session_id 走 query 或 path，
    // 鑑權同款（Bearer 閘門 + resolveSession + apiKey 比對防跨 key 越權）。
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

    // 附件直讀票據（2026-08-29）：前端 <img> GET 帶不了 Authorization 頭，
    // 用認證 POST 換一張只讀票據（TTL 1 小時，與 sse-ticket 同構，key 校驗同款）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/uploads-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueUploadTicket(m[1]), expires_in_ms: UPLOAD_TICKET_TTL_MS })
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/abort$/)
    if (req.method === "POST" && m) {
      return handleAbortSession(key, m[1])
    }

    // REQ-D2：回合中追加指引（steer）。與 /messages 分開是刻意的——語義不同
    //（不終止當前回合、不另起用戶訊息），前端據回應的 status 顯示
    // 「已注入本回合」或「已排隊，下一回合生效」。
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

    // Wave C：畫布快照上行與 canvas.ops 回執（前端經站點代理呼叫）。
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

    // ── PRD P0-4（2026-09-15）記憶 trace 與召回路由（認證＝同族 Bearer 閘門）──
    // 契約 §3.6：注入 trace（R2 尺觀測點）；站點 /api/agent/sessions/[id]/memory-trace 只做代理。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/memory-trace$/)
    if (req.method === "GET" && m) {
      return handleMemoryTrace(key, m[1])
    }
    // 【契約外新增】memory_recall 工具（.opencode/tools 薄入口，PRD §6.2）的取數後端：
    // 從共享語料跑 §7 召回。契約 §3 未列此路由，屬本片新增（已在回報中標明）。
    if (req.method === "POST" && pathname === "/agent/v1/memory/recall") {
      return handleMemoryRecallSearch(key, req)
    }

    return jsonError(404, "not found", "not_found", "not_found")
  }
}
