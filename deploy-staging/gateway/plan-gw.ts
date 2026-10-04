// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：两段式首字 turn.plan（原 index.ts 890–1130 行）。
// 桥接依赖说明（仍住 index.ts 的符号）：
//  - emitToSession：index.ts 已 export，真 import。
//  - sessions / markTurnFirst / clearAckTimer：index.ts 尚未 export（2026-09-19 实锤
//    bun build 报 No matching export），以 declare 占位（第一阶段 pricing-gateway 同法，
//    bun build 只转译不查名，建得过）；index.ts 补 export 后替换为正式 import。
//  - loadAgentModelRegistry / bindingRef / AgentModelRef：原住 index.ts，Wave2
//    （2026-09-19）迁入 model-registry.ts，现为真 import。
import { readFileSync } from "node:fs"
import type { SessionState } from "./types-gateway.ts"
import { loadUserSettings } from "./persistence"
import { normalizeUserSettings } from "./sessions-http.ts"
import { TURN_PLAN_DISABLE_THINKING, TURN_PLAN_ENABLED, TURN_PLAN_MAX_CANDIDATES, TURN_PLAN_MAX_CHARS, TURN_PLAN_MAX_TOKENS, TURN_PLAN_SYSTEM_HEAD, TURN_PLAN_TIMEOUT_MS } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
//  - loadAgentModelRegistry/bindingRef/AgentModelRef：已于 Wave2（2026-09-19）迁入
//    model-registry.ts，改真 import。
import { loadAgentModelRegistry, bindingRef, type AgentModelRef } from "./model-registry.ts"
import { sessions } from "./sessions-core.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { clearAckTimer } from "./timers-gw.ts"

// ─── 两段式首字（2026-09-18）：turn.plan ────────────────────────────────
// 契约见档头常数区注释。此处只做一件事：在回合受理后立刻 fire-and-forget 打一次
// 直连 provider 的轻量调用，把「打算怎么做」的一行计画当成最早的用户可见输出。
// 全程不可阻塞主线、不可影响 promptBody、不可冒充正文、失败一律静默。

/** turn.plan 用的模型：bindings.plan_model（新增选配）→ bindings.persona[persona]
 *  → bindings.default；形状不合格一律 null（宁可不发计画，绝不猜）。
 *  刻意不走 personaModel()——它带硬编码回退，违反「不猜」原则。 */
export function planModel(state: SessionState): AgentModelRef | null {
  const reg = loadAgentModelRegistry()
  const b = reg?.bindings
  if (!b) return null
  const persona =
    normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  return bindingRef(b.plan_model) ?? bindingRef(b.persona?.[persona]) ?? bindingRef(b.default)
}

/** turn.plan 的候选链：主候选（plan_model → persona → default）＋ plan_fallbacks
 *  （选配，供本段独立策展：计画要的是「快」，主链要的是「强」，判准不同）
 *  ＋ 该 persona 的 fallbacks。去重、剔除缺 provider options 者，上限
 *  TURN_PLAN_MAX_CANDIDATES。为什么要链见该常数注释。 */
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

/** 从 agent-models.json 的 providers.<id>.options.{baseURL,apiKey} 取连线资讯。
 *  gateway 首例读 providers[].options（此前只读 bindings）→ 形状严格防呆：
 *  非字串/空值/非 http(s) 一律回 null（该回 null 就静默跳过，绝不猜端点）。
 *  apiKey 只在本函数回传值内存活，永不落 log、永不进帧。 */
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

/** 读 OpenAI 相容 SSE 串流，只取 choices[0].delta.content——reasoning_content
 *  一律丢弃（这是「首 content 1.3s」契约的前提）。攒够 maxChars 即主动取消
 *  上游串流（不为计画多烧 token）。 */
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
              // 非 JSON 行（上游注解/心跳）忽略：不影响其余行解析。
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
      // 串流已结束/已取消：无需处理。
    }
  }
  return out
}

