import { readFileSync } from "node:fs"
import { buildTemplateSlotsFact, getTemplateDeviateToken } from "./canvas-cascade-state.ts"
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
import { saveDurableSubagentRun } from "./job-store"
import { currentKernelFingerprint } from "./agent-kernel.ts"
import { renderContractDirective, DELIVERY_CONTRACTS } from "./delivery-gate"
import { WORKER_HARD_RULES, FORK_HARD_RULES, buildForkDirective, effortVariant, stripAuthorizationSection, shouldRetryWithoutVariant } from "./subagent-policy.ts"
import type { SubagentRun, ForkContext } from "./subagent-types.ts"
import { isOpenCodeSessionId } from "./subagent-types.ts"
import { deps, byChildOc, rememberChildParent } from "./subagent-runs.ts"
import { finishRun } from "./subagent-finish.ts"

/**
 * 建子会话并投递任务书（attempt = run.attempt 对应 modelChain 里的模型）。
 * 成功回 undefined；失败回可读原因（调用方决定 finishRun 还是换模重试）。
 * 注意：成功后 run.opencodeSessionId 已更新并重新注册 byChildOc。
 */
// ─────────────────────────────────────────── P0-4（2026-10-06）：本域配方库事实行
// 专家宪法第三条命令每个 Expert「进域即载配方库」，但注册表里部分域 skillPaths 为空
// （video-director / screenwriter / critic）——无条件命令会让子代理去找不存在的配方档。
// 真源＝src/lib/expert-registry.ts 的 EXPERT_REGISTRY[id].skillPaths，gateway 侧同内容的
// 生成物＝expert/registry-digest.txt 的「配方库」栏（tools/export-expert-agents.ts 机械生成；
// gateway 是独立发布单元，运行时无法 import 仓库 src/lib）。此处**从生成物派生**该栏，
// 禁手抄——旧手抄表当天即漂移（editor 的嵌套路径真身为 RECIPE.md 却写成 SKILL.md，且
// 全部 skills/… 缺 .opencode/ 前缀而指空）。读档一次、模块级缓存；只读此生成物、不猜路径。
const EXPERT_SKILL_PATHS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  try {
    const digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
    for (const line of digest.split("\n")) {
      // 摘要行：`- <id>（<label>）：任务类型 …；工具 …；配方库 <paths|未配置>；交付契约 …`
      const m = line.match(/^-\s*([^\s（(]+)（[^）]*）：(.*)$/)
      if (!m) continue
      const km = m[2].match(/；配方库\s+(.*?)(?:；交付契约|$)/)
      if (!km) continue
      const paths = km[1].trim()
      if (paths) map.set(m[1], paths)
    }
    if (map.size === 0) {
      console.warn("[gateway] buildExpertSkillFact: expert/registry-digest.txt 已读但未解析出任何「配方库」栏，本域配方库事实行全部零注入")
    }
  } catch (e) {
    console.warn(
      `[gateway] buildExpertSkillFact: 读 expert/registry-digest.txt 失败（${e instanceof Error ? e.message : String(e)}），本域配方库事实行全部零注入（不打断派工）`,
    )
  }
  return map
})()

/**
 * 派工任务书头部的「本域配方库」事实行（P0-4）。有路径＝列出（值逐字来自 digest 生成物）
 * 并声明进域即载、常驻；digest 记「未配置」＝明写本域无配方库，直接用域工具，不要去找
 * 配方档；digest 无该 id／传参空／读档失败＝空串（零注入）。
 */
export function buildExpertSkillFact(agent: string | undefined): string {
  if (typeof agent !== "string" || agent.length === 0) return ""
  const paths = EXPERT_SKILL_PATHS.get(agent)
  if (paths === undefined) return ""
  if (paths === "未配置") {
    return "【本域配方库】本域无配方库（未配置）。直接用你的域工具，不要去找配方档。\n\n"
  }
  return `【本域配方库】${paths} —— 这是本域配方库，进域即载，常驻。\n\n`
}

