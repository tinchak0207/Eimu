// events-translate.ts —— 自 index.ts 第二階段 Wave2 抽取：opencode 事件翻譯層——eventSessionId/boundMap/boundSet/isAssistantMessage/parseToolOutput、resolveResultUrl、emitImageDone/emitVideoDone/emitAudioDone、自動製畫布（canvasUnitId/readGenerateInput/autoCreateCanvasUnit/attachCanvasTask/emitCanvasResult）、toolErrorPayload、bash deny 歸因（bashDenyCache）、findUploadsByBasename/resolveInvisibleUploadPaths/deniedOperationLabel、trackTurnNodeTerminal、workflowStartSchemaHint、handleToolPartUpdate、idle-step breaker（finalizeIdleStep/triggerIdleStepBreaker）。
// 原 index.ts 2708–3618 行，逐行原樣搬運（僅頂層宣告加 export 前綴）。
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import type { SessionState } from "./types-gateway.ts"
import { PLATFORM_BASE, WORKSPACE_DIR, UPLOADS_DIR, TURN_RETRY_DELAY_MS, IDLE_STEP_ABORT_THRESHOLD, IDLE_STEP_NUDGE, IMAGE_URL_DEDUP_CAP, TOOL_STATUS_DEDUP_CAP } from "./constants-gateway.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { opencodeFetch, revertDeadTail } from "./opencode-client.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { estimateNodeCoins } from "./pricing-gateway.ts"
import { applyCanvasNodeCreated, applyCanvasNodeConnected, applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import { humanMessageFor, summarizeArgs } from "./humanize-gw.ts"
import { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
import { emitSessionError } from "./emit-helpers.ts"
import { workflowService } from "./workflow-gw.ts"
import { emitQuestionRequest } from "./questions-gw.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
// TODO(整合 Wave2)：以下為「仍住 index.ts 且尚未 export」符號的 declare 佔位（stage1 記憶「subagent 佔位符法」，bun build 不查名可過）。
// 整合階段於 index.ts 補 export 後換成真 import、刪除全部 declare，即完成橋接：
// import { workflowService, emitQuestionRequest, armWatchdogTimer } from "./index.ts"

// ---- opencode event translation -> frontend events ----

// sessionID lives in different properties depending on event type:
//   session.*            -> properties.sessionID
//   message.updated      -> properties.sessionID AND properties.info.sessionID
//   message.part.updated -> properties.part.sessionID (NO properties.sessionID)
//   message.part.delta   -> properties.sessionID
export function eventSessionId(event: any): string | undefined {
  const p = event?.properties
  return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
}

export function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

export function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

// Text parts carry no role, so the only way to tell the assistant's reply from
// the user's own prompt is the messageID -> role map built from message.updated.
// Unknown messageID => false: message.updated for a message always precedes its
// parts, so an unknown id means something is off and dropping is the safe side.
export function isAssistantMessage(state: SessionState, messageID: unknown): boolean {
  if (typeof messageID !== "string" || messageID.length === 0) return false
  return state.messageRole.get(messageID) === "assistant"
}

// tool state.output arrives as a JSON string (e.g. an HTTP 401 with ok:false).
// Parse defensively; malformed/absent output yields null so callers fall back to
// ok:false instead of throwing.
export function parseToolOutput(
  output: unknown,
): { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown } | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object") {
        return parsed as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
      }
      return null
    } catch {
      return null
    }
  }
  if (output && typeof output === "object") {
    return output as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
  }
  return null
}

// Shared image.done emission path, deduped per session by url (bounded Set, cap
// 100, evict oldest). Both the opencode tool-result translation and the
// /internal/emit entry point go through here, so the same image can never be
// announced twice to the frontend in one session.
// The platform hands back /v1/images/<id>/result — relative, Bearer-authed, and
// a 302 to a public store.tinchak0207.xyz .webp. An <img src> can send neither a
// host nor an auth header, and the frontend must never hold a backend key, so
// that URL is unrenderable as-is. Resolve the redirect here, server-side, and
// publish the terminal public URL instead.
//
// Verified 2026-08-07: GET the result path with the session key -> 302; Location
// is an unsigned, query-less, publicly readable image/webp (200 without auth).
// Because it carries no signature there is nothing to expire or leak.
export async function resolveResultUrl(rawUrl: string, key: string): Promise<string> {
  if (!rawUrl) return rawUrl
  // Already a public asset URL (poller/tool may hand one over directly).
  if (/^https?:\/\//i.test(rawUrl) && !/\/v1\/images\/[^/]+\/result\/?$/.test(rawUrl)) return rawUrl
  const absolute = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
  // 平台 /v1/images/{id}/result 預設回 JSON，帶 ?format=redirect 才 302 到公開 blob URL。
  const target = /\/v1\/images\/[^/]+\/result\/?$/.test(absolute) ? absolute + "?format=redirect" : absolute
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    })
    const loc = res.headers.get("location")
    if (loc && /^https?:\/\//i.test(loc)) return loc
    // Some deployments may serve the bytes directly instead of redirecting; the
    // absolute URL is then still wrong for the frontend, but it is the best we
    // have and at least names the right host.
    return absolute
  } catch {
    return absolute
  }
}

