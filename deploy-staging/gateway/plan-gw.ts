// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：兩段式首字 turn.plan（原 index.ts 890–1130 行）。
// 橋接依賴說明（仍住 index.ts 的符號）：
//  - emitToSession：index.ts 已 export，真 import。
//  - sessions / markTurnFirst / clearAckTimer：index.ts 尚未 export（2026-09-19 實錘
//    bun build 報 No matching export），以 declare 佔位（第一階段 pricing-gateway 同法，
//    bun build 只轉譯不查名，建得過）；index.ts 補 export 後替換為正式 import。
//  - loadAgentModelRegistry / bindingRef / AgentModelRef：原住 index.ts，Wave2
//    （2026-09-19）遷入 model-registry.ts，現為真 import。
import { readFileSync } from "node:fs"
import type { SessionState } from "./types-gateway.ts"
import { loadUserSettings } from "./persistence"
import { normalizeUserSettings } from "./sessions-http.ts"
import { TURN_PLAN_DISABLE_THINKING, TURN_PLAN_ENABLED, TURN_PLAN_MAX_CANDIDATES, TURN_PLAN_MAX_CHARS, TURN_PLAN_MAX_TOKENS, TURN_PLAN_SYSTEM_HEAD, TURN_PLAN_TIMEOUT_MS } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
//  - loadAgentModelRegistry/bindingRef/AgentModelRef：已於 Wave2（2026-09-19）遷入
//    model-registry.ts，改真 import。
import { loadAgentModelRegistry, bindingRef, type AgentModelRef } from "./model-registry.ts"
import { sessions } from "./sessions-core.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { clearAckTimer } from "./timers-gw.ts"

// ─── 兩段式首字（2026-09-18）：turn.plan ────────────────────────────────
// 契約見檔頭常數區註釋。此處只做一件事：在回合受理後立刻 fire-and-forget 打一次
// 直連 provider 的輕量調用，把「打算怎麼做」的一行計畫當成最早的用戶可見輸出。
// 全程不可阻塞主線、不可影響 promptBody、不可冒充正文、失敗一律靜默。

/** turn.plan 用的模型：bindings.plan_model（新增選配）→ bindings.persona[persona]
 *  → bindings.default；形狀不合格一律 null（寧可不發計畫，絕不猜）。
 *  刻意不走 personaModel()——它帶硬編碼回退，違反「不猜」原則。 */
export function planModel(state: SessionState): AgentModelRef | null {
  const reg = loadAgentModelRegistry()
  const b = reg?.bindings
  if (!b) return null
  const persona =
    normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  return bindingRef(b.plan_model) ?? bindingRef(b.persona?.[persona]) ?? bindingRef(b.default)
}

/** turn.plan 的候選鏈：主候選（plan_model → persona → default）＋ plan_fallbacks
 *  （選配，供本段獨立策展：計畫要的是「快」，主鏈要的是「強」，判準不同）
 *  ＋ 該 persona 的 fallbacks。去重、剔除缺 provider options 者，上限
 *  TURN_PLAN_MAX_CANDIDATES。為什麼要鏈見該常數註釋。 */
export function planCandidates(state: SessionState): AgentModelRef[] {
  const primary = planModel(state)
  if (!primary) return []
  const b = loadAgentModelRegistry()?.bindings
  const persona =
    normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  const refs: Array<AgentModelRef | null> = [
    primary,
    ...(b?.plan_fallbacks ?? []).map((r) => bindingRef(r)),
    ...(b?.fallbacks?.[persona] ?? []).map((r) => bindingRef(r)),
  ]
  const out: AgentModelRef[] = []
  for (const ref of refs) {
    if (!ref) continue
    if (out.length >= TURN_PLAN_MAX_CANDIDATES) break
    if (out.some((x) => x.providerID === ref.providerID && x.modelID === ref.modelID)) continue
    if (!planProviderConn(ref.providerID)) continue
    out.push(ref)
  }
  return out
}

/** 從 agent-models.json 的 providers.<id>.options.{baseURL,apiKey} 取連線資訊。
 *  gateway 首例讀 providers[].options（此前只讀 bindings）→ 形狀嚴格防呆：
 *  非字串/空值/非 http(s) 一律回 null（該回 null 就靜默跳過，絕不猜端點）。
 *  apiKey 只在本函數回傳值內存活，永不落 log、永不進幀。 */
