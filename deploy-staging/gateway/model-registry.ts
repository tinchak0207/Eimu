// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave2）：Agent model registry 單一真源
// （registry 讀取快取、persona 綁模型、provider 60s 降權、死帳戶/死模型指紋、抖動重試模型鏈）。
// 原行區間：4243–4376（含 Persona＋registry 兩段 banner；spec 原 cutting 4252 起/任務1迄 4250，
// 現場實測 handleCreateSession 迄 4240、banner 自 4243 起，以現場為準並已回報）。
// 逐行機械抽取（python），僅加 export 前綴＋本檔頭＋單行 import，其餘一字未動。
// 雷註：agentModelRegistryCache/agentModelRegistryWarned 為本檔頂層 let，僅在本檔
// loadAgentModelRegistry() 內部重新賦值；跨模組嚴禁賦值（ESM 匯出 live binding 唯讀方向），
// 外部一律經 loadAgentModelRegistry() 讀取。
import { statSync, readFileSync } from "node:fs"
import type { SessionState } from "./types-gateway.ts"
import { loadUserSettings } from "./persistence.ts"
import { normalizeUserSettings } from "./sessions-http.ts"

// Persona 綁模型（2026-08-29）：高效 → deepseek-v4-flash-vision-exp（零思考直答，快），
// 沉穩 → glm-5.3-flash（reasoningEffort=high 在 opencode.json 模型級 options 配置）。
// 每輪把 model 覆蓋塞進 promptBody（opencode prompt schema 的 model 欄位，per-message 生效，
// 實測同一 session 內兩條消息可用不同模型）。所有重試/重放路徑共用 lastPromptBody，model 隨體重放。
// max 檔不配置 = 天然禁用。opencode 1.18 的 variants 機制對 openai-compatible 渠道不透傳 options，棄用。
// Agent model registry（單一真源，2026-08-29）：/opt/agent-harness/agent-models.json
// 承載 providers + bindings（persona 主模型、跨渠道 fallbacks）。
// gen-opencode.ts 從它生成 opencode.json 的 provider/model/small_model；
// 本檔讀它決定 persona 主模型與抖動重試的 failover 鏈。按 mtime 緩存，變了才重讀。
export type AgentModelRef = { providerID: string; modelID: string }
export type AgentModelRegistry = {
  providers: Record<string, unknown>
  bindings: {
    default?: string
    small_model?: string
    /** 兩段式首字（2026-09-18）：turn.plan 專用模型（選配，缺則退回 persona/default）。 */
    plan_model?: string
    /** 兩段式首字（2026-09-18）：turn.plan 候選鏈（選配）。計畫段的判準是「快」，
     *  與主鏈的「強」不同，故允許獨立策展；缺則退回該 persona 的 fallbacks。 */
    plan_fallbacks?: string[]
    persona?: Record<string, string>
    fallbacks?: Record<string, string[]>
  }
}
export const AGENT_MODEL_REGISTRY_PATH = process.env.AGENT_MODEL_REGISTRY || "/opt/agent-harness/agent-models.json"
export let agentModelRegistryCache: { mtimeMs: number; data: AgentModelRegistry } | null = null
export let agentModelRegistryWarned = false

export function loadAgentModelRegistry(): AgentModelRegistry | null {
  try {
    const st = statSync(AGENT_MODEL_REGISTRY_PATH)
    if (agentModelRegistryCache && agentModelRegistryCache.mtimeMs === st.mtimeMs) {
      return agentModelRegistryCache.data
    }
    const data = JSON.parse(readFileSync(AGENT_MODEL_REGISTRY_PATH, "utf8")) as AgentModelRegistry
    agentModelRegistryCache = { mtimeMs: st.mtimeMs, data }
    agentModelRegistryWarned = false
    return data
  } catch (e) {
    agentModelRegistryCache = null
    if (!agentModelRegistryWarned) {
      agentModelRegistryWarned = true
      console.warn(
        `[gateway] agent model registry unavailable (${AGENT_MODEL_REGISTRY_PATH}), using hardcoded fallbacks:`,
        e instanceof Error ? e.message : e,
      )
    }
    return null
  }
}

