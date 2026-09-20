// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave2）：0918 前綴快取尾端注入
// （TAIL_PAYLOAD_MARKER/appendSystemPayloadToTurnTail）、handleSendMessage 全函數
// （vetting/memory/persona/beast 注入、compaction 閘、watchdog 佈哨）、滾動摘要壓縮
// （SESSION_COMPACT_*/compactionJobs/maybeCompactSession）（原 index.ts 4594–5143 行）。
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { loadUserSettings } from "./persistence"
import { gateUserInput, classifyDispatchMeta } from "./jev-gate"
// 0920：首條訊息即建模板骨架（不等模型思考/不等 Expert）——見下方 PROMPT_SKELETON。
import { workflowService, workflowOwnerBySession } from "./workflow-gw.ts"
import { templatePlaceholderContent } from "./workflow-templates"
import { jsonError } from "./gw-lib.ts"
import { SYSTEM_PAYLOAD_TAIL_DEDUPE, MEMORY_SHARED_ENABLED } from "./constants-gateway.ts"
import { sessions, markDirty, getOwnedSession } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { normalizeUserSettings, PROFILE_ONBOARDING_DIRECTIVE } from "./sessions-http.ts"
import { opencodeFetch } from "./opencode-client.ts"
import { startTurnPlan } from "./plan-gw.ts"
import { beginTurnMetrics, noteTurnDeferred, noteTurnPromptDispatch } from "./metrics-gw.ts"
import type { SessionState } from "./types-gateway.ts"
import { resolveInvisibleUploadPaths } from "./events-translate.ts"
import { settleQuestion } from "./questions-gw.ts"
import { clearQuestionHeartbeat, armAckTimer, armHeartbeatTimer, armWatchdogTimer, clearErrorStallTimer } from "./timers-gw.ts"
import { buildMemoryInjectionBlocks, ensureMemoryTrace, appendMemoryRecallTrace, takeMemoryRecallPrefix, scheduleMemoryRecallPrefetch } from "./memory-wiring.ts"
import { personaModel } from "./model-registry.ts"
// TODO(整合)：以下符號仍住 index.ts 且未 export（本任務禁改 index.ts；bun build 對未 export
// 的 named import 報錯，已實測 2026-09-19）。依第一階段佔位符法（記憶
// gateway-index-refactor-stage1-0919）：declare 佔位可過 bun build；整合 subagent 統一換真 import。
// TODO(index.ts:3229) resolveInvisibleUploadPaths
// TODO(index.ts:5406) settleQuestion
// TODO(index.ts:5985) clearQuestionHeartbeat
// TODO(index.ts:5835) armAckTimer
// TODO(index.ts:5866) armHeartbeatTimer
// TODO(index.ts:6148) armWatchdogTimer
// TODO(index.ts:6238) clearErrorStallTimer
// TODO(index.ts:6902) buildMemoryInjectionBlocks
// TODO(index.ts:6961) ensureMemoryTrace
// TODO(index.ts:6974) appendMemoryRecallTrace
// TODO(index.ts:7041) takeMemoryRecallPrefix（MemoryRecallPrefetchEntry 仍住 index.ts:7027，此處結構等價）
// TODO(index.ts:7051) scheduleMemoryRecallPrefetch
// TODO(model-registry.ts W9 在建；現住 index.ts:4306) personaModel（AgentModelRef 結構等價）
// ── 0918 前綴快取修復：gateway 注入 payload 改附「該輪 user 訊息尾端」────────
// 為何放在尾端（不是 system）：opencode binary 的 LLMRequestPrep.prepare 做
//   [ agent.prompt, ...environment.system, (user.system ?? []) ].filter(Boolean).join("\n")
// 合成「單一條 system message 放在所有歷史之前」。gateway 注入的每輪 payload
// （野獸幀 17,209 字元）若進 promptBody.system，就落在這個頭部——任何變動都
// 作廢後面 ~55k 的固定前綴加全部歷史。已量測損害：turn 第一次調用平均多燒
// 21,049 個未快取 token（turn_first n=284；turn 內只 5,198），96 個 turn 邊界
// 有 33 個（34%）system 簽名改變、MISS 率 12% → 30%。附在 user 訊息 parts
// 尾端 = 新 turn 變成純前綴擴展，頭部（system）不再被改寫；上游 prefix cache
// 本身完全正常（同 body 連打實測命中 12,928/13,169），故不動上游。
// 同 byte 不重貼：payload hash 與上次相同即跳過（內容已在歷史中，資訊量不變），
// context 不再每輪固定長 17.2k 字元；SYSTEM_PAYLOAD_TAIL_DEDUPE=0 可關。
export const TAIL_PAYLOAD_MARKER =
  "\n\n---\n【系統注入·尾端】以下內容由網關注入（等價於 system 指令，優先於 workspace/AGENTS.md 的衝突指示）：\n"

