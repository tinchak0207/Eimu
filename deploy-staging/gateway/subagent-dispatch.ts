import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { guardExpertContent, musicFirstBlockReason, lyricsFirstBlockReason, isReworkSpec, reworkLockDirective, quarantineSpec, routeExpertAuthoritative, syncDispatchEligible, classifyDispatchMeta, classifyDispatchGuards, workflowTemplateDirective, isPlanOnlyNoGenerationIntent, JevDispatchGuards } from "./jev-gate"
import { workflowService, workflowOwnerBySession } from "./workflow-gw"
import { templatePlaceholderContent } from "./workflow-templates"
import { notify } from "./internal-waiters.ts"
import { registerTeamMember, removeTeamMember } from "./agent-mailbox.ts"
import { isMultiStepAvProductionIntent } from "./canvas-write-gate.ts"
import { saveDelivery, loadSessionDeliveries } from "./persistence"
import { FORK_STARTED_NOTICE, validateSubagentName, forkNameFromLabel, normalizeEffort, subagentMaxDepth, agentNestingDepth, depthLimitMessage, parseSubagentModel } from "./subagent-policy.ts"
import type { SubagentModelRef, SubagentCheckpoint, SubagentRun, ResearchPredecessor } from "./subagent-types.ts"
import { SPEC_DEADLINE_LINE, MAX_ACTIVE_PER_PARENT, HARD_TIMEOUT_MS, ASYNC_HARD_TIMEOUT_MS, SUBAGENT_OUTPUT_REL, SUBAGENT_OUTPUT_DIR, SUBAGENT_CHECKPOINTS_DIR, safeCheckpointToken, resolveCheckpointFile, PERSIST_TAIL, SUBAGENT_BUSY_MESSAGE, parseSyncDeadlineMs, partialBodyOf, RESEARCH_PRECEDED_EXPERTS, readJsonObject } from "./subagent-types.ts"
import { fireSubagentHook, deps, byParent, byChildOc, completed, criticDispatchedByParent, deliveredByParent, resolveParentSession, unknownSessionResponse, boundMap } from "./subagent-runs.ts"
import { finishRun, armHeartbeat } from "./subagent-finish.ts"
import { persistRunOutput } from "./subagent-liveness.ts"
import { dispatchAttempt } from "./subagent-attempt.ts"
import { subagentChildSlug, buildSiblingRosterFact, ensureTranscript } from "./subagent-live.ts"
import { parentOwnsRunId } from "./subagent-messages.ts"

function readCompletedPredecessor(record: ResearchPredecessor): string | null {
  if (!record.relPath.startsWith(`${SUBAGENT_OUTPUT_REL}/`)) return null
  const file = record.relPath.slice(SUBAGENT_OUTPUT_REL.length + 1)
  if (file.includes("/") || file.includes("\\") || !file.startsWith(`${record.runId}-`)) return null
  try {
    const stored = readFileSync(join(SUBAGENT_OUTPUT_DIR, file), "utf8")
    if (!stored.includes(`- runId: \`${record.runId}\`\n`) || !stored.includes("- 状态: ok\n")) return null
    const body = stored.split("- 内容: 子代理最后一条 assistant 文本全文\n")[1]?.split(`\n\n---\n\n${PERSIST_TAIL}`)[0] ?? ""
    return body.trim() ? body : null
  } catch { return null }
}