/** "prov/model" → { providerID, modelID }；無 "/" 或格式錯返回 null。 */
export function bindingRef(ref: unknown): AgentModelRef | null {
  if (typeof ref !== "string") return null
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx === ref.length - 1 || ref.slice(idx + 1).includes("/")) return null
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
}

// registry 缺失時的安全回退（2026-08-29 原硬編碼值，與 registry 生成前恆等）。
export const PERSONA_MODEL_EFFICIENT = { providerID: "minimax-relay", modelID: "MiniMax-M3" }
export const PERSONA_MODEL_THOUGHTFUL = { providerID: "hublinuxdo", modelID: "deepseek-v4-flash" }

export function personaModel(state: SessionState): AgentModelRef {
  const persona = normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  // 黏性快路（2026-09-21 暴君裁定）：上一輪 failover 實證可用的渠道釘在本 session，
  // 直接用它，不再每輪從死主模型重跑重試鏈；persona 不符時自動繞過（尊重用戶切模式）。
  const sticky = state.stickyModel
  if (sticky && sticky.persona === persona) return { providerID: sticky.providerID, modelID: sticky.modelID }
  const fromRegistry = bindingRef(loadAgentModelRegistry()?.bindings?.persona?.[persona])
  if (fromRegistry) return fromRegistry
  // registry 缺失時的安全回退：回到原硬編碼值，行為與 2026-08-29 之前恆等。
  return persona === "thoughtful" ? PERSONA_MODEL_THOUGHTFUL : PERSONA_MODEL_EFFICIENT
}

// ---- 2026-09-13 刀1：credit/賬戶死類錯誤 → provider 60s 降權 ----
// 進程內 Map＋到期時間戳（同檔 keyCache/canonKeyCache 同款寫法），過期自動放開；
// 不跨重啟持久——重啟時事故早已翻篇，要的就是最輕的恢復。
export const PROVIDER_DEGRADE_TTL_MS = 60_000
export const providerDegradeUntil = new Map<string, number>()

export function markProviderDegraded(providerID: string, reason: string): void {
  providerDegradeUntil.set(providerID, Date.now() + PROVIDER_DEGRADE_TTL_MS)
  console.log(`[gateway] provider degraded 60s: ${providerID} — reason=${reason}`)
}

export function isProviderDegraded(providerID: string): boolean {
  const until = providerDegradeUntil.get(providerID)
  if (until === undefined) return false
  if (until <= Date.now()) {
    providerDegradeUntil.delete(providerID)
    return false
  }
  return true
}

// 確定性「賬戶死」指紋：語義對齊 humanizer「上游余额或配额不足」條目＋事故 spec
// （credit insufficient|balance=0|quota 類）。與 429/限流/過載嚴格區分——那些瞬態、
// 仍走 backoff 重投。寬匹配 `quota` 的誤傷代價只是跳過退避換一家（60s 後放開），
// 遠低於漏判真賬戶死導致整 turn backoff 重投 2–3 次（09-13 b-ai 事故實錘）。
// 0919：補 shuai 預扣費閘方言「预扣费额度失败」（video-director 試產事故實錘：
// 該錯誤此前不命中 → deadAccount=false → 欠費渠道被退避重投繼續鞭死）。
export const DEAD_ACCOUNT_ERROR_RE =
  /credit[ _-]?insufficient|insufficient[ _-]?(account[ _-]?)?(balance|credit|quota)|balance\s*[=:]\s*0\b|\bquota\b|余额不足|欠费|预扣费额度失败/i

export function isDeadAccountError(msg: string | null | undefined): boolean {
  return DEAD_ACCOUNT_ERROR_RE.test(msg ?? "")
}

