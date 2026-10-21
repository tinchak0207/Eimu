// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave2）：Agent model registry 单一真源
// （registry 读取快取、persona 绑模型、provider 60s 降权、死帐户/死模型指纹、抖动重试模型链）。
// 原行区间：4243–4376（含 Persona＋registry 两段 banner；spec 原 cutting 4252 起/任务1迄 4250，
// 现场实测 handleCreateSession 迄 4240、banner 自 4243 起，以现场为准并已回报）。
// 逐行机械抽取（python），仅加 export 前缀＋本档头＋单行 import，其余一字未动。
// 雷注：agentModelRegistryCache/agentModelRegistryWarned 为本档顶层 let，仅在本档
// loadAgentModelRegistry() 内部重新赋值；跨模组严禁赋值（ESM 汇出 live binding 唯读方向），
// 外部一律经 loadAgentModelRegistry() 读取。
import { statSync, readFileSync } from "node:fs"
import type { SessionState } from "./types-gateway.ts"
import { loadUserSettings } from "./persistence.ts"
import { normalizeUserSettings } from "./sessions-http.ts"

// Persona 绑模型（2026-08-29）：高效 → deepseek-v4-flash-vision-exp（零思考直答，快），
// 沉稳 → glm-5.3-flash（reasoningEffort=high 在 opencode.json 模型级 options 配置）。
// 每轮把 model 覆盖塞进 promptBody（opencode prompt schema 的 model 栏位，per-message 生效，
// 实测同一 session 内两条消息可用不同模型）。所有重试/重放路径共用 lastPromptBody，model 随体重放。
// max 档不配置 = 天然禁用。opencode 1.18 的 variants 机制对 openai-compatible 渠道不透传 options，弃用。
// Agent model registry（单一真源，2026-08-29）：/opt/agent-harness/agent-models.json
// 承载 providers + bindings（persona 主模型、跨渠道 fallbacks）。
// gen-opencode.ts 从它生成 opencode.json 的 provider/model/small_model；
// 本档读它决定 persona 主模型与抖动重试的 failover 链。按 mtime 缓存，变了才重读。
export type AgentModelRef = { providerID: string; modelID: string }
export type AgentModelRegistry = {
  providers: Record<string, unknown>
  bindings: {
    default?: string
    small_model?: string
    /** 两段式首字（2026-09-18）：turn.plan 专用模型（选配，缺则退回 persona/default）。 */
    plan_model?: string
    /** 两段式首字（2026-09-18）：turn.plan 候选链（选配）。计画段的判准是「快」，
     *  与主链的「强」不同，故允许独立策展；缺则退回该 persona 的 fallbacks。 */
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

/** "prov/model" → { providerID, modelID }；无 "/" 或格式错返回 null。 */
export function bindingRef(ref: unknown): AgentModelRef | null {
  if (typeof ref !== "string") return null
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx === ref.length - 1 || ref.slice(idx + 1).includes("/")) return null
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
}

// registry 缺失时的安全回退（2026-08-29 原硬编码值，与 registry 生成前恒等）。
export const PERSONA_MODEL_EFFICIENT = { providerID: "minimax-relay", modelID: "MiniMax-M3" }
export const PERSONA_MODEL_THOUGHTFUL = { providerID: "hublinuxdo", modelID: "deepseek-v4-flash" }

export function personaModel(state: SessionState): AgentModelRef {
  const persona = normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
  // 黏性快路（2026-09-21 暴君裁定）：上一轮 failover 实证可用的渠道钉在本 session，
  // 直接用它，不再每轮从死主模型重跑重试链；persona 不符时自动绕过（尊重用户切模式）。
  const sticky = state.stickyModel
  if (sticky && sticky.persona === persona) return { providerID: sticky.providerID, modelID: sticky.modelID }
  const fromRegistry = bindingRef(loadAgentModelRegistry()?.bindings?.persona?.[persona])
  if (fromRegistry) return fromRegistry
  // registry 缺失时的安全回退：回到原硬编码值，行为与 2026-08-29 之前恒等。
  return persona === "thoughtful" ? PERSONA_MODEL_THOUGHTFUL : PERSONA_MODEL_EFFICIENT
}

// ---- 2026-09-13 刀1：credit/账户死类错误 → provider 60s 降权 ----
// 进程内 Map＋到期时间戳（同档 keyCache/canonKeyCache 同款写法），过期自动放开；
// 不跨重启持久——重启时事故早已翻篇，要的就是最轻的恢复。
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

// 确定性「账户死」指纹：语义对齐 humanizer「上游余额或配额不足」条目＋事故 spec
// （credit insufficient|balance=0|quota 类）。与 429/限流/过载严格区分——那些瞬态、
// 仍走 backoff 重投。宽匹配 `quota` 的误伤代价只是跳过退避换一家（60s 后放开），
// 远低于漏判真账户死导致整 turn backoff 重投 2–3 次（09-13 b-ai 事故实锤）。
// 0919：补 shuai 预扣费闸方言「预扣费额度失败」（video-director 试产事故实锤：
// 该错误此前不命中 → deadAccount=false → 欠费渠道被退避重投继续鞭死）。
export const DEAD_ACCOUNT_ERROR_RE =
  /credit[ _-]?insufficient|insufficient[ _-]?(account[ _-]?)?(balance|credit|quota)|balance\s*[=:]\s*0\b|\bquota\b|余额不足|欠费|预扣费额度失败/i

export function isDeadAccountError(msg: string | null | undefined): boolean {
  return DEAD_ACCOUNT_ERROR_RE.test(msg ?? "")
}

// 修复4（2026-09-19）：确定性「死模型」指纹（渠道清单里没有该模型）。与死帐户
// 的语义区分【刻意只做零退避、不降权 provider】：死帐户死的是 provider 整体
//（欠费，同 provider 所有模型都死）→ markProviderDegraded 正确；死模型死的是
// 单一 modelID（事故实锤：hublinuxdo 上 cn:deepseek-v4.1-flash 死而同 provider
// 的 deepseek 活）→ 降权整个 provider 会误伤同家活模型，禁止接到降权路径。
export const DEAD_MODEL_ERROR_RE = /model not found|no channel candidates remain/i

/** 死模型：跳过 1500ms backoff 立即换链下一个（重试仍受 TURN_MAX_RETRIES 约束）。 */
export function isDeadModelError(msg: string | null | undefined): boolean {
  return DEAD_MODEL_ERROR_RE.test(msg ?? "")
}

/** 抖动重试第 attempt 次应用的模型：链 = [主模型, ...registry fallbacks（跨渠道）]，
 *  去重后取模回卷（2026-09-13 刀2：primary 与 fallback 同值不占两格）；
 *  刀1：60s 降权中的 provider 跳过，全降权时退回全链（总比没得重试强）。 */
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

// ---- 2026-10-02 视觉能力判定：图能不能直接进模型上下文 ----
// 产品负责人逐字确认可看图的模型（用 modelID 比对，不分 provider：同一 modelID 在哪家渠道
// 都假设同能力）。白名单外的模型一律当「不能直接看图」处理——宁可走 vision_analyze 文字描述，
// 也不把图塞进会失败的请求。
export const VISION_MODEL_IDS = new Set(["deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3"])

/**
 * 该模型能否直接接收图像输入（image/* content block）。
 * 两条来源，任一命中即真：
 *  ① VISION_MODEL_IDS 硬编码白名单：产品负责人确认的当下能力，改它＝产品决策。
 *  ② registry（agent-models.json）`providers[providerID].models[modelID].vision === true`：
 *     以后扩充视觉模型只需改 JSON，不用改码。
 * 为何保留硬编码（呼应 runbook「硬编码＝回退默认」既有惯例）：registry 档读不到
 * （loadAgentModelRegistry 回 null）时仍需一组可信答案；registry 旗标是正式扩充点，
 * 硬编码只是离线/缺档时的退路。registry 读取一律走既有 loadAgentModelRegistry()，不另开第二套。
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