/** 计画文字正规化：去 markdown 围栏、取「打算这么做」那行（模型有时仍会先铺一句），
 *  再截到 TURN_PLAN_MAX_CHARS。空字串 = 不可用（呼叫方据此静默跳过）。 */
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

/** 从计画文字抽出「确实出现在 digest 白名单」的 expert id。**命不中就不回，绝不编**：
 *  白名单由 `/^- ([a-z0-9-]+)（/gm` 从 digest 现场抽取（digest 是 id 真源，不另存表）；
 *  比对要求 id 前后不是 [a-z0-9-]（防 `image` 之类短 id 误命中 `image_generate`）。
 *  回传顺序 = digest 顺序（决定性）。 */
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

/** 单一候选的一次尝试：成功回计画文字，失败一律 throw（原因字串供 AggregateError
 *  汇总）。**刻意不在此处印 log**——N 条候选各印一行会把日志淹掉，失败杂讯一律由
 *  startTurnPlan 汇总成一行。 */
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
        // 完全不带 User-Agent 会被上游 403（Bun fetch 实测）——显式给一个。
        "user-agent": "image-studio-gateway/turn-plan",
        ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.modelID,
        stream: true,
        max_tokens: TURN_PLAN_MAX_TOKENS,
        // 见 TURN_PLAN_DISABLE_THINKING 注释：这一行是把首字从 2.2s 拉到 1.3s 的关键。
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

/** 两段式首字主体：fire-and-forget（void async IIFE），绝不 await、绝不挡主线。
 *  候选链并发竞速（Promise.any），取最快成功者；全数失败才印一行可 grep 的
 *  `[gateway] turn.plan skipped (<reason>)`——绝不影响主回合、绝不用罐头计画冒充。 */
export function startTurnPlan(state: SessionState, userText: string, gen: number, tAccept: number): void {
  if (!TURN_PLAN_ENABLED) return
  if (state.planState && state.planState.gen === gen) return // 本轮已发起过
  state.planState = { gen, emittedAt: null }
  void (async () => {
    try {
      const cands = planCandidates(state)
      if (cands.length === 0) {
        console.log("[gateway] turn.plan skipped (no plan model)")
        return
      }
      // digest 来源与 beast 段同一行读法（读不到仍可产计画：只是少了白名单）。
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
        // AggregateError：逐条列出「谁因为什么失败」。只印一个 http 403 正是
        // 「安静地坏掉」的来源——2026-09-18 实锤：persona 主模型当日多次 403，
        // 计画段整天零输出而日志只有一句 skipped，没人看得出是渠道死了。
        const why =
          e instanceof AggregateError
            ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join(" | ")
            : String(e)
        console.log(`[gateway] turn.plan skipped (all ${cands.length} candidates failed: ${why})`)
        return
      }
      // 让位三条件（一个都不能少）：会话已不存在 / 已进入下一轮 / 本轮已被中止。
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
      // 附加安全网（本轮加注）：本轮已收尾（turnMetrics 已收档）→ 不补发过期计画。
      // 为什么需要：逾时预算 4s（见 TURN_PLAN_TIMEOUT_MS）＋冷连线 headers 实测
      // 可达 3.2s，短 turn（实测最短 3.8s）理论上可能先收尾、计画后到，届时计画
      // 会落在答案之后。turnMetrics 在受理当下建立、turn.done/abort/superseded 收档，故
      // 「null」＝本轮已收尾。此条只会少发一个已无意义的过期计画，不会误杀在途轮。
      if (!cur.turnMetrics) return
      const experts = digest ? extractPlanExperts(plan, digest) : []
      emitToSession(cur, "turn.plan", {
        plan,
        ...(experts.length ? { experts } : {}),
        provisional: true,
        source: "model",
        model: `${model.providerID}/${model.modelID}`,
      })
      cur.planExperts = experts.length ? experts : undefined
      if (cur.planState && cur.planState.gen === gen) cur.planState.emittedAt = Date.now()
      // 让位罐头 ack：否则使用者先读到真计画、15 秒后又冒一句罐头盖掉它。
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