// 修復4（2026-09-19）：確定性「死模型」指紋（渠道清單裡沒有該模型）。與死帳戶
// 的語義區分【刻意只做零退避、不降權 provider】：死帳戶死的是 provider 整體
//（欠費，同 provider 所有模型都死）→ markProviderDegraded 正確；死模型死的是
// 單一 modelID（事故實錘：hublinuxdo 上 cn:deepseek-v4.1-flash 死而同 provider
// 的 deepseek 活）→ 降權整個 provider 會誤傷同家活模型，禁止接到降權路徑。
export const DEAD_MODEL_ERROR_RE = /model not found|no channel candidates remain/i

/** 死模型：跳過 1500ms backoff 立即換鏈下一個（重試仍受 TURN_MAX_RETRIES 約束）。 */
export function isDeadModelError(msg: string | null | undefined): boolean {
  return DEAD_MODEL_ERROR_RE.test(msg ?? "")
}

/** 抖動重試第 attempt 次應用的模型：鏈 = [主模型, ...registry fallbacks（跨渠道）]，
 *  去重後取模回捲（2026-09-13 刀2：primary 與 fallback 同值不佔兩格）；
 *  刀1：60s 降權中的 provider 跳過，全降權時退回全鏈（總比沒得重試強）。 */
export function personaModelForAttempt(state: SessionState, attempt: number): AgentModelRef {
  const primary = personaModel(state)
  const persona = normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  const fallbacks = (loadAgentModelRegistry()?.bindings?.fallbacks?.[persona] ?? [])
    .map(bindingRef)
    .filter((r): r is AgentModelRef => r !== null)
  const chain: AgentModelRef[] = []
  for (const ref of [primary, ...fallbacks]) {
    if (!chain.some((c) => c.providerID === ref.providerID && c.modelID === ref.modelID)) chain.push(ref)
  }
  const usable = chain.filter((c) => !isProviderDegraded(c.providerID))
  const pool = usable.length > 0 ? usable : chain
  return pool[(attempt - 1) % pool.length] ?? pool[0] ?? primary
}

// ---- 2026-10-02 視覺能力判定：圖能不能直接進模型上下文 ----
// 產品負責人逐字確認可看圖的模型（用 modelID 比對，不分 provider：同一 modelID 在哪家渠道
// 都假設同能力）。白名單外的模型一律當「不能直接看圖」處理——寧可走 vision_analyze 文字描述，
// 也不把圖塞進會失敗的請求。
export const VISION_MODEL_IDS = new Set(["deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3"])

/**
 * 該模型能否直接接收圖像輸入（image/* content block）。
 * 兩條來源，任一命中即真：
 *  ① VISION_MODEL_IDS 硬編碼白名單：產品負責人確認的當下能力，改它＝產品決策。
 *  ② registry（agent-models.json）`providers[providerID].models[modelID].vision === true`：
 *     以後擴充視覺模型只需改 JSON，不用改碼。
 * 為何保留硬編碼（呼應 runbook「硬編碼＝回退默認」既有慣例）：registry 檔讀不到
 * （loadAgentModelRegistry 回 null）時仍需一組可信答案；registry 旗標是正式擴充點，
 * 硬編碼只是離線/缺檔時的退路。registry 讀取一律走既有 loadAgentModelRegistry()，不另開第二套。
 */
export function isVisionModel(ref: { providerID: string; modelID: string } | null | undefined): boolean {
  if (!ref || typeof ref.modelID !== "string" || ref.modelID.length === 0) return false
  if (VISION_MODEL_IDS.has(ref.modelID)) return true
  const providers = loadAgentModelRegistry()?.providers as
    | Record<string, { models?: Record<string, { vision?: unknown }> } | undefined>
    | undefined
  const flagged = providers?.[ref.providerID]?.models?.[ref.modelID]?.vision
  return flagged === true
}