async function resolveForkContext(source: string): Promise<ForkContext> {
  try {
    const [sessRes, msgRes] = await Promise.all([
      fetch(`${deps!.openCodeUrl}/session/${source}`, {
        headers: deps!.openCodeHeaders(),
        signal: AbortSignal.timeout(10000),
      }),
      fetch(`${deps!.openCodeUrl}/session/${source}/message`, {
        headers: deps!.openCodeHeaders(),
        signal: AbortSignal.timeout(10000),
      }),
    ])
    if (!sessRes.ok) return { ok: false, error: `父会话不可读（opencode status ${sessRes.status}）` }
    if (!msgRes.ok) return { ok: false, error: `父会话消息不可读（opencode status ${msgRes.status}）` }
    const info = (await sessRes.json().catch(() => null)) as any
    const msgs = (await msgRes.json().catch(() => null)) as any
    if (!Array.isArray(msgs) || msgs.length === 0) {
      return { ok: false, error: "父会话没有可继承的消息，无法确定 fork boundary" }
    }
    const last = msgs[msgs.length - 1]
    if (last?.info?.role !== "assistant" || typeof last.info.id !== "string" || !last.info.id) {
      return { ok: false, error: "父会话最后一条消息不是 assistant，无法确定 fork boundary" }
    }
    const boundaryMessageID: string = last.info.id
    // D4：messageID 必须在父消息列表中找到才接受（防上游返回的 id 与列表漂移）。
    if (!msgs.some((m: any) => m?.info?.id === boundaryMessageID)) {
      return { ok: false, error: "fork boundary messageID 不在父消息列表中" }
    }
    let agent: string | undefined
    let model: { providerID: string; modelID: string } | undefined
    let variant: string | undefined
    if (typeof info?.agent === "string" && info.agent) agent = info.agent
    const m = info?.model
    if (m && typeof m.providerID === "string" && typeof (m.modelID ?? m.id) === "string") {
      model = { providerID: m.providerID, modelID: m.modelID ?? m.id }
      if (typeof m.variant === "string" && m.variant) variant = m.variant
    }
    if (typeof info?.variant === "string" && info.variant) variant = variant ?? info.variant
    // 老版本 session info 不含 agent/model：从 boundary（最近一条 assistant）兜底。
    if (!agent && typeof last.info.mode === "string" && last.info.mode) agent = last.info.mode
    if (!model && typeof last.info.providerID === "string" && typeof last.info.modelID === "string") {
      model = { providerID: last.info.providerID, modelID: last.info.modelID }
    }
    if (!variant && typeof last.info.variant === "string" && last.info.variant) variant = last.info.variant
    if (!agent) return { ok: false, error: "取不到父会话 agent，fork 无法继承同一工具面，已拒绝" }
    if (!model) return { ok: false, error: "取不到父会话 model，fork 无法继承模型，已拒绝" }
    return { ok: true, boundaryMessageID, agent, model, ...(variant ? { variant } : {}) }
  } catch (e) {
    return { ok: false, error: `fork 上下文不可读（opencode 不可达：${(e as Error).message}）` }
  }
}