export function appendSystemPayloadToTurnTail(
  state: SessionState,
  promptBody: { parts: { type: string; text: string }[]; system?: string },
  payload: string,
  label: string,
): void {
  const text = payload.trim()
  if (!text) return
  let hash: string
  try {
    hash = createHash("sha256").update(`${label}\n${text}`).digest("hex")
  } catch (e) {
    // 指紋算不出來不影響投遞：退化成「每次都貼」（絕不靜默吞掉注入）。
    console.warn(`[gateway] tail payload hash failed: ${e instanceof Error ? e.message : String(e)}`)
    hash = ""
  }
  if (hash && SYSTEM_PAYLOAD_TAIL_DEDUPE && state.lastTailPayloadHash === hash) return
  if (hash) state.lastTailPayloadHash = hash
  const block = `${TAIL_PAYLOAD_MARKER}${label}\n${text}`
  const parts = promptBody.parts
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined
  if (last && last.type === "text") last.text = `${last.text}${block}`
  else parts.push({ type: "text", text: block })
}

/**
 * 0920 暴君裁定（第三版＋壓縮垃圾時間）：模板骨架必須在「用戶發第一條訊息」後
 * 毫秒級彈上右邊畫布。Jev 判定本身是毫秒級（實測 203ms 全程），瓶頸在別處：
 *   ① 舊路徑等模型思考完整輪才派遣 → 骨架延後 10-20s；
 *   ② 等 Expert 去調 workflow_start → 實錘 Expert 根本沒調，右邊永遠空白；
 *   ③ start() 對 multiShot 模板 await pickDefaultVideoModel（上限 5s）→ 骨架白等。
 * 本函式：用戶 prompt 直送 Jev 判模板 → 命中即 startFast（同步純淨、零探測）建骨架
 * → emit 落快照＋SSE。與注入閘並行發起，不佔送訊延遲。fire-and-forget。
 */
