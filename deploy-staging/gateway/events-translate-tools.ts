import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import type { SessionState } from "./types-gateway.ts"
import { WORKSPACE_DIR, UPLOADS_DIR, TOOL_STATUS_DEDUP_CAP } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { humanMessageFor, summarizeArgs } from "./humanize-gw.ts"
import { emitSessionError } from "./emit-helpers.ts"
import { workflowService } from "./workflow-gw.ts"
import { emitQuestionRequest } from "./questions-gw.ts"
import { maybeEnqueueLyricAlignFromTool } from "./lyric-align-hook.ts"
import { isSuccessfulWorkflowWrite } from "./canvas-write-gate.ts"
import { markDirty } from "./sessions-core.ts"
import { canvasResultNodeId } from "./canvas-cascade-state.ts"
import { boundSet, parseToolOutput, collectToolOutputMediaUrls } from "./events-translate-core.ts"
import { emitImageDone, emitVideoDone, emitAudioDone } from "./events-translate-emit.ts"
import { AUTO_CANVAS_TOOLS, readGenerateInput, autoCreateCanvasUnit, attachCanvasTask } from "./events-translate-canvas.ts"
import { bashDenyAttribution, bashDenyProvenance, appendDenyAudit } from "./events-translate-deny.ts"
import type { DenyProvenance } from "./events-translate-types.ts"
/**
 * S2a：从结构化工具输出抽失败载荷，组出三栏位错误合同
 * {code, message, human_message}。兼容三种输入形态：
 *  - 工具层 fail()：{error:{code,hint}}
 *  - gateway jsonError 透传：{error:{message,type,code}}（code 可能被工具层
 *    塞成物件——workflow_rerun 旧裂缝的实际形态）
 *  - 纯字串/无 error：fallback message。
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

/**
 * 取第一个非空字串。本机档案授权的附带栏位（root／reason）可能落在顶层或 error 内
 * （不同上游版本形状不同），统一收敛。
 */
function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string" && v.length > 0) return v
  return ""
}
/** R8-B 工单 #5：uploads 目录递归找同名文件，取 mtime 最新者。 */
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
          // stat 失败的文件跳过
        }
      }
    }
  }
  walk(UPLOADS_DIR, 0)
  return found
}

// R8-B 工单 #5：消息文本里的绝对路径 token（≥2 段，含 /tmp/daming-book.pdf 形态）。
export const ABS_PATH_RE = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g

/** R8-B 工单 #5：用户给的路径在沙箱视图（workspace）不存在但 uploads/** 有同名
 *  文件 → 返回系统注文本（拼进送模型的 message 前面）；解析不到回 null。 */