async function researchPredecessors(parent: any): Promise<{ records: ResearchPredecessor[]; available: boolean }> {
  const records = loadSessionDeliveries(parent.sessionId).filter((r) => readCompletedPredecessor(r) !== null)
  if (records.filter((r) => r.agent === "research").length >= MAX_ACTIVE_PER_PARENT || records.some((r) => RESEARCH_PRECEDED_EXPERTS.includes(r.agent))) return { records, available: true }
  // 旧通用研究没有D7交付行：仅从同父OpenCode真实dispatch工具返回绑定runId，
  // 再读该run的完整终态产物。用户正文/自称路径/URL/派遣ok均不能提供完成证据。
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session/${parent.opencodeSessionId}/message`, { headers: deps!.openCodeHeaders(), signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { records, available: false }
    const msgs = await res.json()
    if (!Array.isArray(msgs)) return { records, available: false }
    const files = readdirSync(SUBAGENT_OUTPUT_DIR)
    for (const m of msgs) {
      if (m.info?.role !== "assistant") continue
      for (const p of m.parts ?? []) {
        if (p.type !== "tool" || p.tool !== "subagent_dispatch" || p.state?.status !== "completed") continue
        let out: any
        try { out = typeof p.state.output === "string" ? JSON.parse(p.state.output) : p.state.output } catch { continue }
        const runId = out?.subagent_id
        if (typeof runId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId) || records.some((r) => r.runId === runId)) continue
        const file = files.find((f) => f.startsWith(`${runId}-`) && f.endsWith(".md"))
        if (!file) continue
        const input = p.state.input
        if (!input || typeof input.prompt !== "string") continue
        const record = { runId, agent: typeof input.expert === "string" ? input.expert : "", label: String(out.label ?? input.label ?? ""), relPath: `${SUBAGENT_OUTPUT_REL}/${file}` }
        if (readCompletedPredecessor(record) === null) continue
        if (!record.agent && (await classifyDispatchGuards(input.prompt)).research === true) record.agent = "research"
        if (record.agent !== "research" && !RESEARCH_PRECEDED_EXPERTS.includes(record.agent)) continue
        records.push(record)
        saveDelivery({ sessionId: parent.sessionId, ...record })
      }
    }
    return { records, available: true }
  } catch { return { records, available: false } }
}

export async function handleSubagentDispatch(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    sessionId?: string
    label?: string
    prompt?: string
    async?: boolean
    expert?: string
    from_checkpoint_run_id?: string
    from_checkpoint_id?: string
    // CC 2.1.302 移植：fork / model / effort / name（isolation 从未生效，已删除）。
    fork?: boolean
    subagent_type?: string
    model?: string
    effort?: string
    name?: string
  }
  const label = typeof body.label === "string" ? body.label.trim() : ""
  // `fork:true` 与 `subagent_type:"fork"` 等价（照 CC Agent schema 的 subagent_type）。
  const isFork = body.fork === true || body.subagent_type === "fork"
  // P2b 刀1：prompt 需可被自动补行改写。
  let prompt = typeof body.prompt === "string" ? body.prompt : ""
  if (!body.sessionId || !label || !prompt) {
    // D2（2026-10-02）：空字串错误码是反模式（历史 717 次）——失败一律带 code 与缺哪栏。
    const missing = [!body.sessionId ? "sessionId" : "", !label ? "label" : "", !prompt ? "prompt" : ""].filter(Boolean)
    return Response.json(
      { ok: false, code: "missing_required_args", error: `sessionId/label/prompt 均为必填；缺少：${missing.join("、")}`, missing },
      { status: 400 },
    )
  }
  // P2b 刀1：首行自动补死线行。已写「预期/预期 N」= 原样不动（避免双补）。
  // 字符集与 R1 parseSyncDeadlineMs 对齐（简/繁皆认），确保不重复补。
  // fork 是一次性执行指令（d7e），不补同步死线行。
  if (!isFork && !/^\s*[预预]\s*期\s*\d/.test(prompt)) {
    prompt = SPEC_DEADLINE_LINE + prompt
  }
  // X7/Y4（2026-10-14）深度上限：**派工前**查派工者的 childPath 深度。派工者是子代理时，
  // body.sessionId 是它的子 opencode 会话 id（byChildOc 能命中）。超限拒绝派工并如实回报
  // ——本轮只约束、不做多级路由（Codex exceeds_thread_spawn_depth_limit 同旨）。
  // CC 2.1.302 移植：默认 3（env SUBAGENT_MAX_DEPTH 覆写），文案照「Subagent nesting
  // limit reached (depth N of M)」；depth 为**派工者**的嵌套深度（main=0）。
  const requesterRun = byChildOc.get(body.sessionId)
  // CC 2.1.302 xn：fork 的可用性闸——编排/coordinator 模式不得 fork（main 会话即编排者），
  // fork 内不得再 fork（d7e 同一禁令的机器兜底），fork 不得 remote（远程会话无法继承历史）。
  // fork worker 禁止任何形式的再派工，不能把 fork:false 当作绕过入口。
  if (requesterRun?.isFork === true) {
    return Response.json(
      { ok: false, code: "fork_recursive_fork", error: "Forked workers cannot spawn subagents. Complete your task directly using your tools." },
      { status: 409 },
    )
  }
  if (isFork) {
    if (!requesterRun) {
      return Response.json(
        {
          ok: false,
          code: "fork_coordinator_mode",
          error: "Fork is not available in coordinator/orchestration mode. 主会话请派遣具名 worker；fork 只能由正在执行的子代理对自己的会话发起。",
        },
        { status: 409 },
      )
    }
  }
  if (requesterRun) {
    const depth = agentNestingDepth(requesterRun.childPath)
    const limit = subagentMaxDepth()
    if (depth >= limit) {
      console.log(
        `[gateway] subagent dispatch denied (depth ${depth} >= limit ${limit}): path=${requesterRun.childPath} label="${label}"`,
      )
      return Response.json(
        {
          ok: false,
          code: "depth_limit",
          error: depthLimitMessage(depth, limit),
          depth,
          limit,
          child_path: requesterRun.childPath,
        },
        { status: 409 },
      )
    }
  }
  // S4（FIX-G2）：session_id 必须解析到真实会话（gateway 会话／已知子代理会话）才放行——
  // 不认的 id 一律 404 unknown_session，不再把原始字符串当父键。已知子代理会话放行⇒子代理
  // 可用自己的 oc id 派孙代理（此前只认 resolveSession ⇒ 孙代理派工必 404）。
  const parent = resolveParentSession(body.sessionId)
  if (!parent) return unknownSessionResponse(body.sessionId)
  // CC 2.1.302 name：可达 64 字符；main/team-lead/user/system 保留；agent-id 形状拒绝。
  // fork 未给 name 时按 label 生成（照 aYt 的 `_`：前 3 词、≤24 字）。
  const nameCheck = validateSubagentName(body.name)
  if (nameCheck.ok !== true) {
    return Response.json({ ok: false, code: "invalid_name", error: nameCheck.error }, { status: 400 })
  }
  // P2（2026-10-18）：自动名同样必须过 validateSubagentName——label「latest/main/team lead」
  // 派生出的 `latest`/`main`/`team-lead` 是保留名，旧实现直接放行＝绕过保留名。不合法回退 "fork"。
  const autoForkName = nameCheck.name === undefined && isFork
  let requestedName = nameCheck.name
  if (autoForkName) {
    const derived = validateSubagentName(forkNameFromLabel(label))
    requestedName = derived.ok && derived.name ? derived.name : "fork"
  }
  // CC 2.1.302 后台默认（m0626 @5633 的 yo 公式）：agents run in the background by default。
  // 只有显式 async:false（且 Jev 判「下一步必须依赖结果」的快速事实查询）才同步；fork 恒后台
  // （aYt 的 isAsync:true）。并发上限仍由下方同一闸门控制，不变。
  let asyncMode = typeof deps.wakeParent === "function" && (isFork || body.async !== false)
  // 用户显式要求同步（async:false）但被 Jev 闸门强制转后台时置真：异步回执必须带上
  // sync_downgraded 与不可忽略的降级说明，避免模型对用户声称「同步等待」。
  let syncDowngraded = false
  if (!isFork && typeof deps.wakeParent === "function" && body.async === false) {
    const eligible = await syncDispatchEligible(prompt)
    if (eligible === false) {
      asyncMode = true
      syncDowngraded = true
      console.log(`[gateway] jev_gate: SYNC_DOWNGRADED label="${label}" (not a quick fact lookup, forced async)`)
    }
  }

  // R8 修复片2（2026-09-10）＋刀3 权威化（2026-09-19）：Expert 路由。
  // 仅 beast_mode ON 时生效（OFF 时 expert 静默丢弃 = 零 OFF 回归）。
  // 刀3 教义（2026-09-19 立、2026-10-02 暴君修正）：「派谁」不是 LLM 的决策——
  //   ① expert 栏可省略：省略时 Jev 选域（高信心才派，否则通用子代理）；
  //   ② LLM 点名 expert＝最终裁决：Jev 高信心不同意只记 ROUTE_DISSENT，不改派
  //     （原 ROUTE_OVERRIDE 已废除——曾把点名 video-director 的预览转存强改派
  //     editor，改派后域内无鉴权工具全 401；表面词汇无法反映工具持有面）；
  //   ③ Jev 挂 → fail-open 用点名值（行为＝部署前）。
  // 白名单校验照旧（Jev 建议也过 expert-ids.json；域外/未知 → 拒绝 400）。
  let expertId = ""
  // 2026-10-05：派遣守卫的语义判定（研究与否／是否返工／是否依赖 music）一次批次问 Jev；
  // 非 beast 派遣不花这次呼叫（保持 OFF 零变化），此时各守卫走既有正则降级路径。
  let dispatchGuards: JevDispatchGuards = { research: null, rework: null, musicDependency: null }
  const beastOn = deps.beastMode(parent)
  const rawExpert = typeof body.expert === "string" ? body.expert.trim() : ""
  if (!isFork && (beastOn || rawExpert === "lyricist" || rawExpert === "music")) {
    let allowed: unknown
    try {
      allowed = (JSON.parse(readFileSync(`${import.meta.dir}/expert/expert-ids.json`, "utf8")) as { experts?: unknown })?.experts
    } catch (e) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: `expert 清单不可读（gateway/expert/expert-ids.json：${e instanceof Error ? e.message : String(e)}）` },
        { status: 503 },
      )
    }
    if (!Array.isArray(allowed)) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: "expert 清单不可读（gateway/expert/expert-ids.json 形状错误：缺 experts 阵列）" },
        { status: 503 },
      )
    }
    const allowedList = allowed as string[]
    if (rawExpert && !allowedList.includes(rawExpert)) {
      return Response.json({ ok: false, code: "unknown_expert", error: `未知 expert：${rawExpert}`, allowed: allowedList }, { status: 400 })
    }
    // 刀3 权威路由（Jev 失败回 null → fail-open 用点名值/空）。
    const routed = (await routeExpertAuthoritative(prompt, rawExpert)) ?? {
      expertId: rawExpert,
      source: rawExpert ? ("provided" as const) : ("none" as const),
    }
    if (routed.expertId && !allowedList.includes(routed.expertId)) {
      // Jev 建议域外（不该发生：criteria 就是七域＋other；防御性回退到点名值）。
      expertId = rawExpert
    } else {
      expertId = routed.expertId
    }
    // 2026-10-05：三题一呼（Jev 范式：加题不加延迟）；Jev 挂 → 各守卫回退既有正则。
    dispatchGuards = await classifyDispatchGuards(prompt)
    // H9（2026-10-02）：内容 vs expert 域一致性守卫。
    // 在 critic 登记之前执行——被降级的研究任务不得顶掉机器 critic pass 的触发判据。
    {
      const g = guardExpertContent(prompt, expertId, dispatchGuards.research)
      if (g.reason) {
        console.log(`[gateway] jev_gate: EXPERT_GUARD ${expertId || "-"} -> ${g.expertId || "generic"} label="${label}" reason=${g.reason}`)
        expertId = g.expertId
      }
    }
    // M2：music-first 机器前置断言（依赖音乐的任务须等 music 交付事件）。
    {
      const delivered = deliveredByParent.get(parent.sessionId) ?? []
      const musicInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "music" && r.status === "running")
      const reason = musicFirstBlockReason(
        prompt,
        expertId,
        {
          musicInFlight,
          musicDelivered: delivered.some((d) => d.agent === "music"),
        },
        dispatchGuards.musicDependency,
      )
      if (reason) {
        console.log(`[gateway] jev_gate: MUSIC_FIRST_BLOCKED label="${label}" expert=${expertId || "-"} inflight=${musicInFlight}`)
        return Response.json({ ok: false, code: "music_first", error: reason, blocked: "music_first" }, { status: 409 })
      }
    }
    // 先词后曲复用真实交付簿：未过歌词契约不可作为前置成果。
    const lyrics = (deliveredByParent.get(parent.sessionId) ?? []).filter((d) => d.agent === "lyricist" && d.contractOk && d.relPath && prompt.includes(d.relPath));
    const lyricsInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "lyricist" && r.status === "running");
    const lyricsReason = lyricsFirstBlockReason(expertId, { lyricsDelivered: lyrics.length > 0, lyricsInFlight }, dispatchGuards.lyricsDependency);
    if (lyricsReason) return Response.json({ ok: false, code: "lyrics_first", error: lyricsReason, blocked: "lyrics_first" }, { status: 409 });
    if (expertId === "music" && lyrics.length && dispatchGuards.lyricsDependency !== false) {
      prompt += `\n\n【已交付歌词来源】${lyrics.at(-1)!.relPath}。先 read 完整文件，原样用于谱曲，不从摘要改写。正文问题回交 lyricist。字数与 Z% 只引用回执，不心算。`;
    }
    // 刀 2（2026-09-15）：orchestrator **自行**派 critic = 本轮已有 critic 审核动作，
    // 机器 pass 的触发判据据此豁免（不重复派遣）。登记有界 Map。
    if (expertId === "critic") {
      criticDispatchedByParent.set(parent.sessionId, parent.turnGen ?? 0)
      boundMap(criticDispatchedByParent, 500)
    }
  }

  // 刀 2B（2026-09-19）：派遣 spec 消毒（权威）。研究结论/网页内容嵌 spec 是活的
  // 间接注入通道（手册模板二【研究输入】逐字嵌 prompt）。Jev 判拦截线以上 →
  // spec 头注入机器隔离声明（不拦派遣、只废掉注入指令的效力）。
  {
    if (!isFork) {
      const quarantine = await quarantineSpec(`dispatch:${label || "unlabeled"}`, prompt)
      if (quarantine) prompt = `${quarantine}\n${prompt}`
    }
  }

  // 量级瘦身 A（2026-09-19）：spec 模板机器注入。三军模板（研究/创作/毒蛇评审，
  // playbook 1.8 逐字迁出至 spec-templates.json）按 Jev 任务分类自动追加到任务书
  // 头部——orchestrator 只写任务意图，配方由机器持有。Jev 挂 → 不注入（fail-open，
  // 子代理照原 spec 跑；模板缺档同理跳过，只留 log）。
  // 0920 暴君裁定：模板选择接 System One——同一请求批次取回工作流模板判定，
  // 命中制作类（confidence≥0.8）即把骨架硬注入任务书头（先于军团模板），
  // 让「没人负责选模板」不再可能（事故：60s 百合 OP MV 裸跑＝无角色卡约束）。
  let researchTask = dispatchGuards.research === true
  if (!isFork && expertId !== "lyricist") {
    let templateInjected = false
    try {
      const tpl = JSON.parse(readFileSync(`${import.meta.dir}/spec-templates.json`, "utf8")) as Record<string, string>
      const meta = await classifyDispatchMeta(prompt)
      researchTask = researchTask || meta.specKey === "research"
      // 研究先行是创作前置，不能只靠模型读到规则后自觉执行。复用真实run及落盘，
      // 不把派遣成功、URL列表或提示词的“已完成研究”当成前置成果。
      if (beastOn && meta.specKey === "creation" && meta.template && RESEARCH_PRECEDED_EXPERTS.includes(expertId) && !researchTask) {
        const runningResearch = (byParent.get(parent.sessionId) ?? []).filter((r) => r.researchTask && r.status === "running" && !r.stopped)
        const prior = await researchPredecessors(parent)
        if (!prior.available) return Response.json({ ok: false, code: "research_evidence_unavailable", error: "已有研究/创作的同会话持久证据暂时读不到；请保留现有产物，待证据恢复后继续，不要重做研究。" }, { status: 503 })
        const research = prior.records.filter((r) => r.agent === "research" && (readCompletedPredecessor(r) ?? "").split("\n").some((line) => line.trim() && !/^\s*(?:[-*]\s*)?(?:https?:\/\/\S+|\[[^\]]*\]\(https?:\/\/[^)]+\))\s*$/.test(line)))
        const continuing = isReworkSpec(prompt, dispatchGuards.rework) && prior.records.some((r) => r.agent === expertId && readCompletedPredecessor(r) !== null)
        if (!continuing && (research.length < MAX_ACTIVE_PER_PARENT || runningResearch.length > 0)) {
          return Response.json({
            ok: false, code: "research_first", blocked: "research_first",
            error: "研究是创作必经阶段。请先并发派遣至少三路窄领域研究，钻研前人作品并交付可读正文；当前研究尚未收齐，不能先派创作。已有真实研究不要重跑；完成后读取完整正文再编写创作规格。",
            completed_research: research.map((r) => ({ id: r.runId, label: r.label, path: r.relPath })),
            running_research: runningResearch.map((r) => ({ id: r.id, label: r.label })),
          }, { status: 409 })
        }
      }
      if (meta.template) {
        // R2-G1：禁生成／只要方案 → 指令声明＋骨架 lean（与 messages-gw PROMPT_SKELETON 同闸）。
        const planOnlyLean = isPlanOnlyNoGenerationIntent(prompt)
        prompt = `${workflowTemplateDirective(meta.template.templateId, meta.template.confidence, planOnlyLean ? { planOnlyLean: true } : undefined)}\n\n---\n\n${prompt}`
        console.log(
          `[gateway] jev_gate: WORKFLOW_TEMPLATE injected template=${meta.template.templateId} confidence=${meta.template.confidence.toFixed(2)} planOnlyLean=${planOnlyLean} label="${label}" expert=${expertId || "-"}`,
        )
        // 0920 暴君裁定（第二版）：模板判定完成即建骨架弹上画布——不等 Expert
        // 去调 workflow_start（实锤：Expert 根本没调，右边永远空白，「太慢了」）。
        // 建构用占位内容满足后端「每个 text role 非空」的验证；Expert 之后同模板
        // 呼叫 workflow_start 走 P0 幂等守卫复用同一支 wf，再用 workflow_update_node
        // 回填真内容。失败一律 fail-open（Expert 仍可自行建立，行为＝部署前）。
        try {
          // 修 4（2026-10-02）：per-session 骨架去重——本会话整个生命周期最多一个骨架。
          // 先查该父会话是否已有 workflowSnapshot（持久镜像）或已登记 owner wf：有则
          // 复用同一个 workflowId，不新建不覆盖（此前同一会话建 14 个 wf 只留最后一个=孤儿）。
          const snap = (parent as { workflowSnapshot?: { workflowId?: unknown } }).workflowSnapshot
          const snapWfId = snap && typeof snap.workflowId === "string" ? snap.workflowId : undefined
          const priorWfId = workflowOwnerBySession.get(parent.sessionId) ?? snapWfId
          if (priorWfId) {
            workflowOwnerBySession.set(parent.sessionId, priorWfId)
            console.log(
              `[gateway] jev_gate: WORKFLOW_SKELETON reused wf=${priorWfId} session=${parent.sessionId} (per-session 去重，不新建不覆盖)`,
            )
          } else {
            const r = workflowService.startFast(
              meta.template.templateId,
              templatePlaceholderContent(meta.template.templateId) as never,
              parent,
              planOnlyLean ? { planOnlyLean: true } : undefined,
            )
            if ("workflowId" in r && typeof r.workflowId === "string") {
              workflowOwnerBySession.set(parent.sessionId, r.workflowId)
              console.log(
                `[gateway] jev_gate: WORKFLOW_SKELETON built template=${meta.template.templateId} wf=${r.workflowId} session=${parent.sessionId} planOnlyLean=${planOnlyLean} (判定即弹，不等 Expert)`,
              )
            } else {
              console.log(`[gateway] workflow skeleton skipped (start error): ${"error" in r ? r.error : "unknown"}`)
            }
          }
        } catch (e) {
          console.log(`[gateway] workflow skeleton build failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (meta.specKey && typeof tpl[meta.specKey] === "string" && tpl[meta.specKey]) {
        prompt = `【系统注入·任务类型清单】只核对本任务真正要交付的部分。与本次交付物无关的条目跳过并写明原因，清单不是第二份任务。\n\n${tpl[meta.specKey]}\n\n---\n\n【任务书原文】\n${prompt}`
        templateInjected = true
      }
    } catch (e) {
      console.log(`[gateway] spec template injection skipped (read/classify failed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (templateInjected) console.log(`[gateway] spec template injected: label="${label}"`)
  }

  // M3（2026-10-02）：返工 spec 内容锁。侦测到返工任务 → 注入「只改 X 栏、其余逐字沿用
  // <原稿路径>＋交付附 diff」（原稿路径＝同 label/同 expert 最近一份落盘交付物）。
  if (!isFork && isReworkSpec(prompt, dispatchGuards.rework)) {
    const delivered = deliveredByParent.get(parent.sessionId) ?? []
    const prior = [...delivered].reverse().find((d) => d.relPath && (d.label === label.slice(0, 20) || (expertId && d.agent === expertId)))
    prompt = `${reworkLockDirective(prior?.relPath ?? "")}\n\n---\n\n${prompt}`
    console.log(`[gateway] jev_gate: REWORK_LOCK injected label="${label}" original=${prior?.relPath || "-"}`)
  }

  // 支柱二（检查点增量断点接管）：若指定了 from_checkpoint_run_id，查出前序检查点并结构化注入任务书。
  // P0（2026-10-18）：两个 token 都会拼进档名——先过白名单，非法一律 400（实测 `x/../../..` 被拒）。
  const fromCpRunIdRaw = safeCheckpointToken(body.from_checkpoint_run_id)
  const fromCpIdRaw = safeCheckpointToken(body.from_checkpoint_id)
  if (fromCpRunIdRaw === null || fromCpIdRaw === null) {
    return Response.json(
      {
        ok: false,
        code: "invalid_checkpoint_id",
        error: "from_checkpoint_run_id / from_checkpoint_id 只接受 1-64 位字母、数字、下划线、连字符（路径分隔符与 .. 一律拒绝）。",
      },
      { status: 400 },
    )
  }
  const fromCpRunId = fromCpRunIdRaw ?? ""
  const fromCpId = fromCpIdRaw ?? ""
  let inheritedCp: SubagentCheckpoint | undefined
  if (fromCpRunId && !isFork) {
    const liveRun = (byParent.get(parent.sessionId) ?? []).find((r) => r.id === fromCpRunId)
    if (liveRun?.checkpoints?.length) {
      inheritedCp = fromCpId ? liveRun.checkpoints.find((c) => c.id === fromCpId) : liveRun.lastCheckpoint ?? liveRun.checkpoints[liveRun.checkpoints.length - 1]
    }
    // F1（P1·跨会话越权修复，2026-10-14）：回退两条腿（completed 记录 / 落盘检查点档）都必须过
    // 父归属闸——liveRun 那条已按父过滤，这两条没有：B 知道 A 的 run id 即可把 A 的终态检查点
    // （summary/data 整段）注入本会话任务书。归属不成立＝视同查不到（不回退、不注入），行为与
    // 其他「查不到」一致。归属判据复用同一文件既有的 parentOwnsRunId。
    const cpOwned = parentOwnsRunId(parent.sessionId, fromCpRunId)
    if (!inheritedCp && cpOwned) {
      const compRec = completed.get(fromCpRunId)
      if (compRec?.lastCheckpoint && (!fromCpId || compRec.lastCheckpoint.id === fromCpId)) {
        inheritedCp = compRec.lastCheckpoint
      }
    }
    if (!inheritedCp && cpOwned) {
      try {
        if (existsSync(SUBAGENT_CHECKPOINTS_DIR)) {
          const files = readdirSync(SUBAGENT_CHECKPOINTS_DIR).filter((f) => f.startsWith(`${fromCpRunId}-`) && f.endsWith(".json"))
          if (files.length > 0) {
            files.sort()
            // P0：目标档路径必须由受校验 token 构造，且 resolve 后仍在 checkpoints 目录内。
            const targetFile = fromCpId ? `${fromCpRunId}-${fromCpId}.json` : files[files.length - 1]
            const fallbackId = fromCpId || targetFile.slice(fromCpRunId.length + 1, -".json".length)
            const targetPath = resolveCheckpointFile(SUBAGENT_CHECKPOINTS_DIR, fromCpRunId, fallbackId)
            if (targetPath && existsSync(targetPath)) {
              inheritedCp = JSON.parse(readFileSync(targetPath, "utf8")) as SubagentCheckpoint
            }
          }
        }
      } catch (e) {
        console.warn(`[gateway] subagent checkpoint read deferred: ${fromCpRunId}`, e)
      }
    }
  }

  if (inheritedCp) {
    const cpFact = `【检查点断点接管·系统事实】
本子代理继承前序子代理（runId: ${inheritedCp.run_id}）阶段【${inheritedCp.stage}】进度 ${inheritedCp.progress}%：
- 阶段摘要：${inheritedCp.summary}
- 检查点数据：
${JSON.stringify(inheritedCp.data, null, 2)}

【铁律】以上阶段与任务已完成并验证，绝对禁止从零重跑！直接从该阶段断点接续攻坚！\n\n`
    prompt = `${cpFact}${prompt}`
  }

  // 并发上限：第 4 个拒绝（已挂起 suspended 的子代理交出并发槽，不计入运行数），文案原样给主代理。
  const list = byParent.get(parent.sessionId) ?? []
  const runningList = list.filter((r) => r.status === "running")
  if (runningList.length >= MAX_ACTIVE_PER_PARENT) {
    return Response.json({
      ok: false,
      code: "concurrency_limit",
      error: SUBAGENT_BUSY_MESSAGE,
      running: runningList.map((r) => ({ id: r.id, label: r.label, elapsed_ms: Date.now() - r.startedAt })),
    }, { status: 409 })
  }

  // Y4（2026-10-14）兄弟名册：把「本父会话当前存在哪些子代理」作为任务书头部事实块注入。
  // 病灶：子代理只知道自己那点 prompt，不知道同会话还有谁在跑、谁已交付 ⇒ 重复劳动／
  // 互相踩脚。名册是**启动时刻的快照**（照 Claude Code sibling roster 语义）；本 run 此刻
  // 还没进 list，天然不入册。无事实＝零注入（输出与注入前逐字等价）。
  // 刻意放在全部 Jev 分类／守卫／模板注入之后：注入内容不参与语义判定（零扰动）。
  const rosterFact = isFork ? "" : buildSiblingRosterFact(parent.sessionId)
  if (rosterFact) prompt = `${rosterFact}${prompt}`

  // 模型链：父会话 persona 主模型 + registry fallbacks（空链 = 吃 opencode 预设，
  // 仅在 registry 缺失的极端情况发生，此时无链可换）。
  // CC 2.1.302：显式 model 覆写优先级最高（fork 忽略，继承父模型）；effort 只选档与
  // 任务书声明（opencode 1.18 无 per-request effort 栏位，见 subagent-policy.ts）。
  let chain: SubagentModelRef[] = []
  try {
    chain = deps.subagentModelChain(parent) ?? []
  } catch (e) {
    console.error(`[gateway] subagent model chain failed (fallback to opencode default): id=${parent.sessionId}`, e)
  }
  const effort = isFork ? undefined : normalizeEffort(body.effort)
  if (!isFork && body.effort !== undefined && body.effort !== null && body.effort !== "" && effort === undefined) {
    return Response.json(
      { ok: false, code: "invalid_effort", error: `effort 只接受 low/medium/high/xhigh/max（收到 ${JSON.stringify(body.effort)}）` },
      { status: 400 },
    )
  }
  let modelOverride: SubagentModelRef | undefined
  if (!isFork && body.model !== undefined && body.model !== null && body.model !== "") {
    const parsed = parseSubagentModel(body.model, chain[0]?.providerID)
    if (!parsed) {
      return Response.json(
        { ok: false, code: "invalid_model", error: `model 需为 "provider/model" 或可补齐 provider 的 modelID（收到 ${JSON.stringify(body.model)}）` },
        { status: 400 },
      )
    }
    modelOverride = parsed
    chain = [parsed, ...chain.filter((m) => m.providerID !== parsed.providerID || m.modelID !== parsed.modelID)]
  }

  // P2（2026-10-18 并发同名原子占位）：名字检查与占位必须与 `targetList.push(run)` 处在**同一段
  // 同步代码**里——此前检查发生在多个 await（Jev 分类/路由/模板）之前，两个并发 dispatch 能
  // 同时通过检查、各自推出同名 run。这里在 push 前紧邻检查（中间无 await），单线程下即原子。
  if (requestedName) {
    const isUnfinished = (r: SubagentRun): boolean => !r.stopped && (r.status === "running" || r.status === "interrupted" || r.status === "suspended")
    // 重新读取当前数组（并发 dispatch 可能已把 byParent 换成新数组）；检查与 push 之间无 await。
    const currentList = byParent.get(parent.sessionId) ?? list
    const activeNames = new Set(currentList.filter(isUnfinished).map((r) => r.name))
    if (activeNames.has(requestedName)) {
      // fork 的自动名（label 派生）照 aYt 的 allocateName：自动加序号，不让并发 fork 因撞名失败。
      if (autoForkName) {
        const base = requestedName
        for (let i = 2; i <= 99; i++) {
          const candidate = `${base}-${i}`.slice(0, 64)
          if (!activeNames.has(candidate)) {
            requestedName = candidate
            break
          }
        }
      }
      if (activeNames.has(requestedName)) {
        return Response.json(
          { ok: false, code: "name_taken", error: `name「${requestedName}」已被本会话一个**尚未结束**的子代理占用；换一个名字或等它结束后再用。` },
          { status: 409 },
        )
      }
    }
  }
  const runId = crypto.randomUUID()
  const run: SubagentRun = {
    id: runId,
    // X3：父子链寻址。派工者是子代理时挂在它的路径下（本轮只做深度约束，不做多级路由）。
    childPath: requesterRun ? `${requesterRun.childPath}/${subagentChildSlug(label, runId)}` : `/root/${subagentChildSlug(label, runId)}`,
    parentSubagentId: requesterRun?.id,
    parentGatewaySessionId: parent.sessionId,
    parentOpencodeSessionId: parent.opencodeSessionId,
    opencodeSessionId: "",
    label: label.slice(0, 20),
    name: requestedName,
    isFork: isFork || undefined,
    forkSourceOpencodeSessionId: isFork ? body.sessionId : undefined,
    // D7：fork 的结果回到发起它的子代理，而不是主会话。
    forkRequesterRunId: isFork ? requesterRun?.id : undefined,
    // D6：记录真实派工者（子会话创建时写 parentID）。
    requesterOpencodeSessionId: body.sessionId,
    // 父 system prompt 快照：fork 取派工者自己的 system 快照（宪法/契约/授权/worker 规则），
    // 这是 d7e 的 parent system prompt snapshot；不是主会话的 lastPromptBody。
    forkSystemSnapshot: isFork ? requesterRun?.systemPromptSnapshot : undefined,
    effort,
    modelOverride,
    startedAt: Date.now(),
    status: "running",
    prompt,
    modelChain: chain,
    attempt: 1,
    // 片 D（2026-09-15）：交付闸门重派计数，硬帽 1 次。
    reworkCount: 0,
    // X8/X5/X6/X7（协作总线）：新栏位一律显式初始化（有界容器），不留 undefined 分叉。
    toolTimeline: [],
    pendingChildMessages: [],
    pendingParentNotes: [],
    pendingQuestions: [],
    submissionSeq: 0,
    beastMode: deps.beastMode(parent),
    agent: expertId || undefined,
    researchTask,
    asyncMode,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    artifacts: [],
    toolStatusEmitted: new Map(),
    checkpoints: inheritedCp ? [inheritedCp] : [],
    lastCheckpoint: inheritedCp,
    fromCheckpoint: inheritedCp ? { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } : undefined,
  }
  const targetList = byParent.get(parent.sessionId) ?? list
  targetList.push(run)
  byParent.set(parent.sessionId, targetList)
  // run 建立成功（已入注册表、可被事件/状态查询看见）→ SubagentStart。
  fireSubagentHook("SubagentStart", run, { async_mode: asyncMode === true })
  ensureTranscript(run)
  // 2026-10-11 修画布：music／video-director 派遣即标影音意图；编剧／剪辑在父会话已标或 prompt 命中时补标。
  if (expertId === "music" || expertId === "video-director") {
    parent.avProductionIntent = true
    if (!parent.avProductionTemplateId) {
      parent.avProductionTemplateId = expertId === "music" ? "music" : "feature_film"
    }
  } else if (
    (expertId === "screenwriter" || expertId === "editor") &&
    (parent.avProductionIntent === true ||
      isMultiStepAvProductionIntent({ templateId: parent.avProductionTemplateId, prompt }))
  ) {
    parent.avProductionIntent = true
  }

  // 硬顶：同步 15 分钟（工具轮询 16 分钟死线之前收尾）；R6 async 30 分钟
  // （军团的窄领域研究/创作任务合法地更长，无工具死线顶着，给足余量）。
  const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3（2026-10-02）：逾时先落盘已累积的 partial 文字，再 error 收尾（不让已有工作不可追）。
    run.partialPersist = true
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：心跳 + 逾时前 2 分钟部分交付。
  armHeartbeat(run, hardMs)

  // 协作总线接线（P0）：派遣**前**登记，保证子会话第一次工具调用即可解析身份。
  // P2：同名成员已存在时用 `name#shortRun`，旧名未读消息不继承；旧 run 已结束时摘除
  // 旧名（仍有活 run 则保留其可寻址性）。登记失败不影响派遣，子会话将明确不可寻址。
  let mailboxMembership: { team: string; agent: string } | undefined
  try {
    const mailboxBaseName =
      (run.name ?? run.label.trim().replace(/\s+/g, "-")).slice(0, 64) || `worker-${run.id.slice(0, 8)}`
    const liveBaseNames = new Set(
      (byParent.get(parent.sessionId) ?? [])
        .filter((r) => r !== run && !r.stopped && (r.status === "running" || r.status === "interrupted" || r.status === "suspended"))
        .map((r) => r.mailboxName ?? ((r.name ?? r.label.trim().replace(/\s+/g, "-")).slice(0, 64) || `worker-${r.id.slice(0, 8)}`)),
    )
    const row = registerTeamMember(parent.sessionId, undefined, mailboxBaseName, expertId || null, {
      runId: run.id,
      uniquePerRun: true,
      replaceStale: !liveBaseNames.has(mailboxBaseName),
    })
    run.mailboxName = row.agent
    mailboxMembership = { team: row.team, agent: row.agent }
  } catch (e) {
    console.error("[gateway] mailbox member registration failed:", e)
  }

  // 投递任务书（第一次 attempt；后续上游错误换模重试走 retryWithNextModel）
  const failure = await dispatchAttempt(run)
  if (failure) {
    // 投递从未成功：撤销本次成员登记，避免名册留下不可达成员。
    if (mailboxMembership) {
      try {
        removeTeamMember(mailboxMembership.team, mailboxMembership.agent)
      } catch (e) {
        console.error("[gateway] mailbox member rollback failed:", e)
      }
    }
    // 投递失败：死因随 502 同步返回工具（主会话当场知道），R6 唤醒不再补发，
    // 避免同一失败双重注入。
    run.asyncMode = false
    finishRun(run, "error", "", `子代理${failure}`)
    return Response.json({ ok: false, error: `子代理${failure}` }, { status: 502 })
  }

  deps.emitToSession(parent, "subagent.started", { id: run.id, label: run.label })
  console.log(
    `[gateway] subagent dispatched: id=${run.id} label="${run.label}" parent=${parent.sessionId} child=${run.opencodeSessionId}${asyncMode ? " mode=async" : ""}`,
  )
  if (!asyncMode) {
    // R1（2026-09-11）：同步 dispatch 硬 deadline。到点先让主会话解锁（工具轮询
    // /internal/subagent/status 读 completed 即取件，实测 <30s 收到 ok:false/TIMEOUT），
    // **子代理 run 不杀**：翻 asyncMode 让它后台续跑，完成后走既有 wakeParent 回填。
    const deadlineMs = parseSyncDeadlineMs(run.prompt)
    // P2b：arm 时刻记一条，deadline 解析结果可被日志直接观测（V3 不必等 240s）。
    console.log(
      `[gateway] subagent sync deadline armed: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s prompt_head="${run.prompt.slice(0, 24).replace(/\n/g, "\\n")}"`,
    )
    run.deadlineTimer = setTimeout(() => {
      run.deadlineTimer = undefined
      if (run.status !== "running") return
      if (completed.has(run.id)) return
      if (typeof deps?.wakeParent === "function") run.asyncMode = true
      const human =
        deadlineMs < 60_000
          ? `子代理超过预定时间（${Math.round(deadlineMs / 1000)} 秒）未回，已放它后台续跑；你先看其他结果`
          : `子代理超过预定时间（${Math.round(deadlineMs / 60_000)} 分钟）未回，已放它后台续跑；你先看其他结果`
      completed.set(run.id, {
        status: "error",
        summary: "",
        error: human,
        finishedAt: Date.now(),
        label: run.label,
        partial: true,
        reason: "timeout",
        parent: run.parentGatewaySessionId,
      })
      // WP2（2026-10-14）：同步 dispatch 超时放行＝轮询方可观测的终态（done:true/timeout）——
      // 叫醒该 run 的长挂起 waiter，让工具端立即取件而非等满 wait_ms。
      notify(`subagent:${run.parentGatewaySessionId}:${run.id}`)
      // E 片（2026-09-12）：超时放行这一刻的事实也落盘（无正文 → 写死因事实）。此刻
      // 盘上不是交付物，**不挂「完整结果已落盘」指针**（挂了会误导）；run 后续真完成
      // 时 finishRun 用全文覆写同一档并带指针。
      const partialPersist = persistRunOutput(run, "timeout", "", human)
      if (partialPersist.relPath) {
        console.log(`[gateway] subagent partial persisted: id=${run.id} path=${partialPersist.relPath}`)
      }
      console.warn(
        `[gateway] subagent sync deadline hit: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s — 主会话已放行，子代理转后台续跑`,
      )
    }, deadlineMs)
  }
  if (asyncMode) {
    // R6 异步：投递成功立即返回，主会话 turn 可正常结束；完成后 wakeParent 唤醒。
    return Response.json({
      ok: true,
      subagent_id: run.id,
      label: run.label,
      ...(run.name ? { name: run.name } : {}),
      ...(run.isFork ? { fork: true, model: "inherit" } : {}),
      status: "running",
      async: true,
      ...(syncDowngraded ? { sync_downgraded: true } : {}),
      note: syncDowngraded
        ? "你要求同步等待，但这一路不是快速事实查询，已按后台执行：现在返回的是已派出，不是结果。用户问起时要照实说「后台运行」。完成后会自动唤醒主会话汇总。注意 subagent_id 是网关派工 run id，**不是 opencode session id**——不要把它当 task_id 传给内置 task 工具（必被拒：Expected a string starting with \"ses\"）；要取回完整交付物就 read 唤醒摘要里的落盘文件路径，或用 subagent_status 工具。"
        : run.isFork ? FORK_STARTED_NOTICE : "后台运行中，完成后自动唤醒主会话汇总。结束本轮，不要轮询等待。注意 subagent_id 是网关派工 run id，**不是 opencode session id**——不要把它当 task_id 传给内置 task 工具（必被拒：Expected a string starting with \"ses\"）；要取回完整交付物就 read 唤醒摘要里的落盘文件路径，或用 subagent_status 工具。",
      ...(inheritedCp ? { from_checkpoint: { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } } : {}),
      // D2：显式 effort 时如实回报 variant 是否真的带上（不支持＝false，非安慰剂）。
      ...(run.effort ? { effort: run.effort, variant_applied: run.variantApplied === true } : {}),
    })
  }
  return Response.json({
    ok: true,
    subagent_id: run.id,
    ...(run.name ? { name: run.name } : {}),
    ...(run.isFork ? { fork: true, model: "inherit" } : {}),
    ...(run.effort ? { effort: run.effort, variant_applied: run.variantApplied === true } : {}),
    ...(inheritedCp ? { from_checkpoint: { run_id: inheritedCp.run_id, checkpoint_id: inheritedCp.id, stage: inheritedCp.stage } } : {}),
  })
}