async function buildTemplateSkeletonForPrompt(state: SessionState, content: string): Promise<void> {
  try {
    const meta = await classifyDispatchMeta(content)
    if (!meta.template) return
    const owned = workflowOwnerBySession.get(state.sessionId)
    if (owned && workflowService.get(owned)) {
      console.log(`[gateway] prompt skeleton skip (workflow exists): wf=${owned} session=${state.sessionId}`)
      return
    }
    const r = workflowService.startFast(
      meta.template.templateId,
      templatePlaceholderContent(meta.template.templateId) as never,
      state,
    )
    if ("workflowId" in r && typeof r.workflowId === "string") {
      workflowOwnerBySession.set(state.sessionId, r.workflowId)
      console.log(
        `[gateway] jev_gate: PROMPT_SKELETON built template=${meta.template.templateId} confidence=${meta.template.confidence.toFixed(2)} wf=${r.workflowId} session=${state.sessionId} (首條訊息即彈)`,
      )
    } else {
      console.log(`[gateway] prompt skeleton skipped: ${"error" in r ? r.error : "unknown"}`)
    }
  } catch (e) {
    console.log(`[gateway] prompt skeleton build failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function handleSendMessage(key: string, id: string, req: Request): Promise<Response> {
  // Phase 0 觀測：t_accept 起點（函數進入時刻；計時檔在 turnGen 遞增處建立）。
  const tAcceptAt = Date.now()
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { content?: string; canvas_state?: unknown; session_directive?: string }
  try {
    body = (await req.json()) as { content?: string; canvas_state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) return jsonError(400, "content is required", "bad_request", "bad_request")
  // R9-2（2026-08-30）：question 卡 pending 時用戶直接發新消息 —— opencode 當前
  // turn 卡在 question tool call 上，新 prompt 排隊等 turn 結束，而 question 永遠
  // 等不到回答 → 會話掛死（smoke 實錘 14 分鐘零推進）。進入 turn 流程前先用
  // 「跳過」語義 settle 全部 pending questions，解放 turn，再走正常新消息流程。
  // 每個 settle 帶 try/catch：單個失敗不擋其餘、不擋新消息。confirm 語義是花錢
  // 決策，不能替用戶決定，pendingConfirms 不在此處動。
  if (state.pendingQuestions.size > 0) {
    const skipCount = state.pendingQuestions.size
    for (const requestId of [...state.pendingQuestions.keys()]) {
      try {
        await settleQuestion(state, requestId)
      } catch (err) {
        console.error(`[gateway] auto-settle question failed: ${requestId} — session=${state.sessionId}:`, err)
      }
    }
    state.pendingQuestions.clear()
    clearQuestionHeartbeat(state)
    console.log(`[session] auto-skipped ${skipCount} pending question(s) on new user message`)
  }
  // R8-B 工單 #5（2026-08-29）：用戶給的絕對路徑在沙箱視圖（workspace）不可見、
  // 但 uploads/** 有同名文件時，生成系統注拼在 message 前面（R8 實錘：
  // /tmp/daming-book.pdf 靜默失效 25 分鐘 + 2 次 find 燒往返）。
  const pathNote = resolveInvisibleUploadPaths(content)
  // 前端附帶的畫布摘要：存入 session，供 canvas_summary 工具讀取。
  // 同一 session 的畫布狀態隨每次新訊息更新；摘要本身不進 opencode 歷史，
  // 避免 token 膨脹——agent 需要時才透過工具讀。
  if (body.canvas_state !== undefined) {
    state.canvasSummary = body.canvas_state
    state.canvasSummaryAt = Date.now()
    markDirty(state) // 畫布摘要持久化：重啟後 canvas 工具仍讀得到
  }
  // prompt_async returns 204 immediately and the reply arrives over the /event
  // SSE stream. POST /session/:id/message is SYNCHRONOUS — it blocks until the
  // model finishes (30s+), which blew the 10s timeout and made this handler
  // return 502 even though the agent had actually run.
  // 首次訊息時夾帶 system 欄位注入「意圖審查」政策：要求 agent 對用戶意圖
  // 信度不足時先反覆驗證、主動用 question 工具澄清，不可擅自揣測意圖產出。
  // system 欄位會記入 opencode user message 的 info.system，實際影響模型輸出。
  const promptBody: { parts: { type: string; text: string }[]; system?: string; model?: { providerID: string; modelID: string }; agent?: string } = {
    parts: [{ type: "text", text: pathNote ? `${pathNote}\n\n${content}` : content }],
  }
  // 刀2A（2026-09-19）：用戶輸入越獄/注入閘（權威）。便宜前置過濾＋單次 Jev 呼叫
  // （≤2s，僅可疑輸入付此延遲）；任一題 noul>0.8 → 400 拒絕（防越獄不是 LLM 的
  // 決策，AGENTS.md §7 的機器化前置層）。掃描器故障 → 放行（fail-open＝現狀）。
  // 0920 壓縮垃圾時間：模板骨架判定與注入閘**並行**發起（兩者都是對同一條用戶
  // prompt 的獨立 Jev 呼叫，加題不加延遲；串行會讓骨架白等閘門的 2s 預算）。
  const beastOn = loadUserSettings(key)?.beast_mode === true
  const skeletonTask = beastOn ? buildTemplateSkeletonForPrompt(state, content) : Promise.resolve()
  if (await gateUserInput(`user:${state.sessionId}`, content)) {
    return jsonError(400, "该请求包含无法执行的指令注入内容", "injection_blocked", "bad_request")
  }
  void skeletonTask
  // ── 契約 §4/§7 每回合召回前綴（2026-09-15 PRD P0-4）─────────────────────
  // 取上一回合 session.idle 預算好的候選（用戶路徑零新增延遲）；miss 則本回合
  // 不注入、順手排一次異步補算（此刻 lastUserMessage/turnAssistantHead 仍是
  // 上一輪值）。前綴走 parts[0].text 不走 system——保住首回合 system 的 prompt
  // caching（PRD §6.1）。此處在 lastPromptBody 落盤之前，抖動重試重放天然含前綴。
  {
    const recall = takeMemoryRecallPrefix(state.sessionId)
    if (recall === null) {
      void scheduleMemoryRecallPrefetch(state)
    } else if (recall.prefix) {
      promptBody.parts[0].text = `${recall.prefix}\n\n${promptBody.parts[0].text}`
      appendMemoryRecallTrace(state, recall.docRefs)
    }
  }
  // 2026-08-25 模板隱形注入：站點隨訊息上送 session_directive（點模板卡產生）。
  // 存進 state：抖動重試 lastPromptBody 重放時 directive 已在 system 裡；注入後棄置。
  if (typeof body.session_directive === "string" && body.session_directive.trim().length > 0) {
    state.sessionDirective = body.session_directive.slice(0, 4000)
  }
  if (!state.vettingInjected) {
        const vettingLines = [
      "這是圖像影片製作助手。用戶可能描述不清楚，但與其反覆追問，不如先拿出可反饋的產出。",
      "執行原則：",
      "1. 先開工：先給出初步方案（大綱/骨架/場次表/分鏡框架），讓用戶有具體東西可看、可改。",
      "2. 只在最關鍵參數完全缺失（如尺寸/主體/數量/風格全無且無合理默認）時，才用 question 工具確認；一次只問一個最要緊的問題，不要一次問多道。",
      "3. 已問過的問題不要重複問：用戶答過就按答案走，除非新證據推翻。",
      "4. 執行中若發現與用戶描述衝突，停下來確認，不要自己硬接。",
    ].join("\n")
    // L0 账户级记忆：首条消息带上用户画像 + 教训，模型开聊就认识用户。
    // 契約 §4（2026-09-15 PRD P0-4）：L0 = 既有 profile/lessons + memory_docs，
    // 2400 字元硬上限；L1 共享目錄 = memory_index_md，800 字元（MEMORY_SHARED_ENABLED
    // 為 false 時零注入）；字符預算 assert 與 trace 記錄在 buildMemoryInjectionBlocks 內。
    const memory = buildMemoryInjectionBlocks(state.userMemory, MEMORY_SHARED_ENABLED)
    const memoryLines = memory.lines
    if (memoryLines.length > 0) {
      const trace = ensureMemoryTrace(state)
      trace.private_docs = memory.trace.private_docs
      trace.shared_index_chars = memory.trace.shared_index_chars
      trace.injected_at = new Date().toISOString()
    }
    const onboardingLines = state.profileOnboardingPending ? [PROFILE_ONBOARDING_DIRECTIVE] : []
    // 模板引導：一次性注入（directiveInjected 防重複），不佔用戶視野。
    const directiveLines = state.sessionDirective && !state.directiveInjected ? [state.sessionDirective] : []
    promptBody.system = [vettingLines, ...(memoryLines.length > 0 ? memoryLines : []), ...onboardingLines, ...directiveLines].join("\n\n")
    if (directiveLines.length > 0) state.directiveInjected = true
    state.vettingInjected = true
    markDirty(state) // 注入標記持久化：重啟後不重複注入 system（避免 token 膨脹）
  }
  // S7：persona/cost_mode 指令每輪注入（不是只首輪）——settings 是用戶級偏好，
  // 每條 prompt 投遞都要生效；抖動重試 lastPromptBody 重放時已含本輪指令。
  // balanced 不注入成本線（默認行為，不造假約束）。
  {
    const userSettings = normalizeUserSettings(loadUserSettings(key))
    promptBody.model = personaModel(state)
    const adaptLines: string[] = [
      userSettings.persona === "thoughtful"
        ? "【回复风格】沉稳模式：先充分推理再行动，重要决定前给完整分析；宁可多想一步，不要抢答。"
        : "【回复风格】高效模式：结论先行、直接执行，思考保持精简，不铺陈过程。",
    ]
    if (userSettings.cost_mode === "economy") {
      adaptLines.push("【成本纪律】经济模式：默认单图低成本方案，禁止自动放大（upscale）与多候选并跑，能少花钱就少花钱。")
    } else if (userSettings.cost_mode === "premium") {
      adaptLines.push("【成本纪律】高质模式：允许 2-4 候选对比、允许高清放大，优先质量，花销由确认卡把关。")
    }
    if (userSettings.interaction_mode === "auto") {
      adaptLines.push("【互动模式】自动模式：完全自主推进，从理解需求到出图/出片一轮做完，用户通常只需发一条消息。分镜、剧情、构图、工作流参数全部自己决定，不要征询确认；不要调用 question 工具提问，不要等待任何扣费确认（系统会自动放行扣费确认卡）；仅当完全无法理解用户意图时才允许提问。")
    } else if (userSettings.interaction_mode === "preset") {
      adaptLines.push("【互动模式】预设模式：少问多干。先制定完整工作流计划，然后一次性整包请求授权（合并为一次扣费确认，不要把计划拆成多笔分散确认）；扣费与关键原则性决策仍须用户批准，但把要问的问题集中到尽量少的轮次一次性问完。")
    }
    // collaborate = 现状行为，不注入。
    promptBody.system = [promptBody.system, ...adaptLines].filter(Boolean).join("\n\n")
    // ── 野獸模式（MOE 改革，2026-09-08）：Orchestrator 派工協議注入 ──────────
    // settings.beast_mode（布林，缺=false）ON 時：把派遣手冊全文＋Expert 註冊表
    // 摘要（靜態檔 gateway/expert/registry-digest.txt，本地 buildExpertRegistryDigest
    // 生成上傳）注入主 agent system prompt，Orchestrator 從全能工匠變導演
    // （定位目標/寫 spec/派遣/收結果/驗收，本體不內聯動手）。手冊檔不可讀/空檔
    // 時結構化報錯拒絕裸奔（假 ON = 誠實鐵律禁止）。OFF 或缺欄：一個字不多。
    // 註冊表摘要聲明「能力斷路」：域外工具不存在於該 Expert 的工具表（現階段
    // gateway 無 per-subagent 工具白名單掛點，物理斷路留樁，先靠 prompt 約束）。
    {
      const beastMode = loadUserSettings(key)?.beast_mode === true
      if (beastMode === true) {
        let playbook = ""
        let digest = ""
        let frameError = ""
        try {
          playbook = readFileSync(`${import.meta.dir}/expert/orchestrator-dispatch-playbook.md`, "utf8")
          digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
        } catch (e) {
          frameError = e instanceof Error ? e.message : String(e)
        }
        // R7（2026-09-10）：剝離檔頭開發者元數據（HTML 註釋 version/source/gate）
        // ——gate 聲明原樣進 prompt 會讓模型反推「無處聲明當前 BEAST_MODE=ON」→
        // 合理懷疑 gate 未滿足 → 走保守路徑（09-10 暴君實測思維鏈實錘）。剝後
        // 空檔同樣視為不可用（拒裸奔）。當前狀態聲明由 gateway 動態生成，不進檔案。
        const stripProvenanceHeader = (text: string): string =>
          text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart()
        const playbookBody = stripProvenanceHeader(playbook).trimEnd()
        const digestBody = stripProvenanceHeader(digest).trimEnd()
        // R8 修復片2（2026-09-10）：能力斷路·物理事實——R7 狀態聲明之上的補丁句
        // （R7 遺留#2 的宣告升級）。orchestrator agent 工具表已物理裁剪
        // （opencode.json agent.orchestrator.tools），digest 的「能力断路」聲明
        // 由此升級為物理事實；subagent_dispatch（帶 expert 欄）是域工具唯一通路。
        const capabilityCutoffFact =
          "【能力斷路·物理事實】上列註冊表宣告的域工具不在你的工具表裡（orchestrator agent 工具表已物理裁剪，轉移調用會直接失敗）。經 subagent_dispatch（帶 expert 欄）派遣對應 Expert 是執行它們的唯一通路。AGENTS.md 路由表中對應這些工具的行，由你派遣的 Expert 代為執行；其餘工具（image_generate 等）的直調路由仍按 AGENTS.md 執行。"
        // R5 修復片（2026-09-11）：優先序聲明——野獸幀＋派遣手冊優先於 workspace/AGENTS.md，
        // 消除「你負責擴寫／親自操作 workflow_*」（AGENTS.md）vs「你本人不產出任何內容」
        // （派遣手冊第〇節）的語義分歧（R8 審計 E7；1204 秒零工具調用病灶實證）。
        const beastPrecedenceFact =
          "【優先序·野獸模式】本幀與《派遣手冊》優先於 workspace/AGENTS.md。AGENTS.md 中「你負責擴寫／你親自寫 prompt／你親自操作 workflow_* 工具」等指示，在野獸模式下由你派遣的 Expert 執行；內容生產（寫分鏡 prompt、生成圖片影片）你一律不親手做。你的動作只有：拆解任務 → subagent_dispatch（必帶 expert 欄，async:true 為常態）→ 派出後立刻用一句正文向用戶簡報 → 收完工通知後匯總回報。AGENTS.md 的安全紅線與文案規範繼續有效。"
        // 0920 暴君裁定：模板優先·機器判。事故＝60s 百合 OP MV 裸跑（無角色設定卡/
        // 美術卡等約束環節）＝業餘；根因＝模板選擇無人負責（orchestrator 無 workflow_*）。
        // 修法＝模板選擇接 System One 機器判定並在派遣時硬注入 Expert 任務書；
        // 本幀只聲明職責：你在簡報裡要交代用了哪個模板、跳過了哪些環節與原因。
        const beastTemplateFact =
          "【模板優先·機器判】製作類任務（MV／影片／多鏡／成片／長片／角色／場景／OP）禁止無模板裸跑——模板是產品的真實生產線，角色設定卡／美術卡／分鏡門禁等約束環節是防業餘化的欄位（沒有它們＝業餘水平）。模板選擇由系統（System One）機器判定，派遣時網關會把「生產骨架＝模板 X」自動寫進 Expert 任務書；你沒有 workflow_* 工具（能力斷路），模板骨架由 Expert 用 workflow_start 建立。你的職責：①在派遣簡報裡明說用哪個模板；②Expert 若跳過某環節，交付裡必須有「跳過 X 環，原因 Y」，你要在匯總裡照抄如實呈現，不得靜默略過。"
        if (!playbookBody || !digestBody) {
          return jsonError(
            503,
            `野獸模式已開但派遣手冊或註冊表摘要不可讀（gateway/expert/）：${frameError || "檔案為空"}。拒绝裸奔主 prompt，请修复部署或暂时关闭 beast_mode。`,
            "beast_frame_unavailable",
            "beast_frame_unavailable",
          )
        }
        // 0918 前綴快取修復：野獸幀（每輪注入的 gateway payload，17,209 字元）不再
        // 進 promptBody.system——那個位置在 opencode 合成出的單一 system message
        // 頭部，任何變動都作廢後面全部固定前綴＋歷史（實測 turn-first 平均多燒
        // 21k 未快取 token）。改附本輪 user 訊息尾端：新 turn 純前綴擴展。
        // 一次性注入（vetting/memory/onboarding/directive）與 adaptLines 仍留
        // system 不動（內容不變，只換位置；同 byte 不重貼見 helper）。
        const beastFrame = [
          "【野獸模式：已啟用】以下派遣手冊與 Expert 註冊表由系統注入，這是當前系統的真實狀態：BEAST_MODE 現在就是 ON，以下全部條款立即生效，無需質疑、無需再確認任何 gate 條件。",
          playbookBody,
          digestBody,
          beastPrecedenceFact,
          capabilityCutoffFact,
          beastTemplateFact,
          "---",
        ]
          .filter(Boolean)
          .join("\n\n")
        appendSystemPayloadToTurnTail(state, promptBody, beastFrame, "【野獸模式幀·派遣手冊與 Expert 註冊表】")
        // 能力斷路：ON 輪主會話掛 orchestrator agent（域工具已從工具表物理移除，
        // playbook prompt 聲明＋工具表移除雙保險；見 opencode.json agent.orchestrator）。
        promptBody.agent = "orchestrator"
      }
    }
  }
  // R8-C（2026-08-29）：steer 打斷語義——上一輪被用戶中止後緊接的新消息，
  // 明確告知模型「被打斷、直接回應、別重複開場白」。消除同一句開場白反覆
  // 出現（用戶視角像 agent 沒記憶、原地踏步）。turnAborted 在此尚未被重置，
  // 取值即上一輪中止狀態；此 block 在 lastPromptBody 落���之前，重試會沿用。
  if (state.turnAborted) {
    promptBody.system = [
      promptBody.system,
      "【打断提示】上一轮你的执行被用户中止。直接回应这条新消息：不要重复上一轮已说过的话，不要重新开场或重新规划，即刻按要求干活。",
    ].filter(Boolean).join("\n\n")
  }
  // R2-A 根因修復（壓縮競態）：summarize 在途時 prompt_async 可能被
  // opencode 靜默丟棄——壓縮寫盤中途收到新 turn 是「turn 永不啟動」的
  // 高危窗口（評測會話三次壓縮後實錘）。壓縮在途 → 202 先回，記賬先落，
  // prompt 待壓縮落地後再投（期間用戶若發下一條，本條讓位）；計時器在
  // 實際投遞成功後才布，看門狗全程兜底。不在途 → 原路直投。
  const compactionJob = compactionJobs.get(state.sessionId)
  // 抖動重試記賬：本輪起點。零文本結束時用 lastPromptBody 重放。
  state.lastPromptBody = promptBody
  state.turnGen = (state.turnGen ?? 0) + 1
  // Phase 0 觀測：本輪計時檔起點（t_accept = 本次 handleSendMessage 進入時刻）。
  beginTurnMetrics(state, tAcceptAt)
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnAssistantHead = "" // §7 召回：本輪 assistant 正文頭部從零累積（idle prefetch 取用時恰為本輪完整頭部）
  state.criticEscapeTail = "" // 刀 2：機器 critic pass 逃生閥掃描窗（見 emitToSession）
  state.criticUnreviewedDeclared = false
  state.turnRetries = 0
  state.turnAborted = false
  state.retryQueued = false
  state.turnUpstreamError = null
  // R2-A 看門狗：本輪起點重置啟動標記，重新布哨。
  state.turnToolStarted = false
  state.watchdogRetried = false
  // 修 1：用戶主動開新輪 = 舊 turn 的死亡宣告作廢，撤回幀不該嫁接到新輪。
  state.deathDeclared = false
  // R4-A：新輪起點重置語言守門/兜底匯報/錯誤停滯旗標（S1/S3①/S8）。
  state.englishNoticeSent = false
  state.turnNoticeSent = false
  state.turnTerminalNodes = []
  state.errorStallAlerted = false
  // 修復3a：新輪起點清空本輪錯誤幀去重清單（同點重置，模式同 errorStallAlerted）。
  state.turnEmittedErrors = []
  state.turnProgressAt = Date.now()
  // R5-C：中段停滯哨起點重置 + 任意幀時間戳起點。
  state.midturnStallRetried = false
  state.recoveryRound = false
  state.turnLastFrameAt = Date.now()
  clearErrorStallTimer(state)
  state.pendingRestoreNotice = undefined // 用戶已主動發新消息，過期中斷告知不再補投
  // N1 規格3：turn 打點（持久化）——重啟後判斷「重啟前是否有 in-flight turn」
  // 的唯一依據；turn 正常結束（idle 正常路徑）時清零。
  state.lastTurnActiveAt = Date.now()
  markDirty(state)
  // P2b 刀2：本輪起點重置空轉止損（含 idleNudgeSent，新 turn 可再補一次）。
  state.idleSteps = 0
  state.stepOpen = false
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  state.idleNudgeSent = false
  // R1（2026-09-11）刀2：回合起始 ack。評測 P0：發送後 45 秒才出現第一個事件、
  // 651 秒死寂期正文 0 字。turn 起點即應一聲，用戶 5 秒內有反饋。
  emitToSession(state, "turn.status", { text: "已收到，正在解析任務…" })
  // 兩段式首字（2026-09-18）：受理當下即 fire-and-forget 打一行計畫。位置刻意在此
  // ——① 在 `if (compactionJob)` 判斷之前（被壓縮閘擋住的回合也拿得到計畫，那正是
  // 最需要它的場景）；② 在 prompt_async 之前且非阻塞（d_prompt_ms 維持 20–156ms）；
  // ③ 計畫絕不寫進 promptBody（不進模型上下文、不改 prefix cache、不影響重投）。
  startTurnPlan(state, content, state.turnGen ?? 0, tAcceptAt)
  // S6 規格3：記錄最後一條用戶消息文本與時間（質詢判定 + turn 結束時放行視頻）。
  state.lastUserMessage = content
  state.lastUserAt = Date.now()
  // R8-B 工單 #4：新輪起點重置 question 答覆標記（讓位語義只限答覆當輪）。
  state.questionAnsweredThisTurn = false
  state.turnFrozenByQuestion = false
  if (pathNote) {
    // R9-5：原始路徑解析資訊（含 /tmp/... 與 uploads/... 技術細節）只進 debug 日誌，
    // 用戶可見文字改成人話——不再把後端 raw log 當回答吐給用戶。
    console.debug(`[gateway] R9-5 path resolution: session=${state.sessionId} ${pathNote}`)
    emitToSession(state, "message.delta", { text: "（文件已找到，正在分析…）\n" })
  }
  if (compactionJob) {
    // Phase 0 觀測：在被閘擋住的這一刻起算 prompt_deferred_ms。
    noteTurnDeferred(state)
    console.log(`[gateway] prompt deferred behind compaction: session=${state.sessionId} gen=${state.turnGen}`)
    const gen = state.turnGen
    // 有界等待（2026-09-18）：舊行為是無界等 compactionJob 落地——壓縮可能 30s+
    // 才回來、甚至失敗（實測 02:28:43 擋住 → 02:29:16 該次壓縮最終 403 失敗 →
    // 使用者訊息被閘擋了 33 秒才投遞）。改為與 COMPACTION_MAX_DEFER_MS 賽跑：
    // 壓縮先落地 → 正常路徑（與原本逐字同義）；超時先到 → 逕行投遞並印可 grep 的
    // 「defer 超時，強制投遞」。超時投遞後若 opencode 靜默丟棄 prompt（壓縮競態
    // 病灶），既有的 15s ack / 90s watchdog / 零文本抖動重試兜底——**不新增重試機制**。
    const dispatchDeferred = async (forced: boolean): Promise<void> => {
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return // 用戶已發下一條，本條讓位
      if (forced) {
        console.log(
          `[gateway] compaction defer timeout (>${COMPACTION_MAX_DEFER_MS}ms), forcing prompt dispatch: session=${cur.sessionId} gen=${gen}`,
        )
      }
      try {
        const res = await opencodeFetch(`/session/${cur.opencodeSessionId}/prompt_async`, {
          method: "POST",
          body: JSON.stringify(promptBody),
          timeoutMs: 10000,
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
        console.log(`[gateway] deferred prompt dispatched: session=${cur.sessionId} gen=${gen}`)
        // Phase 0 觀測：閘後投遞成功 = t_prompt_sent（模型同本輪 promptBody）。
        noteTurnPromptDispatch(cur, promptBody.model?.providerID, promptBody.model?.modelID)
        // 修復1：turn 起點首投同樣記實際 dispatch 模型（含閘後 deferred 路徑）。
        if (promptBody.model) cur.lastDispatchedModel = { ...promptBody.model }
        armWatchdogTimer(cur)
        // S6 規格2：30s ack——實際投遞後才起算。
        armAckTimer(cur)
        // N1 規格1：心跳提示同起點布防。
        armHeartbeatTimer(cur)
      } catch (e) {
        console.error(`[gateway] deferred prompt dispatch failed: session=${cur.sessionId}:`, e)
        emitToSession(cur, "message.delta", { text: "消息投递失败（后端正忙），请稍后重发。\n" })
        // R9-4：deferred 失敗路徑同樣尊重 question 凍結，pending 期間不發 turn.done。
        if (cur.pendingQuestions.size === 0) emitToSession(cur, "turn.done", {})
      }
    }
    let deferTimer: ReturnType<typeof setTimeout> | null = null
    void Promise.race([
      // 壓縮落地（成功或失敗都算落地）→ timedOut=false。
      compactionJob.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        deferTimer = setTimeout(() => resolve(true), COMPACTION_MAX_DEFER_MS)
      }),
    ]).then((timedOut) => {
      if (deferTimer) clearTimeout(deferTimer)
      return dispatchDeferred(timedOut === true)
    })
    return Response.json({ session_id: id }, { status: 202 })
  }
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(promptBody),
      timeoutMs: 10000,
    })
    if (!res.ok) {
      return jsonError(502, `opencode send message failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  armWatchdogTimer(state)
  // S6 規格2：30s ack——模型沒開口前閘門先替它應一聲。
  armAckTimer(state)
  // N1 規格1：30s 心跳提示（與 ack 內部錯峰：ack 已發則順延到 45s）。
  armHeartbeatTimer(state)
  // Phase 0 觀測：prompt_async 回 202 = 投遞成功（provider/model 記本輪實際值）。
  noteTurnPromptDispatch(state, promptBody.model?.providerID, promptBody.model?.modelID)
  // 修復1：turn 起點首投同樣記實際 dispatch 模型（正常直投路徑）。
  if (promptBody.model) state.lastDispatchedModel = { ...promptBody.model }
  return Response.json({ session_id: id }, { status: 202 })
}

// ---- 滾動摘要壓縮（rolling summary via opencode native summarize）----
// 訊息歷史的 owner 是 opencode：壓縮直接用它的 AI compaction 端點
// POST /session/:id/summarize（已實測：生成 summary 訊息 + compaction part，
// 模型後續上下文以摘要為準；舊訊息仍留在存儲供前端展示與 GET history 端點讀取）。
// 不在 gateway 另存一份 messages —— 那是第二份會漂移的歷史副本。
// 防抖兩層：in-memory in-flight Set（一次壓縮完成前不重複觸發）+ 持久化水位
// compact.lastCount（自上次壓縮新增不足半個閾值不觸發，重啟後水位仍在）。
export const SESSION_COMPACT_THRESHOLD = Number.parseInt(process.env.SESSION_COMPACT_THRESHOLD || "40", 10) || 40
export const SESSION_COMPACT_MIN_NEW = Math.max(4, Math.floor(SESSION_COMPACT_THRESHOLD / 2))
export const SESSION_COMPACT_TIMEOUT_MS = 180_000
// 壓縮閘的有界等待上限（2026-09-18）：壓縮在途時 prompt 最多被擋這麼久，超時即
// 逕行投遞（見 handleSendMessage 的 compactionJob 分支）。env 可覆寫。
export const COMPACTION_MAX_DEFER_MS =
  Number.parseInt(process.env.COMPACTION_MAX_DEFER_MS || "4000", 10) || 4_000
// R2-A 根因修復：in-flight 從 Set 升級為可等待的 Map——handleSendMessage
// 能感知「壓縮在途」並把 prompt 投遞推遲到壓縮落地之後，消除
// 「summarize 寫盤中途收到新 turn → turn 靜默死亡」的時序競態。
export const compactionJobs = new Map<string, Promise<void>>()

export async function maybeCompactSession(state: SessionState): Promise<void> {
  if (compactionJobs.has(state.sessionId)) return
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 10_000,
    })
    if (!res.ok) return
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; model?: { providerID?: string; modelID?: string } }
    }>
    if (!Array.isArray(msgs)) return
    const count = msgs.length
    if (count < SESSION_COMPACT_THRESHOLD) return
    // 0831 競態根治：opencode binary 對摘要訊息硬擋 tool call（"Tool call not allowed
    // while generating summary"）。摘要模型若看到「還有任務待查」就會吐 tool call →
    // 整條摘要作廢、session 無聲 idle。壓縮前必須無在途生成任務。
    // 註：state.sessionTasks 在網關重啟後為空（hydrate 補空 Map）→ 在途閘自然放行，可接受。
    const inflight = [...state.sessionTasks.values()].filter(
      (t) => t.status === "queued" || t.status === "running",
    )
    if (inflight.length > 0) {
      console.log(`[gateway] compact deferred: ${state.sessionId} has ${inflight.length} in-flight task(s)`)
      return
    }
    // 2026-09-18：從源頭減少觸發——本 session 有在途 turn 或「已受理尚未投遞」的
    // prompt 時不排壓縮，留待下一個 idle 再試。判據用 turnMetrics：它在
    // handleSendMessage 受理當下建立（beginTurnMetrics，早於壓縮閘判定），
    // turn.done / abort / 被下一輪取代三條路徑收檔——故「非空」精確等於
    // 「有已受理但未收尾的 turn」，同時涵蓋被壓縮閘擋住的未投遞 prompt。
    // 理由：summarize 寫盤中途收到新 turn 會讓 opencode 靜默丟棄 prompt_async
    //（歷史實錘「turn 永不啟動」），這正是閘存在的理由；在此跳過＝不製造該競態。
    if (state.turnMetrics !== null && state.turnMetrics !== undefined) {
      console.log(`[gateway] compact deferred: ${state.sessionId} has an in-flight turn or undelivered prompt`)
      return
    }
    const lastCount = state.compact?.lastCount ?? 0
    if (count - lastCount < SESSION_COMPACT_MIN_NEW) return
    // summarize 需要 providerID+modelID：取最近一條帶 model 資訊的訊息（與該會話實際模型一致）。
    let providerID: string | undefined
    let modelID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]?.info?.model
      if (m?.providerID && m?.modelID) {
        providerID = m.providerID
        modelID = m.modelID
        break
      }
    }
    if (!providerID || !modelID) {
      console.warn(`[gateway] compact skipped: no model info in session ${state.sessionId}`)
      return
    }
    compactionJobs.set(
      state.sessionId,
      (async () => {
        const r = await opencodeFetch(`/session/${state.opencodeSessionId}/summarize`, {
          method: "POST",
          body: JSON.stringify({ providerID, modelID }),
          timeoutMs: SESSION_COMPACT_TIMEOUT_MS,
        })
        if (!r.ok) {
          console.warn(`[gateway] session compact failed: ${state.sessionId} status=${r.status}`)
          return
        }
        // 0831 假成功誠實化：/summarize 回 HTTP 200 不等於摘要成功。opencode binary 對
        // 摘要訊息硬擋 tool call，摘要模型若吐 image_get_result → 整條摘要帶 error、
        // session 無聲 idle，但 HTTP 仍 200。舊碼據 200 就推進水位 = 假成功。
        // 故 200 後再取一次訊息列表，若 summary/compaction 訊息自帶 error 即判失敗、不推進水位。
        let verifyMsgs: Array<{ info?: { summary?: boolean; mode?: string; error?: unknown } }>
        try {
          const vr = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
            timeoutMs: 10_000,
          })
          if (!vr.ok) {
            console.warn(`[gateway] session compact UNVERIFIED (status=${vr.status}), 水位不推進: ${state.sessionId}`)
            return
          }
          const vj = (await vr.json()) as Array<{ info?: { summary?: boolean; mode?: string; error?: unknown } }>
          if (!Array.isArray(vj)) {
            console.warn(`[gateway] session compact UNVERIFIED (bad payload), 水位不推進: ${state.sessionId}`)
            return
          }
          verifyMsgs = vj
        } catch (e) {
          console.warn(`[gateway] session compact UNVERIFIED (fetch error: ${e}), 水位不推進: ${state.sessionId}`)
          return
        }
        // 0918 修復：只驗「本次 summarize 新增」的訊息（.slice(count)，count =
        // 呼叫 summarize 前的訊息數，見上方 `const count = msgs.length`）。
        // 原本對整份歷史從頭 find，會撈出會話歷史上任意一條帶 error 的舊
        // summary/compaction 訊息——該會話只要失敗過一次，那條陳年訊息就永久
        // 毒化驗證：水位永不推進 → 每輪重壓縮 → 日誌永遠重印同一條舊錯誤。
        //（09-18 實錘：7 條 FAILED 的 cf-ray 全同 a3c9f9d55f8b06fc，其中 5 條
        // 時間戳與真實成功的壓縮逐秒吻合 = 假失敗，毒化會話 f4abcc5d。）
        const badSummary = verifyMsgs
          .slice(count)
          .find((m) => (m?.info?.summary === true || m?.info?.mode === "compaction") && m?.info?.error)
        if (badSummary) {
          console.warn(
            `[gateway] session compact FAILED (summary errored, 水位不推進): ${state.sessionId} err=${JSON.stringify(badSummary.info?.error)}`,
          )
          return
        }
        state.compact = { lastCount: count, at: Date.now() }
        // 0918：壓縮改寫歷史（摘要不見得保留尾端注入的 payload 正文）→ 作廢尾端
        // 去重指紋，下一輪必重貼一次 payload，避免野獸幀在壓縮後從上下文消失。
        state.lastTailPayloadHash = undefined
        markDirty(state)
        console.log(
          `[gateway] session compacted: ${state.sessionId} (${count} messages -> summary, now ${verifyMsgs.length} msgs)`,
        )
      })(),
    )
    try {
      await compactionJobs.get(state.sessionId)
    } finally {
      compactionJobs.delete(state.sessionId)
    }
  } catch (e) {
    console.warn(`[gateway] session compact error for ${state.sessionId}: ${e}`)
  }
}