export function resolveInvisibleUploadPaths(content: string): string | null {
  const candidates = new Set(content.match(ABS_PATH_RE) ?? [])
  const notes: string[] = []
  for (const raw of candidates) {
    const p = raw.replace(/[.,;:!?)）】"'，。；：]+$/, "")
    if (p.startsWith(WORKSPACE_DIR)) continue // 沙箱视图内本来就可见
    const basename = p.split("/").pop() ?? ""
    if (!basename) continue
    const hit = findUploadsByBasename(basename)
    if (hit) notes.push(`[系统] 路径 ${p} 执行环境不可见，同名文件已解析到 ${hit}，后续操作请使用解析后的路径`)
  }
  return notes.length > 0 ? notes.join("\n") : null
}

/** R4-A S10：被拒操作的可读标签——bash 取命令前缀（截 80 字符），其他工具取工具名。 */
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

/** R4-A S8：采集本 turn 内到达终态的节点（emitToSession 中央出口调用）。 */
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

/** 修 4（2026-09-01）：workflow_start 载荷形状示例。opencode 工具层把 gateway
 *  400 丢成裸「tool failed」，模型只能拿用户的币和时间盲猜形状（实测连错 2 张
 *  失败卡才中）。从模板注册表取该模板 text role 的真实栏位，回一段可照抄的
 *  紧凑 JSON 示例；注册表不可得时用 single_video 的 canonical 形状兜底。 */
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
      // 注册表不可得：走通用示例兜底
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

  // R2-A 看门狗：工具真实开跑 = turn 已启动，喂狗。（question 工具的
  // pending 也要算——它在等用户回答，turn 显然活著。）
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
    // 只在拿到工具输入后才发 invoke。opencode 的 pending 状态常只有
    // {status:"pending"} 而没有 input；等 running（input 完整）再发，
    // 前端工具卡才显示得出「在做什么」，不是黑盒。
    const argsSummary = summarizeArgs(st.input)
    if (state.toolInvokeSeen.has(callId)) return
    if (!argsSummary && status === "pending") return
    state.toolInvokeSeen.add(callId)
    boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
    emitToSession(state, "tool.invoke", {
      tool: toolName,
      args_summary: argsSummary,
    })
    // 自动制画布：image_* 工具首次建立画布单元。deepseek 完全不知道——
    // 它只是提交请求，gateway 拦截参数自动建文本/配置/图片节点。
    if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId) && st.input != null) {
      void autoCreateCanvasUnit(state, toolName, st.input, callId)
    }
  } else if (status === "completed") {
    // 若 running 阶段因 input 缺失没发过 invoke，这里补发一次（completed 的
    // input 一定完整），确保前端工具卡必定有说明、不黑盒。
    if (!state.toolInvokeSeen.has(callId) && st.input != null) {
      state.toolInvokeSeen.add(callId)
      boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
      emitToSession(state, "tool.invoke", {
        tool: toolName,
        args_summary: summarizeArgs(st.input),
      })
      // 同上：跑到 completed 才见到 input 的工具（理论上不会，但保险起见）。
      if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId)) {
        void autoCreateCanvasUnit(state, toolName, st.input, callId)
      }
    }
    const parsed = parseToolOutput(st.output)
    // 只认明确带 ok 栏位的结构化输出；没有 ok 栏位（原生工具文字输出）一律视为成功。
    const hasOkFlag = parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean"
    // 缺陷 A（2026-10-04 本机档案桥，真壳实锤）：未授权路径的读取**不是成功**。冻结契约下
    // gateway 对 needs_authorization 回 HTTP 200，local_files 把它包成
    // {ok:true, action_required:"authorize_local_files", root, reason, options}（授权发生在对话里）。
    // 旧码只看 bool ok ⇒ 折成 ok:true 并丢掉 action_required／options／root ⇒ 前端卡片显示
    // 「完成」（实锤：助手文字「读取被拦下了」而卡片「读取本机文件 完成」）。此处把它正规化为
    // needs_authorization，并把 code／root／reason／options 原样带进 SSE。装置桥原生
    // {ok:false,error:{code:"needs_authorization",…}} 亦收敛到同一条路。
    const parsedRecord = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    const parsedErrorRecord =
      parsedRecord && parsedRecord.error && typeof parsedRecord.error === "object"
        ? (parsedRecord.error as Record<string, unknown>)
        : null
    const authActionRequired =
      typeof parsedRecord?.action_required === "string" ? (parsedRecord.action_required as string) : ""
    const needsAuthorization =
      authActionRequired === "authorize_local_files" ||
      parsedErrorRecord?.code === "needs_authorization" ||
      parsedRecord?.code === "needs_authorization"
    const authRoot = firstNonEmptyString(parsedRecord?.root, parsedRecord?.auth_root, parsedErrorRecord?.root)
    const authReason = firstNonEmptyString(parsedRecord?.reason, parsedRecord?.auth_reason, parsedErrorRecord?.reason)
    const authOptionsRaw = parsedRecord?.options ?? parsedRecord?.auth_options ?? parsedErrorRecord?.options
    const ok = needsAuthorization ? false : hasOkFlag ? (parsed as { ok: boolean }).ok === true : true
    // 2026-10-11 修画布：记账真写穿（非 dry_run），供 session.idle 收盘硬闸。
    if (toolName === "workflow_write" && isSuccessfulWorkflowWrite(parsed, ok)) {
      state.workflowWriteSucceeded = true
      markDirty(state)
      console.log(`[gateway] canvas-write-gate: workflow_write succeeded — session=${state.sessionId}`)
    }
    // S2a（2026-08-27）：ok 语义收紧为「已执行且成功」。失败必落
    // {ok:false, error:{code,message,human_message}}——human_message 中文短句必填。
    // 旧代码非 image_ 工具无条件回 ok:true，导致 workflow_rerun_node 等失败工具
    // 在 SSE 上伪成功（评测 event 687-690 实锤）。
    const toolErr = needsAuthorization
      ? {
          code: "needs_authorization",
          message: authReason || "此路径尚未授权。",
          human_message:
            firstNonEmptyString(parsedErrorRecord?.human_message) ||
            "读取此路径需要你的授权，请选择授权范围。",
          action_required: "authorize_local_files",
          ...(authRoot ? { root: authRoot } : {}),
          ...(authReason ? { reason: authReason } : {}),
          ...(Array.isArray(authOptionsRaw) ? { options: authOptionsRaw } : {}),
        }
      : !ok
        ? toolErrorPayload(parsed, "tool failed")
        : null
    // artifact_pending：已提交、成品未到——回包给了 task_id 但还没有成品 url。
    const artifactPending =
      ok && typeof parsed?.task_id === "string" && !!parsed.task_id && !(typeof parsed?.url === "string" && parsed.url.length > 0)
    if (toolName.startsWith("image_")) {
      // 自动制画布：submit 完成后把 task_id 挂回 unit，完成事件才够关联。
      if (ok && typeof parsed?.task_id === "string" && parsed.task_id) {
        attachCanvasTask(state, callId, parsed.task_id)
      }
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        cost_coins: typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined,
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
        // 落位回灌（2026-10-02）：若这次生成被绑到模板节点，如实回报落在哪颗 tpl-node
        // （前端 tool 卡可见；模型侧由 messages-gw 的 templateLandingFact 下一回合注入）。
        ...((): Record<string, string> => {
          const uid = state.canvasUnitByCall.get(callId)
          const nodeId = uid ? canvasResultNodeId(state.sessionId, uid) : ""
          return nodeId.startsWith("tpl-") ? { tpl_landing_node_id: nodeId } : {}
        })(),
      })
      if (ok && typeof parsed?.url === "string" && parsed.url.length > 0) {
        // P1-E1：image.done 附带真实配方（prompt/model/size/lora），前端
        // 「存为资产」直接拿，不必再从 transcript 对应。
        const cfg = st.input != null ? readGenerateInput(st.input) : undefined
        void emitImageDone(state, parsed.url, parsed.cost_coins, parsed.task_id, cfg ? { prompt: cfg.prompt, model: cfg.model, size: cfg.size, lora: cfg.lora } : undefined)
      }
    } else {
      // R1（2026-09-11）刀4：非 image_ 工具的 tool.result 补回填载荷。评测实锤 10 条
      // result 全为 {tool,ok,event_id} 空壳（前端契约的 cost_coins / error.human_message
      // / summary 全部拿不到）。有成本数字就带 cost_coins（quote/generate 类）；报价类
      // 工具再带一句 summary 短文案；同步子代理 deadline 超时补 partial/reason。
      const parsedObj =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
      // 缺陷 B（2026-10-04 本机档案桥）：local_files 的 read_file 结果把装置/闸道算好的
      // binary／bytes_read／size／truncated 放在 result 内；这里原样带进 SSE，前端据此
      // 显示「这是二进制文件」并正确报「已读 X / 文件 Y 字节（已截断）」。成功判定不变
      // （仍由 ok 决定），只是把后设栏位补齐，不改其他工具语义。
      const readFileResult =
        toolName === "local_files" &&
        parsedObj?.op === "read_file" &&
        parsedObj.result !== null &&
        typeof parsedObj.result === "object"
          ? (parsedObj.result as Record<string, unknown>)
          : null
      const readBinary = readFileResult ? readFileResult.binary === true || parsedObj?.binary === true : false
      const readBytesTotal = readFileResult && typeof readFileResult.size === "number" ? readFileResult.size : undefined
      const readBytesRead = readFileResult
        ? typeof readFileResult.bytes_read === "number"
          ? readFileResult.bytes_read
          : typeof parsedObj?.bytes === "number"
            ? parsedObj.bytes
            : undefined
        : undefined
      const readTruncated = readFileResult ? parsedObj?.truncated === true : undefined
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
          // 余额查询（balance_only）没有合计：工具刻意用 total_coins=null 表达「不适用」而非 0 币。
          // 空明细求和出的 confirmed_subtotal_coins 会是 0，照旧显示就变成「已定价小计 0 币」，
          // 用户问余额却看到一句可读成报价的数字——正是该工具注释要挡的误读，故此处据余额报数。
          const balanceOnly =
            parsedObj.mode === "balance_only" ||
            (parsedObj.total_coins === null && typeof parsedObj.balance_coins === "number")
          if (balanceOnly) {
            if (typeof parsedObj.balance_coins === "number")
              bits.push(`余额 ${Math.round(parsedObj.balance_coins * 100) / 100} 币`)
          } else if (typeof parsedObj.total_coins === "number") bits.push(`合计 ${parsedObj.total_coins} 币`)
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
        // 报价类的 total_coins 是估价不是扣费：不挂 cost_coins（前端会当「已用/消耗」累加，
        // 2026-09-29 e2e 实锤「已用 614 币」而帐户只有 7 币）；金额已在 summary 里。
        ...(typeof costCoins === "number" && !/quote/i.test(toolName) ? { cost_coins: costCoins } : {}),
        ...(quoteSummary ? { summary: quoteSummary } : {}),
        ...(subagentTimeout ? { partial: true, reason: "timeout" } : {}),
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
        // 缺陷 A：授权请求的载荷原样带进 SSE（前端 needs_auth 态渲染三选一）。
        ...(needsAuthorization
          ? {
              action_required: "authorize_local_files",
              ...(authRoot ? { auth_root: authRoot } : {}),
              ...(authReason ? { auth_reason: authReason } : {}),
              ...(Array.isArray(authOptionsRaw) ? { auth_options: authOptionsRaw } : {}),
            }
          : {}),
        // 缺陷 B：二进位／截断后设栏位（前端 binary 面板与 bytes 显示）。
        ...(readFileResult
          ? {
              ...(readBinary ? { binary: true } : {}),
              ...(readBytesRead !== undefined ? { bytes_read: readBytesRead } : {}),
              ...(readBytesTotal !== undefined ? { bytes_total: readBytesTotal } : {}),
              ...(readTruncated === true ? { truncated: true } : {}),
            }
          : {}),
      })
      // 原生工具（bash 等）可能回传的是「含图片 URL 的 JSON」——例如引擎用
      // bash 呼叫 kotone-bridge 生图，输出 {text, images:[{url,...}]}。这类
      // 结果也要送 image.done，前端右侧展示框才会显示图片（否则只有泡泡文字）。
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { images?: unknown }).images)) {
        const imgs = (parsed as { images: { url?: string; width?: number; height?: number }[] }).images
        for (const im of imgs) {
          if (typeof im?.url === "string" && im.url.length > 0) {
            void emitImageDone(state, im.url)
          }
        }
      }
      // 影片／音频安全网（2026-08-31；2026-10-02 扩扫描巢状成品形状）：任何非 image_ 工具结果
      // 带平台影片／音频 URL（video_upload 回 {ok,url}、run_py 裁后上传、workflow 工具回 {url}）→
      // 发 video.done／audio.done，聊天框出卡。对称于上面的 image.done；dedup 由
      // emitVideoDone／emitAudioDone 的 announcedUrls 兜底，与 film 节点 runNode 出口不重复。
      //
      // 2026-10-02 缺口 2：真实取件工具回的是**巢状**形状，旧版只认顶层 url/video_url/audio_url
      // 与字面 videos[]/audios[]，两个都不命中——video_result_fetch 回 {jobs:[{video_url}]}、
      // last_frame_video_chain 回 {shots:[{mp4_url}]}。模型手动查到成品、把 URL 贴进文字时，
      // 网关不发卡，用户只看到泡泡里一条纯文字连结（暴君抱怨的真身）。
      // 修法＝保留原行为、只扩扫描：有界走访（深度 ≤3、节点 ≤200，防病态大 payload），
      // 逐层认候选键；判定仍只认既有副档名正则，不因工具名放宽（不猜）。
      if (parsed !== null && typeof parsed === "object") {
        const media = collectToolOutputMediaUrls(parsed)
        for (const c of media.video) void emitVideoDone(state, c.url, c.cost_coins, undefined, "video")
        for (const c of media.audio) void emitAudioDone(state, c.url, c.cost_coins, undefined, "audio", { title: c.title, cover: c.cover })
        // 出曲后自动 lyric-align（异步）：歌词来自工具入参，URL 来自出参；失败不挡播放。
        if (media.audio.length > 0) {
          maybeEnqueueLyricAlignFromTool({
            toolName,
            input: st.input,
            parsed,
            sessionId: state.sessionId,
          })
        }
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
    // 0919 断点②修复：question 工具以 aborted 收尾≠用户中止——是 orchestrator
    // 调 question 冻结 turn 时杀掉在途轮的内部中止（实锤 13:00:21 两条
    // 「已按你的要求中止本轮」冒充用户话术）。此处换中性话术；用户真中止
    // 走 /abort 端点（6516），不经此分支。
    let isQuestionFreezeAbort = false
    if (toolName === "question" && /\baborted?\b/i.test(message)) {
      isQuestionFreezeAbort = true
      message = "本回合已暂停，等待你在问题卡上选择后继续"
    }
    // 0920 暴君钦点：abort 类工具错误一律不发卡——①真用户按停：UI 收尾由
    // turn.done 表达（与 emitSessionError 的 MessageAbortedError 早退同构，09-18）；
    // ②系统自杀轮（failover 换线/idle 止损/子代理换模杀在途工具）此前经此分支
    // 弹「已按你的要求中止本轮」错误卡＝栽赃用户＋欺君。两种情况都只留日志。
    if (!isQuestionFreezeAbort && /\b(aborted?|cancel(?:led|ed) by user|interrupted by user)\b/i.test(message)) {
      console.log(`[gateway] tool abort, card suppressed (UI 收尾走 turn.done): callId=${callId} tool=${toolName} message=${message}`)
      return
    }
    // 修 4：workflow_start 的裸「tool failed」→ 带期望 schema 的可照抄报错。
    // 工具层不透传 gateway 400 body，模型此前只能盲猜载荷形状；命中条件 =
    // workflow_start + 报错无任何中文（真实中文报错如「缺少必要内容」不覆盖）。
    if (toolName === "workflow_start" && !/[\u4e00-\u9fff]/.test(message)) {
      message = workflowStartSchemaHint(st.input)
    }
    // 2026-08-22：opencode 的 deny 消息自带完整权限规则表（120+ 条 JSON），
    // 原样透传=防御清单直接送给任何用户（侦察面）。权限拦截一律换成短句。
    // R4-A S10（2026-08-28）：R4 实锤「此操作不在允许范围内，已跳过」×7 不说
    // 是哪个操作——补上被拒操作（bash 命令前缀，非 bash 工具补工具名）。
    // R8-B 工单 #2（2026-08-29）：再补命中规则（matched_pattern）与替代写法——
    // R8 实锤模型花 78s 人肉逆向 deny 表，报因后此段归零。
    let denyInfo: { pattern: string; hint: string } | null = null
    let denyProv: DenyProvenance | null = null
    if (/specified a rule which prevents|relevant rules/i.test(message)) {
      const cmd =
        st.input && typeof st.input === "object" && typeof (st.input as { command?: unknown }).command === "string"
          ? (st.input as { command: string }).command
          : ""
      denyInfo = bashDenyAttribution(cmd)
      // 需求1（2026-10-02）：结构化 provenance（向下相容，仅新增栏位）。
      denyProv = bashDenyProvenance(cmd, undefined, message)
      // 2026-10-04 W：deny 守卫固定文案一律简体（pattern 为规则 glob 原文，非文案，不译）。
      message = `此操作不在允许范围内，已跳过${deniedOperationLabel(toolName, st.input)}${
        denyInfo ? `。命中规则：${denyInfo.pattern}；替代写法：${denyInfo.hint}` : ""
      }`
      // 持久稽核：每次拒绝落一笔结构化记录。
      if (denyProv) {
        appendDenyAudit({
          ts: new Date().toISOString(),
          session_id: state.sessionId,
          call_id: callId,
          tool: toolName,
          operation: deniedOperationLabel(toolName, st.input),
          source: denyProv.source,
          pattern: denyProv.pattern,
          reason: denyProv.reason,
          hint: denyProv.hint,
        })
      }
    }
    // S2a：error 态的 tool.result 同样补齐三栏位错误合同。
    emitToSession(state, "tool.result", {
      tool: toolName,
      ok: false,
      error: {
        code: isQuestionFreezeAbort ? "question_freeze" : "tool_error",
        message,
        human_message: isQuestionFreezeAbort ? message : humanMessageFor(message),
        ...(denyInfo ? { matched_pattern: denyInfo.pattern, hint: denyInfo.hint } : {}),
        ...(denyProv ? { deny_provenance: denyProv } : {}),
      },
    })
    // question 冻结中止不是错误：不进 session.error 帧（避免 UI 红卡）、
    // 不记上游错（不是渠道故障，别误触 failover 重投）。
    if (isQuestionFreezeAbort) {
      console.log(`[gateway] question freeze abort: callId=${callId} — turn paused pending answer (no error frame)`)
      return
    }
    emitSessionError(state, "tool_error", message)
  }
}