export async function emitImageDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string },
): Promise<void> {
  if (!url) return
  // Dedup on the RAW url: the same task resolved twice yields two different
  // public URLs only if the platform regenerates, but the raw form is stable.
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  const publicUrl = await resolveResultUrl(url, state.apiKey)
  emitToSession(state, "image.done", { url: publicUrl, cost_coins, task_id, ...(recipe ? { recipe } : {}) })
  // 自動製畫布：task 掛過 unit 就更新該 unit 的結果圖片節點。
  if (task_id) {
    emitCanvasResult(state, task_id, publicUrl, cost_coins)
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: "done",
    task_id,
    cost_coins,
    result_url: publicUrl,
  })
  void emitQuotaChanged(state)
}

export async function emitVideoDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "video" | "film",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  // 影片/成片 content 已是絕對公開 URL，無需 resolveResultUrl（它只重寫 /v1/images/.../result 形態）。
  emitToSession(state, "video.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "video",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

export async function emitAudioDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "audio",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  // 音頻 content 已是絕對公開 URL（平台 uploads），無需 resolveResultUrl（它只重寫 /v1/images/.../result 形態）。
  emitToSession(state, "audio.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "audio",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

// ---- 自動製畫布（Auto Canvas Builder） ----
//
// 暴君立場：deepseek 不「思考」畫布的事。它只提交生圖/改圖請求，
// gateway 攔截每個 image_* 工具的參數與結果，自動在畫布上重現：
//   文本節點(prompt) → 配置節點(model/size/n) → [執行] → 圖片節點(結果)
// 每次請求建立一個「畫布單元」(unit)，unit 內節點用相同 unit_id 前綴，
// 前端以 unit_id 關聯成組；task_id 掛在同一 unit 上，完成時更新該組。

export function canvasUnitId(): string {
  return `cu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export function summarizeCanvasTitle(model: string, prompt: string): string {
  const m = model || "生成"
  const p = prompt.trim().slice(0, 18)
  return p ? `${m} · ${p}${prompt.trim().length > 18 ? "…" : ""}` : m
}

// 從工具 input 抽取生成參數（deepseek 送哪欄就用哪欄，缺失給安全預設）。
export function readGenerateInput(input: unknown): {
  prompt: string
  model: string
  size: string
  n: number
  kind: string
  quality?: string
  image?: string // edit/upscale 的來源 mediaId/URL
  lora?: string // P1-E1：聊天「存為資產」帶真 LoRA（loraModelVersionIds 首位）
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const prompt =
    typeof obj.prompt === "string"
      ? obj.prompt
      : typeof obj.content === "string"
        ? obj.content
        : ""
  const model = typeof obj.model === "string" && obj.model ? obj.model : "gpt-image-2"
  const size = typeof obj.size === "string" && obj.size ? obj.size : "1024x1024"
  const nNum = typeof obj.n === "number" ? obj.n : typeof obj.count === "number" ? obj.count : 1
  const n = Number.isFinite(nNum) ? Math.max(1, Math.min(15, Math.floor(nNum))) : 1
  const kind = typeof obj.kind === "string" && obj.kind === "video" ? "video" : "image"
  const quality = typeof obj.quality === "string" ? obj.quality : undefined
  const image = typeof obj.image === "string" && obj.image ? obj.image : undefined
  const loraRaw = obj.loraModelVersionIds ?? obj.lora ?? obj.lora_id
  const lora =
    typeof loraRaw === "string" && loraRaw
      ? loraRaw
      : Array.isArray(loraRaw) && loraRaw.length > 0
        ? String(loraRaw[0])
        : undefined
  return { prompt, model, size, n, kind, quality, image, lora }
}

// 建立一個畫布單元並 emit 節點/連線事件。回傳 unit id。
// S4：cost_hint 需查平台目錄（async），函數簽名改 async；兩處呼叫點
//（tool status running / completed 補發）均改 await，行為語義不變。
// 自動製畫布只給「真的會出圖」的工具（2026-09-29 e2e 像素實錘）：原本 startsWith("image_")
// 讓 image_quote／image_get_result／image_upload 也各鋪一組「(未填写内容) + gpt-image-2 · 1024x1024
// 待处理」空節點，永遠不會跑，還一路帶到用戶之後開的新對話畫布上。
const AUTO_CANVAS_TOOLS = new Set(["image_generate", "image_edit", "image_upscale"])

export async function autoCreateCanvasUnit(
  state: SessionState,
  toolName: string,
  input: unknown,
  callID: string,
): Promise<string> {
  const cfg = readGenerateInput(input)
  const unitId = canvasUnitId()

  // 計畫卡：一句話讓暴君知道他會被怎麼對待。
  const planLabel =
    toolName === "image_edit"
      ? "改圖（圖生圖）"
      : toolName === "image_upscale"
        ? "放大"
        : toolName === "image_generate"
          ? cfg.kind === "video"
            ? "生影片"
            : "生圖"
          : "生成"
  // S4 規格2（2026-08-27）：cost_hint 從 null 改為真實估算（幣）。估算鏈：
  // ① 工具 input 自帶 cost_coins（上游工具已按目錄算好，最準）→
  // ② 平台目錄單價 × 數量（image）/ 檔位價 5/10 幣每秒（video，R5-C）→
  // ③ 兩者都取不到保持 null（不許編數）。
  let costHint: number | null = null
  if (input && typeof input === "object") {
    const inline = (input as Record<string, unknown>).cost_coins
    if (typeof inline === "number" && Number.isFinite(inline)) costHint = inline
    else if (typeof inline === "string" && inline && Number.isFinite(Number(inline))) costHint = Number(inline)
  }
  if (costHint === null) {
    const inputObj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const estimated = await estimateNodeCoins(
      {
        kind: cfg.kind,
        metadata: {
          model: cfg.model,
          count: cfg.n,
          ...(cfg.quality ? { quality: cfg.quality } : {}),
          ...(typeof inputObj.duration_seconds === "number" ? { duration_seconds: inputObj.duration_seconds } : {}),
        },
      },
      state.apiKey,
    )
    if (estimated !== null) costHint = estimated
  }
  emitToSession(state, "canvas.plan", {
    unit_id: unitId,
    tool: toolName,
    label: planLabel,
    prompt: cfg.prompt,
    model: cfg.model,
    size: cfg.size,
    count: cfg.n,
    kind: cfg.kind,
    source_image: cfg.image ?? null,
    cost_hint: costHint,
  })

  // 文本節點：承載 prompt（source_image 存在時併���提示，編輯語義）。
  const textNode = {
    id: `${unitId}-text`,
    type: "text",
    title: summarizeCanvasTitle(cfg.model, cfg.prompt),
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      content: cfg.prompt,
      status: "idle",
      source_image: cfg.image ?? (toolName === "image_edit" || toolName === "image_upscale" ? cfg.image ?? null : null),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: textNode })
  applyCanvasNodeCreated(state.sessionId, { node: textNode })

  // 配置節點：model/size/n/kind。
  const configNode = {
    id: `${unitId}-config`,
    type: "config",
    title: `${cfg.model} · ${cfg.size}`,
    position: { x: 0, y: 0 },
    width: 440,
    height: 240,
    metadata: {
      content: "",
      status: "idle",
      model: cfg.model,
      size: cfg.size,
      count: cfg.n,
      kind: cfg.kind,
      ...(cfg.quality ? { quality: cfg.quality } : {}),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: configNode })
  applyCanvasNodeCreated(state.sessionId, { node: configNode })

  // 連線：文本 → 配置。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id },
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id } })

  // 預留圖片節點（結果落地時更新同一節點）。
  const imageNode = {
    id: `${unitId}-image`,
    type: "image",
    title: "生成中…",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "", status: "loading" },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: imageNode, target_kind: "result" })
  applyCanvasNodeCreated(state.sessionId, { node: imageNode })
  // 連線：配置 → 圖片。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id },
    target_kind: "result",
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id } })

  state.canvasUnitByCall.set(callID, unitId)
  boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
  markDirty(state) // 畫布快照已套用：隨 session 防抖落盤，重啟後可恢復
  return unitId
}

// 為已建立的 unit 掛上 task_id（submit 完成階段），供結果更新。
export function attachCanvasTask(state: SessionState, callID: string, taskId: string, unitId?: string): void {
  const target = unitId ?? state.canvasUnitByCall.get(callID)
  // 0831：本輪任務登記（權威 task_id 來源 + 壓縮在途閘依據）。置於 unit 判斷之前：
  // 即使畫布 unit 尚未就緒（autoCreateCanvasUnit 異步），已提交的 task 也必須被追蹤，
  // 否則在途閘漏放 → 壓縮照樣踩中摘要 tool-call 死鎖。
  if (taskId) {
    state.sessionTasks.set(taskId, { task_id: taskId, status: "queued", submitted_at: Date.now() })
  }
  if (!target || !taskId) return
  state.canvasUnitByTask.set(taskId, target)
  boundMap(state.canvasUnitByTask, TOOL_STATUS_DEDUP_CAP)
}

// task_id → unit 存在時，emit 完成事件；返回命中與否。
export function emitCanvasResult(
  state: SessionState,
  taskId: string,
  url: string,
  cost_coins?: number,
): boolean {
  // 0831：任務終態登記（成功）。置於 unit 判斷前：無畫布 unit 也要如實記 succeeded+url。
  const t = state.sessionTasks.get(taskId)
  if (t) {
    t.status = "succeeded"
    t.url = url
  }
  const unitId = state.canvasUnitByTask.get(taskId)
  if (!unitId) return false
  const patch = { status: "success", content: url, ...(typeof cost_coins === "number" ? { cost_coins } : {}) }
  emitToSession(state, "canvas.node.updated", {
    unit_id: unitId,
    node_id: `${unitId}-image`,
    patch,
    url,
    cost_coins,
  })
  applyCanvasNodeUpdated(state.sessionId, { node_id: `${unitId}-image`, patch })
  return true
}

/**
 * S2a：從結構化工具輸出抽失敗載荷，組出三欄位錯誤合同
 * {code, message, human_message}。兼容三種輸入形態：
 *  - 工具層 fail()：{error:{code,hint}}
 *  - gateway jsonError 透傳：{error:{message,type,code}}（code 可能被工具層
 *    塞成物件——workflow_rerun 舊裂縫的實際形態）
 *  - 純字串/無 error：fallback message。
 */
export function toolErrorPayload(
  parsed: { error?: unknown } | null,
  fallbackMessage: string,
): { code: string; message: string; human_message: string } {
  let code = "tool_failed"
  let message = fallbackMessage
  const e = parsed && typeof parsed === "object" ? parsed.error : null
  if (typeof e === "string" && e) {
    message = e
  } else if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown; hint?: unknown }
    if (o.code && typeof o.code === "object") {
      const inner = o.code as { message?: unknown; code?: unknown }
      if (typeof inner.message === "string" && inner.message) message = inner.message
      if (typeof inner.code === "string" && inner.code) code = inner.code
    } else {
      if (typeof o.message === "string" && o.message) message = o.message
      else if (typeof o.hint === "string" && o.hint) message = o.hint
      if (typeof o.code === "string" && o.code) code = o.code
    }
  }
  return { code, message, human_message: humanMessageFor(message, code) }
}

// ── R8-B 工單 #2（2026-08-29）：拒單報因 ──
// R8 實錘：grep BRE 交替 \| 撞 deny 的 *|* 被拒，報錯不說命中哪條規則，
// 模型花 78s 人肉逆向權限表。修法：被拒 bash 命令對 permission.bash 的
// deny glob 求匹配，error 幀附 matched_pattern + 一句替代寫法。
export let bashDenyCache: { at: number; patterns: string[] } | null = null
export function loadBashDenyPatterns(): string[] {
  const now = Date.now()
  if (bashDenyCache && now - bashDenyCache.at < 60_000) return bashDenyCache.patterns
  let patterns: string[] = []
  try {
    const raw = readFileSync(path.join(WORKSPACE_DIR, ".opencode", "opencode.json"), "utf-8")
    const cfg = JSON.parse(raw) as { permission?: { bash?: Record<string, string> } }
    patterns = Object.entries(cfg.permission?.bash ?? {})
      .filter(([, v]) => v === "deny")
      .map(([k]) => k)
  } catch {
    // 配置讀不到就不歸因——報錯退回短句，不阻塞工具錯誤透傳
  }
  bashDenyCache = { at: now, patterns }
  return patterns
}

/** deny glob → RegExp（* 通配任意字元含換行，其餘按字面量）。 */
export function denyGlobToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*")
  return new RegExp(`^${body}$`)
}

/** 替代寫法提示（按命中規則類型給一句可操作的話；出站文案一律簡體）。 */
export function denyHintFor(pattern: string): string {
  if (pattern === "*|*") return "BRE 交替 \\| 含禁止符 |。改用宽匹配后自行筛选（如 grep -n \"第.*章\"），或改用 run_py 工具写脚本处理"
  if (pattern === "*&&*" || pattern === "*||*" || pattern === "*;*") return "执行环境只允许单条命令。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  if (pattern === "*>*" || pattern === "*>>*" || pattern === "*<*") return "执行环境禁止重定向/输入改向。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  return "请改用允许的命令（ls/cat/grep/sed -n/awk/find 等），或改用 run_py 工具写脚本"
}

/** 對 deny glob 求匹配；命中多條時取最具體的（非 * 字面量最長者），跳過全捕 *。 */
export function bashDenyAttribution(cmd: string): { pattern: string; hint: string } | null {
  if (!cmd) return null
  let best: { pattern: string; score: number } | null = null
  for (const p of loadBashDenyPatterns()) {
    if (p === "*") continue // 全捕規則不報因（零信息量）
    if (!denyGlobToRegExp(p).test(cmd)) continue
    const score = p.replace(/\*/g, "").length
    if (!best || score > best.score) best = { pattern: p, score }
  }
  if (!best) return null
  return { pattern: best.pattern, hint: denyHintFor(best.pattern) }
}

/** R8-B 工單 #5：uploads 目錄遞歸找同名文件，取 mtime 最新者。 */
export function findUploadsByBasename(basename: string): string | null {
  let found: string | null = null
  let foundMtime = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (e.name === basename || e.name.toLowerCase() === basename.toLowerCase()) {
        try {
          const m = statSync(p).mtimeMs
          if (m > foundMtime) {
            foundMtime = m
            found = p
          }
        } catch {
          // stat 失敗的文件跳過
        }
      }
    }
  }
  walk(UPLOADS_DIR, 0)
  return found
}

// R8-B 工單 #5：消息文本裡的絕對路徑 token（≥2 段，含 /tmp/daming-book.pdf 形態）。
export const ABS_PATH_RE = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g

/** R8-B 工單 #5：用戶給的路徑在沙箱視圖（workspace）不存在但 uploads/** 有同名
 *  文件 → 返回系統注文本（拼進送模型的 message 前面）；解析不到回 null。 */
export function resolveInvisibleUploadPaths(content: string): string | null {
  const candidates = new Set(content.match(ABS_PATH_RE) ?? [])
  const notes: string[] = []
  for (const raw of candidates) {
    const p = raw.replace(/[.,;:!?)）】"'，。；：]+$/, "")
    if (p.startsWith(WORKSPACE_DIR)) continue // 沙箱視圖內本來就可見
    const basename = p.split("/").pop() ?? ""
    if (!basename) continue
    const hit = findUploadsByBasename(basename)
    if (hit) notes.push(`[系统] 路径 ${p} 执行环境不可见，同名文件已解析到 ${hit}，后续操作请使用解析后的路径`)
  }
  return notes.length > 0 ? notes.join("\n") : null
}

/** R4-A S10：被拒操作的可讀標籤——bash 取命令前綴（截 80 字符），其他工具取工具名。 */
export function deniedOperationLabel(toolName: string, input: unknown): string {
  let op = ""
  if (input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === "string" && cmd.trim()) {
      const firstLine = cmd.trim().split("\n")[0] ?? ""
      op = `bash 命令 "${firstLine.slice(0, 80)}${firstLine.length > 80 ? "…" : ""}"`
    }
  }
  if (!op) op = toolName || "未知操作"
  return `（被拒操作：${op}）`
}

/** R4-A S8：採集本 turn 內到達終態的節點（emitToSession 中央出口調用）。 */
export function trackTurnNodeTerminal(state: SessionState, data: unknown): void {
  const d = (data ?? {}) as {
    node_id?: unknown
    nodeId?: unknown
    id?: unknown
    patch?: { status?: unknown }
    status?: unknown
  }
  const nodeId =
    typeof d.node_id === "string" ? d.node_id : typeof d.nodeId === "string" ? d.nodeId : typeof d.id === "string" ? d.id : ""
  const status = typeof d.patch?.status === "string" ? d.patch.status : typeof d.status === "string" ? d.status : ""
  if (!nodeId || (status !== "success" && status !== "error")) return
  if (!state.turnTerminalNodes) state.turnTerminalNodes = []
  const key = `${nodeId}:${status}`
  if (state.turnTerminalNodes.some((n) => `${n.id}:${n.status}` === key)) return
  state.turnTerminalNodes.push({ id: nodeId, status })
  if (state.turnTerminalNodes.length > 64) state.turnTerminalNodes.shift()
}

/** 修 4（2026-09-01）：workflow_start 載荷形狀示例。opencode 工具層把 gateway
 *  400 丟成裸「tool failed」，模型只能拿用戶的幣和時間盲猜形狀（實測連錯 2 張
 *  失敗卡才中）。從模板註冊表取該模板 text role 的真實欄位，回一段可照抄的
 *  緊湊 JSON 示例；註冊表不可得時用 single_video 的 canonical 形狀兜底。 */
export function workflowStartSchemaHint(input: unknown): string {
  const templateId =
    input && typeof input === "object" && typeof (input as { template_id?: unknown }).template_id === "string"
      ? (input as { template_id: string }).template_id
      : ""
  const roles: string[] = []
  if (templateId) {
    try {
      const tpl = (workflowService.templates() as Array<{ id?: unknown; nodes?: { role?: unknown; kind?: unknown }[] }>).find(
        (t) => t.id === templateId,
      )
      for (const n of tpl?.nodes ?? []) {
        if (n.kind === "text" && typeof n.role === "string") roles.push(n.role)
      }
    } catch {
      // 註冊表不可得：走通用示例兜底
    }
  }
  const contentShape = roles.length
    ? JSON.stringify(Object.fromEntries(roles.map((r) => [r, { content: "…" }])))
    : '{"shot":{"content":"…"}}'
  return (
    `workflow_start 载荷形状不对（参数被拒，不是上游故障）。content 必须按「文本角色名 → {content: 提示词文本}」组织` +
    `${templateId ? `（模板 ${templateId} 的文本角色：${roles.length ? roles.join("、") : "未知"}）` : ""}。` +
    `照此形状重试一次即可：{"template_id":"${templateId || "single_video"}","content":${contentShape}}`
  )
}

export function handleToolPartUpdate(state: SessionState, part: any): void {
  const toolName = typeof part?.tool === "string" ? part.tool : ""
  const callId = typeof part?.callID === "string" ? part.callID : ""
  const st = part?.state
  if (!st || typeof st !== "object") return
  const status = typeof st.status === "string" ? st.status : ""
  if (!callId || !status) return

  // Dedup by callID + status so a repeated identical status does not re-emit.
  const dedupKey = `${callId}:${status}`
  if (state.toolStatusSeen.has(dedupKey)) return
  state.toolStatusSeen.add(dedupKey)
  boundSet(state.toolStatusSeen, TOOL_STATUS_DEDUP_CAP)

  // R2-A 看門狗：工具真實開跑 = turn 已啟動，餵狗。（question 工具的
  // pending 也要算——它在等用戶回答，turn 顯然活著。）
  if (status === "pending" || status === "running" || status === "completed") {
    state.turnToolStarted = true
  }

if (status === "pending" || status === "running") {
    // question is not a generic running tool. The agent is blocked on a
    // que_* request; emit question.request so the frontend can reply.
    if (toolName === "question") {
      void emitQuestionRequest(state, callId, st.input)
      return
    }
    // 只在拿到工具輸入後才發 invoke。opencode 的 pending 狀態常只有
    // {status:"pending"} 而沒有 input；等 running（input 完整）再發，
    // 前端工具卡才顯示得出「在做什麼」，不是黑盒。
    const argsSummary = summarizeArgs(st.input)
    if (state.toolInvokeSeen.has(callId)) return
    if (!argsSummary && status === "pending") return
    state.toolInvokeSeen.add(callId)
    boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
    emitToSession(state, "tool.invoke", {
      tool: toolName,
      args_summary: argsSummary,
    })
    // 自動製畫布：image_* 工具首次建立畫布單元。deepseek 完全不知道——
    // 它只是提交請求，gateway 攔截參數自動建文本/配置/圖片節點。
    if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId) && st.input != null) {
      void autoCreateCanvasUnit(state, toolName, st.input, callId)
    }
  } else if (status === "completed") {
    // 若 running 階段因 input 缺失沒發過 invoke，這裡補發一次（completed 的
    // input 一定完整），確保前端工具卡必定有說明、不黑盒。
    if (!state.toolInvokeSeen.has(callId) && st.input != null) {
      state.toolInvokeSeen.add(callId)
      boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
      emitToSession(state, "tool.invoke", {
        tool: toolName,
        args_summary: summarizeArgs(st.input),
      })
      // 同上：跑到 completed 才見到 input 的工具（理論上不會，但保險起見）。
      if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId)) {
        void autoCreateCanvasUnit(state, toolName, st.input, callId)
      }
    }
    const parsed = parseToolOutput(st.output)
    // 只認明確帶 ok 欄位的結構化輸出；沒有 ok 欄位（原生工具文字輸出）一律視為成功。
    const hasOkFlag = parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean"
    const ok = hasOkFlag ? (parsed as { ok: boolean }).ok === true : true
    // S2a（2026-08-27）：ok 語義收緊為「已執行且成功」。失敗必落
    // {ok:false, error:{code,message,human_message}}——human_message 中文短句必填。
    // 舊代碼非 image_ 工具無條件回 ok:true，導致 workflow_rerun_node 等失敗工具
    // 在 SSE 上偽成功（評測 event 687-690 實錘）。
    const toolErr = !ok ? toolErrorPayload(parsed, "tool failed") : null
    // artifact_pending：已提交、成品未到——回包给了 task_id 但还没有成品 url。
    const artifactPending =
      ok && typeof parsed?.task_id === "string" && !!parsed.task_id && !(typeof parsed?.url === "string" && parsed.url.length > 0)
    if (toolName.startsWith("image_")) {
      // 自動製畫布：submit 完成後把 task_id 掛回 unit，完成事件才夠關聯。
      if (ok && typeof parsed?.task_id === "string" && parsed.task_id) {
        attachCanvasTask(state, callId, parsed.task_id)
      }
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        cost_coins: typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined,
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
      })
      if (ok && typeof parsed?.url === "string" && parsed.url.length > 0) {
        // P1-E1：image.done 附帶真實配方（prompt/model/size/lora），前端
        // 「存為資產」直接拿，不必再從 transcript 對應。
        const cfg = st.input != null ? readGenerateInput(st.input) : undefined
        void emitImageDone(state, parsed.url, parsed.cost_coins, parsed.task_id, cfg ? { prompt: cfg.prompt, model: cfg.model, size: cfg.size, lora: cfg.lora } : undefined)
      }
    } else {
      // R1（2026-09-11）刀4：非 image_ 工具的 tool.result 補回填載荷。評測實錘 10 條
      // result 全為 {tool,ok,event_id} 空殼（前端契約的 cost_coins / error.human_message
      // / summary 全部拿不到）。有成本數字就帶 cost_coins（quote/generate 類）；報價類
      // 工具再帶一句 summary 短文案；同步子代理 deadline 超時補 partial/reason。
      const parsedObj =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
      const costCoins =
        parsedObj && typeof parsedObj.cost_coins === "number"
          ? parsedObj.cost_coins
          : parsedObj && typeof parsedObj.total_coins === "number"
            ? parsedObj.total_coins
            : parsedObj && typeof parsedObj.confirmed_subtotal_coins === "number"
              ? parsedObj.confirmed_subtotal_coins
              : undefined
      let quoteSummary: string | undefined
      if (parsedObj && /quote/i.test(toolName)) {
        if (typeof parsedObj.summary === "string" && parsedObj.summary) {
          quoteSummary = parsedObj.summary
        } else {
          const bits: string[] = []
          if (typeof parsedObj.total_coins === "number") bits.push(`合计 ${parsedObj.total_coins} 币`)
          else if (typeof parsedObj.confirmed_subtotal_coins === "number")
            bits.push(`已定价小计 ${parsedObj.confirmed_subtotal_coins} 币`)
          if (typeof parsedObj.unknown_price_count === "number" && parsedObj.unknown_price_count > 0)
            bits.push(`${parsedObj.unknown_price_count} 项待确认`)
          if (Array.isArray(parsedObj.available_models)) bits.push(`可用模型 ${parsedObj.available_models.length} 个`)
          if (bits.length) quoteSummary = bits.join("，")
        }
      }
      const subagentTimeout = toolName === "subagent_dispatch" && !ok && /超过预定时间/.test(toolErr?.message ?? "")
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        // 報價類的 total_coins 是估價不是扣費：不掛 cost_coins（前端會當「已用/消耗」累加，
        // 2026-09-29 e2e 實錘「已用 614 币」而帳戶只有 7 币）；金額已在 summary 裡。
        ...(typeof costCoins === "number" && !/quote/i.test(toolName) ? { cost_coins: costCoins } : {}),
        ...(quoteSummary ? { summary: quoteSummary } : {}),
        ...(subagentTimeout ? { partial: true, reason: "timeout" } : {}),
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
      })
      // 原生工具（bash 等）可能回傳的是「含圖片 URL 的 JSON」——例如引擎用
      // bash 呼叫 kotone-bridge 生圖，輸出 {text, images:[{url,...}]}。這類
      // 結果也要送 image.done，前端右側展示框才會顯示圖片（否則只有泡泡文字）。
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { images?: unknown }).images)) {
        const imgs = (parsed as { images: { url?: string; width?: number; height?: number }[] }).images
        for (const im of imgs) {
          if (typeof im?.url === "string" && im.url.length > 0) {
            void emitImageDone(state, im.url)
          }
        }
      }
      // 影片安全網（2026-08-31）：任何非 image_ 工具結果帶平台影片 URL（video_upload 回
      // {ok,url,content_type:video/*}、run_py 裁後上傳、workflow 工具回 {url} 為影片）→ 發
      // video.done，聊天框出影片卡。對稱於上面 image.done；dedup 由 emitVideoDone 的
      // announcedUrls 兜底，與 film 節點 runNode 出口不重複。
      if (parsed !== null && typeof parsed === "object") {
        const isVideoUrl = (u: unknown): u is string =>
          typeof u === "string" && u.length > 0 && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)
        const vidUrls: string[] = []
        if (isVideoUrl((parsed as { url?: unknown }).url)) vidUrls.push((parsed as { url: string }).url)
        if (isVideoUrl((parsed as { video_url?: unknown }).video_url)) vidUrls.push((parsed as { video_url: string }).video_url)
        if (Array.isArray((parsed as { videos?: unknown }).videos)) {
          for (const v of (parsed as { videos: { url?: unknown }[] }).videos) if (isVideoUrl(v?.url)) vidUrls.push(v.url as string)
        }
        for (const vu of vidUrls) void emitVideoDone(state, vu, typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined, undefined, "video")
      }
      // 音頻安全網（2026-09-11）：任何非 image_ 工具結果帶平台音頻 URL（music_gen 回
      // {ok,url:...m4a}、video_upload 收 audio/* 後回 {url}、TTS 落盤 URL）→ 發
      // audio.done，聊天框出音頻卡。與上面影片安全網逐字對稱（同一 dedup 集合
      // announcedUrls，由 emitAudioDone 兜底，不與其他出口重複）。
      if (parsed !== null && typeof parsed === "object") {
        const isAudioUrl = (u: unknown): u is string =>
          typeof u === "string" && u.length > 0 && /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i.test(u)
        const audUrls: string[] = []
        if (isAudioUrl((parsed as { url?: unknown }).url)) audUrls.push((parsed as { url: string }).url)
        if (isAudioUrl((parsed as { audio_url?: unknown }).audio_url)) audUrls.push((parsed as { audio_url: string }).audio_url)
        if (Array.isArray((parsed as { audios?: unknown }).audios)) {
          for (const a of (parsed as { audios: { url?: unknown }[] }).audios) if (isAudioUrl(a?.url)) audUrls.push(a.url as string)
        }
        for (const au of audUrls) void emitAudioDone(state, au, typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined, undefined, "audio")
      }
    }
  } else if (status === "error") {
    const err = st.error
    let message =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "tool failed"
    // 0919 斷點②修復：question 工具以 aborted 收尾≠用戶中止——是 orchestrator
    // 調 question 凍結 turn 時殺掉在途輪的內部中止（實錘 13:00:21 兩條
    // 「已按你的要求中止本轮」冒充用戶話術）。此處換中性話術；用戶真中止
    // 走 /abort 端點（6516），不經此分支。
    let isQuestionFreezeAbort = false
    if (toolName === "question" && /\baborted?\b/i.test(message)) {
      isQuestionFreezeAbort = true
      message = "本回合已暂停，等待你在问题卡上选择后继续"
    }
    // 0920 暴君欽點：abort 類工具錯誤一律不發卡——①真用戶按停：UI 收尾由
    // turn.done 表達（與 emitSessionError 的 MessageAbortedError 早退同構，09-18）；
    // ②系統自殺輪（failover 換線/idle 止損/子代理換模殺在途工具）此前經此分支
    // 彈「已按你的要求中止本轮」錯誤卡＝栽贓用戶＋欺君。兩種情況都只留日誌。
    if (!isQuestionFreezeAbort && /\b(aborted?|cancel(?:led|ed) by user|interrupted by user)\b/i.test(message)) {
      console.log(`[gateway] tool abort, card suppressed (UI 收尾走 turn.done): callId=${callId} tool=${toolName} message=${message}`)
      return
    }
    // 修 4：workflow_start 的裸「tool failed」→ 帶期望 schema 的可照抄報錯。
    // 工具層不透傳 gateway 400 body，模型此前只能盲猜載荷形狀；命中條件 =
    // workflow_start + 報錯無任何中文（真實中文報錯如「缺少必要內容」不覆蓋）。
    if (toolName === "workflow_start" && !/[\u4e00-\u9fff]/.test(message)) {
      message = workflowStartSchemaHint(st.input)
    }
    // 2026-08-22：opencode 的 deny 消息自帶完整權限規則表（120+ 條 JSON），
    // 原樣透傳=防禦清單直接送給任何用戶（偵察面）。權限攔截一律換成短句。
    // R4-A S10（2026-08-28）：R4 實錘「此操作不在允许范围内，已跳过」×7 不說
    // 是哪個操作——補上被拒操作（bash 命令前綴，非 bash 工具補工具名）。
    // R8-B 工單 #2（2026-08-29）：再補命中規則（matched_pattern）與替代寫法——
    // R8 實錘模型花 78s 人肉逆向 deny 表，報因後此段歸零。
    let denyInfo: { pattern: string; hint: string } | null = null
    if (/specified a rule which prevents|relevant rules/i.test(message)) {
      const cmd =
        st.input && typeof st.input === "object" && typeof (st.input as { command?: unknown }).command === "string"
          ? (st.input as { command: string }).command
          : ""
      denyInfo = bashDenyAttribution(cmd)
      message = `此操作不在允许范围内，已跳过${deniedOperationLabel(toolName, st.input)}${
        denyInfo ? `。命中规则：${denyInfo.pattern}；替代写法：${denyInfo.hint}` : ""
      }`
    }
    // S2a：error 態的 tool.result 同樣補齊三欄位錯誤合同。
    emitToSession(state, "tool.result", {
      tool: toolName,
      ok: false,
      error: {
        code: isQuestionFreezeAbort ? "question_freeze" : "tool_error",
        message,
        human_message: isQuestionFreezeAbort ? message : humanMessageFor(message, undefined),
        ...(denyInfo ? { matched_pattern: denyInfo.pattern, hint: denyInfo.hint } : {}),
      },
    })
    // question 凍結中止不是錯誤：不進 session.error 幀（避免 UI 紅卡）、
    // 不記上游錯（不是渠道故障，別誤觸 failover 重投）。
    if (isQuestionFreezeAbort) {
      console.log(`[gateway] question freeze abort: callId=${callId} — turn paused pending answer (no error frame)`)
      return
    }
    emitSessionError(state, "tool_error", message)
  }
}

// ── P2b（2026-09-11）刀2：空轉止損 ──────────────────────────────────
// step 結算：無 tool、無非空正文、無非空 reasoning = 空 step。空 step 連續累計；
// 任一活動歸零。達閾值且 turn 活躍 → 中止 + 同輪補一次動作導向 nudge。
export function finalizeIdleStep(state: SessionState): void {
  // 空轉補丁：本 step 只有 no-op bash 且無正文 → 視為空 step（即使有 reasoning）
  const noopOnly = !!state.stepNoopTool && !state.stepHasTool && !state.stepHasText
  const empty = noopOnly || (!state.stepHasTool && !state.stepHasText && !state.stepHasReasoning)
  state.stepNoopTool = false
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  if (!empty) {
    state.idleSteps = 0
    return
  }
  state.idleSteps = (state.idleSteps ?? 0) + 1
  if (
    state.idleSteps >= IDLE_STEP_ABORT_THRESHOLD &&
    !state.idleNudgeSent &&
    !state.turnAborted &&
    (state.lastTurnActiveAt ?? 0) > 0 &&
    state.lastPromptBody
  ) {
    triggerIdleStepBreaker(state)
  }
}

export function triggerIdleStepBreaker(state: SessionState): void {
  const body = state.lastPromptBody
  if (!body) return
  state.idleNudgeSent = true
  const gen = state.turnGen ?? 0
  const nudgeBody = {
    ...body,
    parts: [...body.parts.map((pt) => ({ ...pt })), { type: "text", text: IDLE_STEP_NUDGE }],
  }
  console.warn(
    `[gateway] idle-step breaker: ${IDLE_STEP_ABORT_THRESHOLD} empty steps, abort+nudge — session=${state.sessionId} gen=${gen}`,
  )
  // ① 中止當前 turn（與用戶中止同一後端路徑）。
  void opencodeFetch(`/session/${state.opencodeSessionId}/abort`, {
    method: "POST",
    timeoutMs: 5000,
  }).catch(() => {})
  state.turnAborted = true
  // D2-1b（2026-09-23）：來源＝系統（內部斷路器），不是用戶叫停。排隊中的 steer
  // 只能被「用戶停止」丟棄（停止優先的權威定義見 steer-core.abortIsUserStop）——
  // 這裡只是換一種方式把同一輪續跑（下面補 nudge 重投），用戶的指引仍然有效。
  state.turnAbortSource = "system"
  stripStaleTurnTextFromReplay(state)
  // 中止輪的 session.idle 不得再觸發抖動/failover 二次重投：retryQueued 佔位。
  // 本輪的重投就是下面的 nudge；再空轉保持佔位 = 不循環，讓它自然失敗。
  state.retryQueued = true
  // ② 同一 turn 週期僅一次：原樣重發最後一條用戶消息，尾端附動作導向提示。
  setTimeout(async () => {
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen) return
    try {
      // 2026-10-01 去重：空 step 輪零產出 → 撤掉原 user 訊息，nudgeBody（原文＋提示）只留一條。
      await revertDeadTail(cur.opencodeSessionId)
      const res = await opencodeFetch(`/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(nudgeBody),
        timeoutMs: 10000,
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      cur.turnAborted = false
      cur.turnAbortSource = undefined // 續跑同輪：中止來源隨中止狀態一併清（下一輪／下一次中止重設）
      cur.idleSteps = 0
      cur.stepOpen = false
      cur.stepHasTool = false
      cur.stepHasText = false
      cur.stepHasReasoning = false
      cur.turnTextChars = 0
      cur.turnToolStarted = false
      cur.lastTurnActiveAt = Date.now()
      stripStaleTurnTextFromReplay(cur)
      armWatchdogTimer(cur)
      console.log(`[gateway] idle-step breaker: nudge resend dispatched — session=${cur.sessionId}`)
    } catch (e) {
      console.error(`[gateway] idle-step breaker: nudge resend failed:`, e)
      cur.turnAborted = false
      cur.turnAbortSource = undefined
      emitToSession(cur, "turn.done", {})
    }
  }, TURN_RETRY_DELAY_MS)
}