export function planProviderConn(providerID: string): { baseURL: string; apiKey: string } | null {
  const prov = loadAgentModelRegistry()?.providers?.[providerID]
  if (!prov || typeof prov !== "object") return null
  const opts = (prov as { options?: unknown }).options
  if (!opts || typeof opts !== "object") return null
  const o = opts as { baseURL?: unknown; apiKey?: unknown }
  if (typeof o.baseURL !== "string") return null
  const base = o.baseURL.replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return null
  return { baseURL: base, apiKey: typeof o.apiKey === "string" ? o.apiKey : "" }
}

/** 讀 OpenAI 相容 SSE 串流，只取 choices[0].delta.content——reasoning_content
 *  一律丟棄（這是「首 content 1.3s」契約的前提）。攢夠 maxChars 即主動取消
 *  上游串流（不為計畫多燒 token）。 */
export async function readSseContent(stream: ReadableStream<Uint8Array>, maxChars: number): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let out = ""
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl = buf.indexOf("\n")
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim()
          if (payload && payload !== "[DONE]") {
            try {
              const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
              const c = j?.choices?.[0]?.delta?.content
              if (typeof c === "string" && c) out += c
            } catch {
              // 非 JSON 行（上游註解/心跳）忽略：不影響其餘行解析。
            }
          }
        }
        nl = buf.indexOf("\n")
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 串流已結束/已取消：無需處理。
    }
  }
  return out
}

/** 計畫文字正規化：去 markdown 圍欄、取「打算这么做」那行（模型有時仍會先鋪一句），
 *  再截到 TURN_PLAN_MAX_CHARS。空字串 = 不可用（呼叫方據此靜默跳過）。 */
export function planLineFromText(raw: string): string {
  const cleaned = raw.replace(/```[a-zA-Z]*\n?/g, "\n").trim()
  if (!cleaned) return ""
  const lines = cleaned
    .split("\n")
    .map((l) => l.replace(/^[\s>*#\-]+/, "").trim())
    .filter(Boolean)
  const hit = lines.find((l) => l.startsWith("打算这么做")) ?? lines[0] ?? ""
  return hit.slice(0, TURN_PLAN_MAX_CHARS)
}

/** 從計畫文字抽出「確實出現在 digest 白名單」的 expert id。**命不中就不回，絕不編**：
 *  白名單由 `/^- ([a-z0-9-]+)（/gm` 從 digest 現場抽取（digest 是 id 真源，不另存表）；
 *  比對要求 id 前後不是 [a-z0-9-]（防 `image` 之類短 id 誤命中 `image_generate`）。
 *  回傳順序 = digest 順序（決定性）。 */
export function extractPlanExperts(plan: string, digest: string): string[] {
  const found: string[] = []
  for (const m of digest.matchAll(/^- ([a-z0-9-]+)（/gm)) {
    const id = m[1]
    if (found.includes(id)) continue
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(^|[^a-z0-9-])${esc}([^a-z0-9-]|$)`).test(plan)) found.push(id)
  }
  return found
}

/** 單一候選的一次嘗試：成功回計畫文字，失敗一律 throw（原因字串供 AggregateError
 *  匯總）。**刻意不在此處印 log**——N 條候選各印一行會把日誌淹掉，失敗雜訊一律由
 *  startTurnPlan 匯總成一行。 */