export async function dispatchAttempt(run: SubagentRun): Promise<string | undefined> {
  let childId: string | undefined
  let forkModel: { providerID: string; modelID: string } | undefined
  let forkAgent: string | undefined
  let forkVariant: string | undefined
  run.variantApplied = undefined
  if (run.isFork) {
    // CC 2.1.302 aYt：fork 不新建空会话，而是让 opencode 在服务端复制父会话到 boundary
    // 为止的**完整消息历史**（含 tool_use/tool_result；dev 的 projectFork 逐行复制
    // SessionMessageTable；1.18 的 fork 复制消息与 parts）。
    const source = run.forkSourceOpencodeSessionId
    if (!isOpenCodeSessionId(source)) {
      return `fork 源会话非法（非 ses 前缀：「${String(source)}」）`
    }
    const ctx = await resolveForkContext(source)
    // 用 `=== false` 而非 `!ctx.ok`：本目录 tsconfig 关掉 strictNullChecks 后，
    // 真值窄化不再区分 boolean 判别联合，显式比较保留同一判别语义。
    if (ctx.ok === false) return `fork 上下文不可用，已拒绝 fork：${ctx.error}`
    forkModel = ctx.model
    forkAgent = ctx.agent
    forkVariant = ctx.variant
    try {
      const res = await fetch(`${deps!.openCodeUrl}/session/${source}/fork`, {
        method: "POST",
        headers: deps!.openCodeHeaders(),
        body: JSON.stringify({ messageID: ctx.boundaryMessageID }),
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const data = (await res.json()) as { id?: string }
        childId = data.id
        // D3：fork 的结果/usage 只认 boundary 之后的消息；创建时刻只作 boundary 缺失兜底。
        run.forkBoundaryMessageID = ctx.boundaryMessageID
        run.forkCreatedAt = Date.now()
      } else {
        return `fork 会话创建失败（opencode status ${res.status}）`
      }
    } catch (e) {
      return `fork 会话创建失败（opencode 不可达：${(e as Error).message}）`
    }
  } else {
    try {
      // D6：把真实派工者写成 parentID（opencode Session.parentID）；opencode 不支持
      // 该栏时它会被忽略，不影响现有创建路径。
      const requesterOc = run.requesterOpencodeSessionId ?? run.parentOpencodeSessionId
      const res = await fetch(`${deps!.openCodeUrl}/session`, {
        method: "POST",
        headers: deps!.openCodeHeaders(),
        body: JSON.stringify(isOpenCodeSessionId(requesterOc) ? { parentID: requesterOc } : {}),
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const data = (await res.json()) as { id?: string }
        childId = data.id
      }
    } catch {
      childId = undefined
    }
  }
  if (!childId) return "会话创建失败（opencode 不可达）"
  // E 片（2026-09-12）缺陷二防御：opencode 回的 id 必须是 ses 前缀字串才拿去拼 URL。
  if (!isOpenCodeSessionId(childId)) {
    console.error(
      `[gateway] subagent dispatch aborted: id=${run.id} label="${run.label}" reason=opencode returned invalid session id "${String(childId)}"`,
    )
    return "会话创建失败（opencode 返回非法 session id）"
  }
  run.opencodeSessionId = childId
  byChildOc.set(childId, run)
  // FIX-B：绑定点同时写入耐久映射（只在此写，不动 byChildOc 的 delete/has 语义）。
  rememberChildParent(childId, run)
  saveDurableSubagentRun(run)

  const model = run.isFork ? undefined : run.modelChain[run.attempt - 1]
  // 野兽模式 ON：任务书头部注入 Expert 宪法（诚实铁律/工具域断路/配方优先/
  // 记忆纪律/停止上报）。宪法档不可读时保留任务书原文并附损坏标记——任务书
  // 本身已自包含，不因宪法缺席而丢任务；标记让父会话能如实上报注入未生效。
  let constitutionNote = ""
  if (run.beastMode) {
    try {
      // R7（2026-09-10）：剥离宪法档头开发者元数据（HTML 注释 version/source/gate）
      // ——gate 声明原样进任务书会让子代理反推「无处声明当前 ON」（09-10 实锤）。
      // 当前状态声明由 gateway 动态生成，不进档案。
      const raw = readFileSync(`${import.meta.dir}/expert/expert-constitution.md`, "utf8")
      const constitution = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart().trimEnd()
      if (constitution) {
        constitutionNote = `【领域执行契约】本次派遣启用领域专家职责。\n${constitution}\n`
      }
    } catch (e) {
      constitutionNote = `【宪法注入失败】Expert 宪法档不可读（${e instanceof Error ? e.message : String(e)}），本次派遣未注入宪法。\n\n`
    }
    // P0-4（2026-10-06）：宪法之后追一行本域配方库事实行（宪法第三条命令「进域即载配方库」，
    // 对 skillPaths 为空的域必须如实说「无」，否则子代理去找不存在的配方档）。非 Expert→空串。
    constitutionNote += buildExpertSkillFact(run.agent)
  }
  // 刀 G（2026-09-15）：契约栏机器注入——Expert+beast 时把契约栏清单作为固定段追加到
  // 子代理 prompt **尾部**（recency 最高）。真源=已载入的 DELIVERY_CONTRACTS（禁手抄）。
  // 非 Expert/非 beast → renderContractDirective 回空字串 → 零注入、零回归。重派链的
  // run.prompt 已含 buildReworkDirective（自我标注「自动重派」），此段与之共存于尾部不冲突。
  const contractDirective = (run.beastMode === true || run.agent === "lyricist" || run.agent === "music") ? renderContractDirective(run.agent, DELIVERY_CONTRACTS) : ""
  // 2026-10-02：模板空位事实注入。父 sessionId 用 run.parentGatewaySessionId（派工发起端
  // 的 gateway 会话 id，= canvasStates 的 key；**禁用子会话 opencodeSessionId**，那会指到
  // 子会话画布桶）。有值才插，无值时输出与注入前逐字元等价。
  const tplFact = buildTemplateSlotsFact(run.parentGatewaySessionId, getTemplateDeviateToken(run.parentGatewaySessionId) ?? undefined)
  const templateSlotsNote = tplFact ? `【画布模板·系统事实】\n${tplFact}\n\n` : ""
  const parentState = deps?.resolveSession(run.parentGatewaySessionId) ?? deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  const authorizationNote = parentState && await billingAutoApprovalEnabled(parentState)
    ? "\n\n【当前授权·网关核实】父任务完全访问或自动模式的持续授权仍生效，任务内扣费、必要返工和可自行判断的制作选择直接继续，不再逐次问开工或费用。仍遵守委托单明确预算、指定模型、禁止生成和方案须用户确认要求；研究与独立评审照常。授权不增加工具权限：若本域应有工具缺失，回报具名席位、工具名与原始拒绝供平台修接线，不推断全平台无外网或无生图能力。"
    : "\n\n【当前授权】没有网关核实的持续授权；只按委托单已有任务与预算范围继续，范围外的付费交回父代理合并请求授权，用户沉默不算同意。"
  // 委托任务保持首个独立user part；规则与唯一机器交付格式位于system，资料不混入任务正文。
  // fork：父历史已在会话内（fork 端点复制），这里只投 d7e 指令原文；不重投 spec/模板/宪法。
  const parts: Array<{ type: "text"; text: string }> = run.isFork
    ? [{ type: "text", text: buildForkDirective(run.prompt) }]
    : [{ type: "text", text: run.prompt }]
  if (!run.isFork && templateSlotsNote) parts.push({ type: "text", text: templateSlotsNote })
  const system = run.isFork
    // D7/D8：fork 的授权段每次重新求值（剥掉父快照里的旧【当前授权】），末尾再压
    // fork 专用硬规则（禁止再派／禁止报告 .md／交付物落盘豁免），recency 最高。
    ? [stripAuthorizationSection(run.forkSystemSnapshot || WORKER_HARD_RULES), authorizationNote.trim(), FORK_HARD_RULES].filter(Boolean).join("\n\n")
    // D2：不再注入「【推理强度】」散文（安慰剂）；effort 真正生效的载体是 body.variant。
    : [constitutionNote, contractDirective, authorizationNote, WORKER_HARD_RULES].filter(Boolean).join("\n\n")
  // 供本 run 的子代理再 fork 时原样继承（fork 不能再 fork，但保留完整语义）。
  run.systemPromptSnapshot = system
  run.kernelFingerprint = currentKernelFingerprint(run.agent, run.modelOverride?.modelID ?? run.modelChain[0]?.modelID)
  const body: Record<string, unknown> = { parts }
  if (system) body.system = system
  if (model) body.model = model
  // D2：仅当呼叫方显式给 effort 时才带 variant；fork 继承父会话的 variant 快照。
  if (run.isFork) {
    if (forkVariant) body.variant = forkVariant
  } else if (run.effort) {
    body.variant = effortVariant(run.effort)
  }
  // fork 的 model:"inherit" 与 useExactTools：dev 的 fork 已复制 agent/model；1.18 的 fork
  // 只复制消息 ⇒ 显式带父会话快照。取不到就省略，让 opencode 用默认。
  if (run.isFork) {
    if (forkModel) body.model = forkModel
    if (forkAgent) body.agent = forkAgent
  }
  // R8 修复片2（2026-09-10）：Expert agent 栏（prompt_async 吃 agent 栏；
  // POST /session 不支持，08-08 实锤）。带上 = 子会话挂对应 Expert agent
  // （工具表裁剪到该域）；缺省 = default build 零变化。换模重试
  // （retryWithNextModel）走本函数，agent 自然继承。
  // fork 不带 agent/model：fork 端点已把父会话的 agent/model 复制进子会话（useExactTools）。
  if (!run.isFork && run.agent) body.agent = run.agent
  const postPrompt = (payload: Record<string, unknown>) =>
    fetch(`${deps!.openCodeUrl}/session/${childId}/prompt_async`, {
      method: "POST",
      headers: deps!.openCodeHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
  try {
    const variant = typeof body.variant === "string" ? body.variant : undefined
    let res = await postPrompt(body)
    // 2026-10-18 P1：只有「明确的 variant 不支持」才允许去掉 variant 重投。
    // 401/402/429/5xx/超时绝不重投——重投＝重复付费/重复执行，且这些状态与
    // variant 无关。400/422 是 opencode/上游对未知字段的两种标准拒绝。
    const variantUnsupported = shouldRetryWithoutVariant(res.status)
    if (!res.ok && variant && variantUnsupported) {
      // D2：该 agent/model 不支持 variant 时，原样重投（不带 variant），并如实把
      // variant_applied 记成 false——绝不把「带了字段」伪称成「升档生效」。
      delete body.variant
      run.variantApplied = false
      console.warn(
        `[gateway] subagent variant unsupported (agent=${run.agent ?? "-"} variant=${variant} status=${res.status}) — retrying without variant once: id=${run.id}`,
      )
      res = await postPrompt(body)
    } else if (res.ok && variant) {
      run.variantApplied = true
    } else if (!res.ok && variant) {
      // 非 variant 类错误：不重投，按原状态失败，避免重复付费。
      console.warn(
        `[gateway] subagent variant request failed with status=${res.status}; not retrying to avoid duplicate billing: id=${run.id}`,
      )
    }
    if (!res.ok) throw new Error(`prompt_async status ${res.status}`)
  } catch (e) {
    byChildOc.delete(childId)
    return `任务投递失败：${(e as Error).message}`
  }
  // F8（断面 B）：新子会话投递成功＝活性起点；清上一 attempt 的在途工具残留。
  run.lastActivityAt = Date.now()
  run.pendingTools.clear()
  run.pendingToolSince?.clear()
  run.pendingToolInfo?.clear()
  console.log(
    `[gateway] subagent attempt: id=${run.id} label="${run.label}" attempt=${run.attempt}/${Math.max(run.modelChain.length, 1)} model=${model ? `${model.providerID}/${model.modelID}` : "opencode-default"} child=${childId} agent=${run.agent ?? "-"}${run.isFork ? " mode=fork" : ""}`,
  )
  return undefined
}

/** 上游错误后的换模重试：新子会话 + 链上下一个模型重投任务书。 */
export async function retryWithNextModel(run: SubagentRun, lastError: string): Promise<void> {
  // 0920 停止闸：已停止的 run 不得被换模重投复活（病灶③）。
  if (run.stopped || run.status !== "running") {
    console.log(`[gateway] subagent retry skipped (stopped): id=${run.id} label="${run.label}"`)
    return
  }
  const failure = await dispatchAttempt(run)
  if (!failure) return // 重投成功：事件流继续，等 idle/error 收尾
  console.error(`[gateway] subagent retry dispatch failed: id=${run.id} ${failure}`)
  finishRun(run, "error", "", `子代理出错：${lastError}（换模重投也失败：${failure}）`)
}