export async function planAttempt(model: AgentModelRef, userText: string, digest: string): Promise<string> {
  const conn = planProviderConn(model.providerID)
  if (!conn) throw new Error(`${model.providerID}: no provider options`)
  const ac = new AbortController()
  const killer = setTimeout(() => ac.abort(), TURN_PLAN_TIMEOUT_MS)
  try {
    const res = await fetch(`${conn.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 完全不帶 User-Agent 會被上游 403（Bun fetch 實測）——顯式給一個。
        "user-agent": "image-studio-gateway/turn-plan",
        ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.modelID,
        stream: true,
        max_tokens: TURN_PLAN_MAX_TOKENS,
        // 見 TURN_PLAN_DISABLE_THINKING 註釋：這一行是把首字從 2.2s 拉到 1.3s 的關鍵。
        ...(TURN_PLAN_DISABLE_THINKING ? { reasoning_effort: "none" } : {}),
        messages: [
          { role: "system", content: TURN_PLAN_SYSTEM_HEAD + (digest ? `Expert 注册表：\n${digest}` : "") },
          { role: "user", content: userText.slice(0, 2000) },
        ],
      }),
      signal: ac.signal,
    })
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`)
    const plan = planLineFromText(await readSseContent(res.body, TURN_PLAN_MAX_CHARS * 2))
    if (!plan) throw new Error("empty plan")
    return plan
  } catch (e) {
    const why = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e)
    throw new Error(`${model.providerID}/${model.modelID}: ${why}`)
  } finally {
    clearTimeout(killer)
  }
}

/** 兩段式首字主體：fire-and-forget（void async IIFE），絕不 await、絕不擋主線。
 *  候選鏈併發競速（Promise.any），取最快成功者；全數失敗才印一行可 grep 的
 *  `[gateway] turn.plan skipped (<reason>)`——絕不影響主回合、絕不用罐頭計畫冒充。 */
export function startTurnPlan(state: SessionState, userText: string, gen: number, tAccept: number): void {
  if (!TURN_PLAN_ENABLED) return
  if (state.planState && state.planState.gen === gen) return // 本輪已發起過
  state.planState = { gen, emittedAt: null }
  void (async () => {
    try {
      const cands = planCandidates(state)
      if (cands.length === 0) {
        console.log("[gateway] turn.plan skipped (no plan model)")
        return
      }
      // digest 來源與 beast 段同一行讀法（讀不到仍可產計畫：只是少了白名單）。
      let digest = ""
      try {
        digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
      } catch {
        digest = ""
      }
      let plan = ""
      let model = cands[0]
      try {
        const won = await Promise.any(
          cands.map(async (m) => ({ plan: await planAttempt(m, userText, digest), model: m })),
        )
        plan = won.plan
        model = won.model
      } catch (e) {
        // AggregateError：逐條列出「誰因為什麼失敗」。只印一個 http 403 正是
        // 「安靜地壞掉」的來源——2026-09-18 實錘：persona 主模型當日多次 403，
        // 計畫段整天零輸出而日誌只有一句 skipped，沒人看得出是渠道死了。
        const why =
          e instanceof AggregateError
            ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join(" | ")
            : String(e)
        console.log(`[gateway] turn.plan skipped (all ${cands.length} candidates failed: ${why})`)
        return
      }
      // 讓位三條件（一個都不能少）：會話已不存在 / 已進入下一輪 / 本輪已被中止。
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
      // 附加安全網（本輪加註）：本輪已收尾（turnMetrics 已收檔）→ 不補發過期計畫。
      // 為什麼需要：逾時預算 4s（見 TURN_PLAN_TIMEOUT_MS）＋冷連線 headers 實測
      // 可達 3.2s，短 turn（實測最短 3.8s）理論上可能先收尾、計畫後到，屆時計畫
      // 會落在答案之後。turnMetrics 在受理當下建立、turn.done/abort/superseded 收檔，故
      // 「null」＝本輪已收尾。此條只會少發一個已無意義的過期計畫，不會誤殺在途輪。
      if (!cur.turnMetrics) return
      const experts = digest ? extractPlanExperts(plan, digest) : []
      emitToSession(cur, "turn.plan", {
        plan,
        ...(experts.length ? { experts } : {}),
        provisional: true,
        source: "model",
        model: `${model.providerID}/${model.modelID}`,
      })
      if (cur.planState && cur.planState.gen === gen) cur.planState.emittedAt = Date.now()
      // 讓位罐頭 ack：否則使用者先讀到真計畫、15 秒後又冒一句罐頭蓋掉它。
      cur.ackSent = true
      clearAckTimer(cur)
      markTurnFirst(cur, "plan")
      console.log(
        `[gateway] turn.plan emitted d=${Date.now() - tAccept}ms model=${model.providerID}/${model.modelID} chars=${plan.length}`,
      )
    } catch (e) {
      console.log(`[gateway] turn.plan skipped (${e instanceof Error ? e.name : String(e)})`)
    }
  })()
}
