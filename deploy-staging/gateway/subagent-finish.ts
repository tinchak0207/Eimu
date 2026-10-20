import { notify } from "./internal-waiters.ts"
import { parseToolOutput, collectToolOutputMediaUrls } from "./events-translate.ts"
import { saveDurableSubagentRun, durableSubagentRun } from "./job-store"
import { checkDelivery, formatDeliveryGateNotice, buildReworkDirective, criticVerdictRejected, checkCriticReceipt, CRITIC_REJECT_MARK, CRITIC_PASS_MARK, REWORK_FAIL_MARK, DELIVERY_CONTRACTS, evaluateCriticScoreThreshold, CRITIC_SCORE_THRESHOLD_POLICY, scrubSubagentPayload, ArtifactVerifyRecord, CriticScoreSample, DeliveryGateResult, CriticPassTarget } from "./delivery-gate"
import { listArtifacts, artifactLocalEvidenceMatches } from "./artifact-store.ts"
import { saveReworkRecord, deleteReworkRecord, saveCriticVerdict, saveExpertLesson, saveDelivery } from "./persistence"
import { measureMediaScore, MEDIA_QUALITY_MEASURED_MARK, MeasuredMediaResult } from "./media-quality.ts"
import type { SubagentRun } from "./subagent-types.ts"
import { HARD_TIMEOUT_MS, ASYNC_HARD_TIMEOUT_MS, isShellTool, SUMMARY_MAX_CHARS, subagentResumeTtlMs, truncateSummaryText, toolOutputMediaBag, userFacingSubagentLabel, partialBodyOf, unrefTimer, isOpenCodeSessionId } from "./subagent-types.ts"
import { fireSubagentHook, deps, byParent, byChildOc, completed, resumable, pendingCriticTargets, deliveredByParent, noteDurableTerminalRetry, CRITIC_PENDING_CAP, parentStateOf, boundMap, removeFromRegistries } from "./subagent-runs.ts"
import { oldestPendingTool, persistRunOutput, childUsageSnapshot } from "./subagent-liveness.ts"
import { dispatchAttempt } from "./subagent-attempt.ts"
import { maybeDrainCriticQueue } from "./subagent-events.ts"
import { writeLiveLog, appendTranscriptEnd } from "./subagent-live.ts"
import { deliverChildTurn, findRunById, forkResultDeliveryTarget } from "./subagent-messages.ts"
import { checkPendingResumeQueue } from "./subagent-suspend.ts"

/**
 * 2026-10-03（v3 接线）：开关 `CRITIC_SCORE_ENFORCE`。真值＝**必须字面 "1"**。
 * 刻意不接受 "true"/"on"/"yes"：本闸门一旦启用，measured 低分会被当成「退回」，
 * 经既有重派链让上游 Expert 重跑＝再一次模型呼叫＝花钱，故用最不易误开的形式。
 * 未设／其他值 → false：与接线前**逐位元组相同**（零 I/O、零 await、零重派）。
 */
export function criticScoreEnforcementEnabled(): boolean {
  return process.env.CRITIC_SCORE_ENFORCE === "1"
}

/**
 * 纯函数（可单测）：measured 样本 + 开关 → 是否以数值阈值强制退回。
 * 三条件缺一不可：开关 true；来源＝policy.enforcedSource（measured）；分数 < reworkBelow。
 * 无分数（null）／model_self／human → 一律 false（未知≠失败；模型自评非验收 oracle）。
 * 判定逻辑全在 evaluateCriticScoreThreshold（唯一真源），本函数只加 env 闸门、不另立阈值。
 */
export function shouldForceCriticRejectByScore(
  sample: CriticScoreSample,
  enabled: boolean = criticScoreEnforcementEnabled(),
): boolean {
  if (!enabled) return false
  return evaluateCriticScoreThreshold(sample).enforce
}

/**
 * 2026-10-03：对机器 critic run 所审 Expert 交付做**事后产物硬检**，只算不写。
 * 全程 try/catch，永不 throw；量测回 null（开关 OFF／ffprobe 不可用／无媒体／量测失败）
 * → 回 null，呼叫端据此维持 null 分数（未知≠通过，绝不填 0/满分冒充）。写入交由呼叫端
 * 一次性完成（persistMeasuredVerdict），避免第二套写入路径。
 */
async function measureReviewedMedia(run: SubagentRun): Promise<MeasuredMediaResult | null> {
  try {
    const targets = run.criticReviewed ?? []
    if (targets.length === 0) return null
    return await measureMediaScore(targets.map((t) => t.text))
  } catch (e) {
    console.warn(`[gateway] media-quality-gate: measured 旁路失败已忽略（交付不受影响）run=${run.id}`, e)
    return null
  }
}

/** 以同一 runId 覆写 critic_verdicts 的 measured 分栏（唯一写入形状＝persistence.saveCriticVerdict）。 */
function persistMeasuredVerdict(run: SubagentRun, measured: MeasuredMediaResult, criticVerdictText: string): void {
  try {
    saveCriticVerdict({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      // verdict 沿用 critic 判读（硬检不翻判方向，只补数值分；两者不混为一谈）。
      verdict: run.machineCriticRejected ? "reject" : "pass",
      score: measured.score,
      // measured 有数值才算（saveCriticVerdict 内另有「measured 无数值→来源强制 null」不变式）。
      scoreSource: "measured",
      judgeModel: "hardcheck/ffprobe",
      // 量测细节置前（保留 provenance），其后附 critic 判词（saveCriticVerdict 统一截 4000）。
      verdictText: `${MEDIA_QUALITY_MEASURED_MARK}${measured.detail}\n\n${criticVerdictText}`,
    })
    console.log(
      `[gateway] media-quality-gate: measured 技术分=${measured.score} 件数=${measured.artifacts} run=${run.id}（覆盖 model_self 分栏；仅技术正确性，非审美）`,
    )
  } catch (e) {
    console.warn(`[gateway] media-quality-gate: measured 旁路失败已忽略（交付不受影响）run=${run.id}`, e)
  }
}

/**
 * 2026-10-03：fire-and-forget 旁路（**仅在闸门关闭时使用**）。量测成功 → 以同一 runId
 * 覆写 critic_verdicts 的 measured 分栏（供观测）；失败 → 不写。终态收尾**不被阻断**。
 * 闸门开启时改走 finishRun 内的 await 路径（量测结果要先参与判决），本函数不再被呼叫。
 */
async function applyMeasuredMediaVerdict(run: SubagentRun, criticVerdictText: string): Promise<void> {
  const measured = await measureReviewedMedia(run)
  if (!measured) return
  persistMeasuredVerdict(run, measured, criticVerdictText)
}

/**
 * P1-3：交付闸消费 verify 状态。子代理的 artifact 工具以**子会话 id** 写入 store，
 * 所以按 run.opencodeSessionId 取 mine 列表；仅查询成功的空记录兼容历史交付。
 * store 读取失败返回明确失败证据，由收尾链正常落失败终态，不抛出留下悬挂 run。
 */
function artifactVerifyRecords(run: SubagentRun): ArtifactVerifyRecord[] {
  try {
    if (!run.opencodeSessionId) return []
    return listArtifacts(run.opencodeSessionId, "mine").map((view) => ({
      name: view.name,
      verify_status: view.verify_status,
      url: view.url,
      local_available: artifactLocalEvidenceMatches(view),
    }))
  } catch (e) {
    console.warn(`[gateway] delivery gate: artifact verify 状态读取失败，拒绝交付 run=${run.id}`, e)
    return [{ name: "artifact_store_unavailable", verify_status: "blocked" }]
  }
}

/** 收尾：登记结果、摘除注册表、向父会话发 done、DELETE 子会话防堆积。
 *  2026-10-03：改 async——仅在「critic-score 闸门开启且本 run 是机器 critic」时才会 await
 *  一次量测（要在判决前拿到 measured 分）。闸门未设时无任何 await：副作用与时序与接线前
 *  完全相同（呼叫端皆忽略回传值）。 */
export async function finishRun(run: SubagentRun, status: "ok" | "error", fullText: string, error?: string): Promise<void> {
  if (durableSubagentRun(run.id)?.result) return
  if (run.status !== "running" && !(run.status === "interrupted" && run.softStopping)) return // 幂等：idle 与超时硬顶可能竞态
  // 0920 停止闸：停止已由 stopSubagentRun 收尾（已 done/已摘表）；此处不得再走
  // 交付闸门或 wakeParent——否则停止后仍会把父会话唤醒重跑（「刹不住」病灶①）。
  if (run.stopped) return
  // C3（2026-10-14）：soft stop 的优雅期到此结束（子会话自己收尾了）——撤掉超时兜底计时器，
  // 并把「为什么收尾」带进终态记录（spec：soft 终态带 reason ＋起止时间）。
  if (run.softStopping) {
    if (run.softStopping.timer) clearTimeout(run.softStopping.timer)
  }
  const softStop = run.softStopping
  run.softStopping = undefined
  run.status = status
  // CC 2.1.302 结果契约：usage 必须随完成通知/status 返回。summarizeChild 路径已算过；
  // 超时/上游错误等收尾路径在此补一次（幂等：已有值不重算）。
  if (!run.usage) run.usage = await childUsageSnapshot(run)
  // E 片（2026-09-12）缺陷一：**先落盘完整全文/死因全文，再走摘要与 DELETE**。行内
  // 摘要仍只给 600 字（semantics 不变），但前缀挂落盘指针 → 父会话可 read 全文。
  // usage 的 await 完成后再取交付证据快照；无名/普通 expert 同样受已登记产物闸约束。
  const artifactVerify = status === "ok" ? artifactVerifyRecords(run) : []
  const artifactEvidenceVerdict = checkDelivery(undefined, fullText, {}, artifactVerify)
  const persist = persistRunOutput(run, status, fullText, error)
  if (status === "ok" && artifactEvidenceVerdict.ok && run.agent && !run.stopped && typeof run.goalEvaluator !== "function") {
    const arr = deliveredByParent.get(run.parentGatewaySessionId) ?? []
    arr.push({ agent: run.agent, label: run.label, relPath: persist.relPath ?? "", contractOk: run.agent === "lyricist" ? checkDelivery(run.agent, fullText, DELIVERY_CONTRACTS, artifactVerify).ok : undefined })
    if (arr.length > 20) arr.shift()
    deliveredByParent.set(run.parentGatewaySessionId, arr)
    boundMap(deliveredByParent, 500)
  }
  // 2026-10-02 能力片：ok 摘要＝最后一则有文字的 assistant 讯息（语义取自 Claude Code
  // 子代理回传契约）+ 一行用量计数；**不是**「全文前 N 字」。子代理末则文字可能上万字，
  // 为避免 done 帧与注入父会话的唤醒文案膨胀（与本轮控上下文/工具结果大小的目标一致），
  // 以 SUBAGENT_SUMMARY_MAX_CHARS 在换行边界截断并附「已截断」提示；全文落盘照旧保留
  // （persist.pointer / PERSIST_TAIL 不变）。error 摘要维持原 600 字死因帽（既有语义零回归）。
  const okTrunc = status === "ok" && run.agent !== "lyricist" ? truncateSummaryText(fullText) : null
  const inline =
    error && status === "error"
      ? error.slice(0, SUMMARY_MAX_CHARS)
      : okTrunc
        ? okTrunc.text
        : fullText
  const truncNote =
    okTrunc && okTrunc.truncated > 0 ? `\n\n[已截断 ${okTrunc.truncated} 字元；完整结果见落盘指标]` : ""
  const usageNote =
    run.usage
      ? `\n\n[子代理用量] 工具调用 ${run.usage.tool_calls} 次 · 耗时 ${Math.round(run.usage.duration_ms / 1000)}s${typeof run.usage.tokens === "number" ? ` · token ${run.usage.tokens}` : " · token 上游未提供"}`
      : ""
  let summary = `${persist.pointer}${inline}${truncNote}${usageNote}`
  run.summary = summary
  run.error = error
  // 片 C（2026-09-15）刀2：交付闸门。病灶＝7 个 Expert 的 `*_DELIVERABLES` 契约只写在
  // prompt/digest 里，gateway 全域零强制点，漏交付（09-15 实案 music.audio_url 空）照样
  // status:"ok" 放行。此处为唯一机械强制点：
  //   - **不改 status 语义**（ok 仍为 ok；交付缺口不是上游错误，混进 error 会让既有
  //     「换模重试/超时」判读全乱）；
  //   - 只在 summary 前缀加显式标记 → 三个出口（subagent.done payload、completed 取件、
  //     wakeParent 唤醒）自动全带（三处都用下面这个 summary 变数）；
  //   - subagent.done payload 加**新栏位** delivery_gate（ok 时不加，既有栏语义不动）。
  // 判据用**未截断全文 fullText**（不是 600 字摘要——摘要会把栏位名切掉→假阴性）。
  // 历史契约范围不变；任何 run 的实际登记产物都必须具备可用交付证据。
  // 边界：只验栏位名存在性，不验值/品质（见 delivery-gate.ts 档头）。
  let deliveryGate: { ok: boolean; missing: string[]; reworked?: boolean; stillFailing?: boolean; orphaned?: boolean } | undefined
  // 刀 F（2026-09-15）：孤儿治理路径——启动扫描重建的 in-flight rework run（watcher 已死、
  // 不续 watch），done 带 delivery_gate.orphaned:true，summary 已含 ORPHANED_GATE_MARK 前缀
  // （呼叫端 error 字串带入）；status 由呼叫端传 "error"，走既有单终态守卫 + 单次 wake。
  if (run.orphaned === true) {
    const miss = run.agent && DELIVERY_CONTRACTS[run.agent] ? DELIVERY_CONTRACTS[run.agent].requiredFields.slice() : []
    deliveryGate = { ok: false, missing: miss, reworked: true, stillFailing: true, orphaned: true }
    console.warn(
      `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=ORPHANED (进程中断未复原) missing=${miss.join(",")}`,
    )
  } else if (status === "ok" && ((run.beastMode === true || run.agent === "lyricist" || run.agent === "music") && run.agent || artifactVerify.length > 0)) {
    // 历史契约范围不扩大；其他 run 仅检查其实际登记的产物证据。
    const enforceContract = run.beastMode === true || run.agent === "lyricist" || run.agent === "music"
    const verdict = checkDelivery(enforceContract ? run.agent : undefined, fullText, DELIVERY_CONTRACTS, artifactVerify)
    // 片 D（2026-09-15）：FAIL → 机器化重派一次（同 Expert 同任务＋修正指令注回，硬帽
    // reworkCount=1）。触发条件＝闸门区块外条件（ok+beastMode+agent）加 FAIL 判定，
    // 非 Expert/已失败收场零污染；status==="ok" 是必要条件——上游 error/超时不进重派链。
    // 提前 return：本轮**不终态**（回退 status、不发 done/不 completed.set/不 wake），
    // run 留在注册表由 startRework 接棒；终态只属重派链的最后一次 finishRun（spec 6 幂等）。
    // 产物证据失败直接拒绝；换子会话重派会遗忘旧 store 记录，不能作为修复证据。
    if (!verdict.ok && artifactEvidenceVerdict.ok && run.reworkCount === 0 && !run.reworkFailure && !run.stopped) {
      run.reworkCount = 1
      run.reworking = true
      run.status = "running"
      run.summary = undefined
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL missing=${verdict.missing.join(",")} — 触发机器化重派`,
      )
      // D7（2026-10-02）：失败模式永久留存（此前 subagent_reworks 终局删除、无终身计数）。
      saveExpertLesson({
        sessionId: run.parentGatewaySessionId,
        agent: run.agent ?? "unknown",
        runId: run.id,
        source: "delivery_gate",
        failureMode: verdict.missing.join(",") || "delivery_gate_fail",
        detail: typeof fullText === "string" ? fullText.slice(0, 2000) : "",
      })
      void startRework(run, verdict, fullText)
      return
    }
    if (!verdict.ok) {
      if (verdict.missing.some((field) => field.startsWith("artifact:"))) {
        // 真实产物证据失败直接作为失败终态，不能靠换会话重派抹去旧记录。
        status = "error"
        run.status = "error"
        error = verdict.reason || "登记产物没有可用交付证据"
        run.error = error
      }
      if (!artifactEvidenceVerdict.ok) {
        summary = `${verdict.reason || "产物缺少可用交付证据，请修复当前引用后重新交付。"}\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing }
      } else if (run.reworkFailure) {
        // 重派投递从未成功（如 opencode 不可达）：重派没跑过，done 不伪称 reworked——
        // 维持片 C 原「未达标」标记语义，仅缀一行失败事实。
        summary = `${formatDeliveryGateNotice(run.agent ?? "", verdict, DELIVERY_CONTRACTS)}（自动重派投递失败：${run.reworkFailure}）\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing }
      } else {
        // 重派后复检仍 FAIL：标记升级「重派后仍未达标」，交由既有唤醒链如实回报。
        // status 栏语义不动（仍 ok——重派是补救尝试，不保证成功，也不把缺口洗成错误）。
        summary = `${formatDeliveryGateNotice(run.agent ?? "", verdict, DELIVERY_CONTRACTS, REWORK_FAIL_MARK)}\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing, reworked: true, stillFailing: true }
      }
      run.summary = summary
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL${run.reworkCount > 0 ? " (rework exhausted)" : ""} missing=${verdict.missing.join(",")}`,
      )
    } else if (run.reworkCount > 0) {
      // 重派后复检 PASS：done 带 reworked 旗标（正常 summary，无前缀）；既有栏不动。
      deliveryGate = { ok: true, missing: [], reworked: true }
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS (reworked)`)
    } else {
      // PASS 也留一行：证明闸门确实在跑（否则「零命中」无法与「未接线」区分）。
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS`)
    }
  }
  let qualityReviewPartial = run.machineCriticPass === true && status !== "ok"
  let qualityReviewMissing = "当前产物的实际感知回执"
  // 刀 2（2026-09-15）：机器 pass 的 critic run 终态处置。verdict 判读（保守：判不出＝退回）
  // 决定是否走既有 wakeParent 把判决送回父会话；判退回时 summary 前缀 CRITIC_REJECT_MARK，
  // orchestrator 据此依 playbook 第 16-18 条重派原 Expert 修正（原 Expert 若再失败，其自带
  // 的 rework 链硬帽 1 次仍然生效）。
  if (run.machineCriticPass === true && status === "ok") {
    // 2026-10-03（v3 接线）：闸门开启时，**先**对本 critic 所审交付取得 measured 样本，
    // 再与既有词表判读并成同一条「拒/过」决策。闸门未设＝不做任何 I/O、不 await，
    // 落到下方既有 fire-and-forget 旁路 → 行为与接线前逐位元组相同。
    // Read the actual independent child tool receipts; author prose cannot satisfy this gate.
    let criticMessages: unknown = []
    try {
      const response = await fetch(`${deps!.openCodeUrl}/session/${run.opencodeSessionId}/message`, {
        headers: deps!.openCodeHeaders(), signal: AbortSignal.timeout(10000),
      })
      if (response.ok) criticMessages = await response.json()
    } catch { /* missing perception remains PARTIAL */ }
    const receipt = checkCriticReceipt(run.criticReviewed ?? [], criticMessages)
    const reviewPartial = run.agent !== "critic" || !receipt.ok
    qualityReviewPartial = reviewPartial
    const missingTypes: string[] = []
    if (receipt.missing.some((item) => /\.(?:mp3|m4a|wav|aac|ogg|flac|opus)(?:[?#:]|$)/i.test(item))) missingTypes.push("音频听感检查回执")
    if (receipt.missing.some((item) => /\.(?:mp4|mov|mkv|webm)(?:[?#:]|$)/i.test(item))) missingTypes.push("视频开头相邻原帧与跨时段序列的实际感知回执")
    if (receipt.missing.some((item) => /\.(?:png|jpe?g|webp)(?:[?#:]|$)/i.test(item))) missingTypes.push("图片实际读图回执")
    if (missingTypes.length) qualityReviewMissing = missingTypes.join("、")
    const scoreEnforced = criticScoreEnforcementEnabled()
    let measured: MeasuredMediaResult | null = null
    if (scoreEnforced) measured = await measureReviewedMedia(run)
    // 既有决策（词表判读 criticVerdictRejected）＋新的数值阈值并入同一处：
    // 来源只在真有量测时才是 "measured"，无量测给 null → 恒不 enforce
    // （未知≠失败；model_self/human 非验收 oracle）。
    const forcedByScore = shouldForceCriticRejectByScore(
      { value: measured?.score ?? null, source: measured ? "measured" : null },
      scoreEnforced,
    )
    run.machineCriticRejected = reviewPartial || criticVerdictRejected(fullText) || forcedByScore
    if (forcedByScore) {
      console.warn(
        `[gateway] critic-score-gate: measured 技术分=${measured!.score} < ${CRITIC_SCORE_THRESHOLD_POLICY.reworkBelow} → 判退回（沿用既有重派链；critic_run=${run.id}）`,
      )
    }
    // 修 1（2026-10-02）：PASS 也以前缀标记判决方向，让 summary/emit/wake 三出口一致回灌。
    if (!run.machineCriticRejected) {
      summary = `${CRITIC_PASS_MARK}机器审核判定「通过」，无退回项（逐项核验见落盘全文）。\n${summary}`
      run.summary = summary
    }
    if (run.machineCriticRejected) {
      summary = reviewPartial
        ? `${CRITIC_REJECT_MARK}独立审核尚未完成真实感知：PARTIAL。缺少与被审runId/产物绑定的成功读取回执（${receipt.missing.join("、") || "未取得任何感知证据"}）。保留已交付作品，补齐可用感知通路再审；不要仅因缺审阅证据重派作者或重产。\n${summary}`
        : `${CRITIC_REJECT_MARK}独立审核发现具体问题，请定向修正后重新送审。\n${summary}`
      run.summary = summary
      console.warn(
        `[gateway] machine critic pass: verdict=REJECT — 送回父会话 session=${run.parentGatewaySessionId} critic_run=${run.id}`,
      )
    }
    // D7（2026-10-02）／v3（2026-10-03）：判决落库（此前 critic_passes 只有 session_id/created_at）。
    // 无量测 → score=null、source=model_self（同族模型自评，只作便宜筛子，永不通过数值阈值）。
    // 有量测 → score+source="measured"、judge_model=hardcheck/ffprobe（独立于被测模型的量测
    // 来源，才可被 evaluateCriticScoreThreshold enforce）。绝不填 0 假值、不从文字硬解析假分数。
    saveCriticVerdict({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      verdict: reviewPartial ? "unknown" : run.machineCriticRejected ? "reject" : "pass",
      score: measured?.score ?? null,
      scoreSource: measured ? "measured" : "model_self",
      judgeModel: measured
        ? "hardcheck/ffprobe"
        : (() => {
            const m = run.modelChain[run.attempt - 1]
            return m ? `${m.providerID}/${m.modelID}` : "opencode-default"
          })(),
      verdictText: reviewPartial
        ? `VERDICT: PARTIAL\n${JSON.stringify(receipt)}\n${fullText}`
        : `RECEIPT:${JSON.stringify(receipt)}\n${measured ? measured.detail + "\n" : ""}${fullText}`,
    })
    for (const target of run.criticReviewed ?? []) target.onReview?.({
      state: reviewPartial ? "partial" : run.machineCriticRejected ? "failed" : "passed", criticRunId: run.id, receipt,
    })
    if (run.machineCriticRejected && !reviewPartial) {
      saveExpertLesson({
        sessionId: run.parentGatewaySessionId,
        agent: run.agent ?? "critic",
        runId: run.id,
        source: "critic_reject",
        failureMode: "machine_critic_reject",
        detail: typeof fullText === "string" ? fullText : "",
      })
    }
    // 闸门关闭时维持既有 fire-and-forget 旁路：量测成功 → 以同一 runId 覆写上面的 model_self
    // 列（供观测）；失败不写。闸门开启时上面已 await 出 measured 并落库，此处不再重复量测/写入。
    if (!scoreEnforced && !reviewPartial) {
      void applyMeasuredMediaVerdict(run, `RECEIPT:${JSON.stringify(receipt)}\n${fullText}`)
    }
  }
  if (run.machineCriticPass === true && status !== "ok") {
    for (const target of run.criticReviewed ?? []) target.onReview?.({ state: "partial", criticRunId: run.id, receipt: { error: error ?? "独立审阅未完成" } })
  }
  // 刀 2（2026-09-15）：Expert 交付登记为待审对象（machine critic pass 的输入）。
  // 条件全成立才登记：正常终态（非孤儿路径）、ok、beast、agent 在契约域内、非 critic 自身
  // （critic run 不得再触发本 pass —— 防递归）。非 Expert／通用子代理零登记＝零回归。
  if (
    run.orphaned !== true && !run.recoveredWatcher &&
    status === "ok" &&
    run.beastMode === true &&
    typeof run.agent === "string" &&
    run.agent !== "critic" &&
    DELIVERY_CONTRACTS[run.agent] !== undefined
  ) {
    const list = pendingCriticTargets.get(run.parentGatewaySessionId) ?? []
    const artifacts = run.artifacts.map((item) => item.url)
    const mediaIntent: NonNullable<CriticPassTarget["mediaIntent"]> = []
    // Bind submitted author runId to successful output receipts (images are not emitted as parent cards).
    try {
      const response = await fetch(`${deps!.openCodeUrl}/session/${run.opencodeSessionId}/message`, {
        headers: deps!.openCodeHeaders(), signal: AbortSignal.timeout(10000),
      })
      const messages: any = response.ok ? await response.json() : []
      for (const msg of Array.isArray(messages) ? messages : []) for (const part of msg?.parts ?? []) {
        if (part?.type !== "tool" || part.state?.status !== "completed") continue
        const output = parseToolOutput(part.state.output)
        if (output?.ok !== true) continue
        const mediaBag = toolOutputMediaBag(output)
        if (msg?.info?.role === "assistant" && ["image_generate", "last_frame_video_chain", "video_generate"].includes(part.tool)) {
          const input = part.state.input ?? {}
          let shots: any[] = []
          try { shots = typeof input.shots === "string" ? JSON.parse(input.shots) : [] } catch { /* unavailable stays unknown */ }
          for (const [index, item] of mediaBag.shots.entries()) {
            const shot = item as { submit_body?: any; job_id?: unknown; task_id?: unknown }
            const submitted = shot?.submit_body ?? shots[index] ?? input
            const taskId = shot?.job_id ?? shot?.task_id ?? mediaBag.task_id
            const urls = collectToolOutputMediaUrls(item).video.map((entry) => entry.url)
            if (taskId) urls.push(...run.artifacts.filter((entry) => entry.task_id === taskId).map((entry) => entry.url))
            for (const artifact of new Set(urls)) mediaIntent.push({ artifact,
              ...(typeof submitted.prompt === "string" ? { prompt: submitted.prompt } : {}),
              ...(submitted.camera ?? submitted.cam ? { camera: submitted.camera ?? submitted.cam } : {}),
              ...(typeof submitted.duration_seconds === "number" ? { durationSeconds: submitted.duration_seconds } : {}),
              sourceCallId: part.callID,
            })
          }
        }
        const media = collectToolOutputMediaUrls(output)
        artifacts.push(...media.audio.map((a) => a.url), ...media.video.map((a) => a.url))
        for (const item of [output, mediaBag.result, ...mediaBag.images, ...mediaBag.results]) {
          if (item && typeof item === "object") for (const key of ["url", "image_url", "output_url", "file_url"]) {
            const value = (item as Record<string, unknown>)[key]
            if (typeof value === "string" && /^https?:\/\//.test(value)) artifacts.push(value)
          }
        }
      }
    } catch { /* no actual author receipt: critic cannot quality-pass the claim */ }
    list.push({ agent: run.agent, label: run.label, runId: run.id, text: typeof fullText === "string" ? fullText : "", artifacts: [...new Set(artifacts)], mediaIntent })
    // 有界：只留最近 CRITIC_PENDING_CAP 份（机器 pass 一次最多送审 CRITIC_PASS_MAX_TARGETS）。
    if (list.length > CRITIC_PENDING_CAP) list.splice(0, list.length - CRITIC_PENDING_CAP)
    pendingCriticTargets.set(run.parentGatewaySessionId, list)
  }

  // 2026-10-04 F6：done 摘要从**源头**改为用户可读——内部落盘指针、契约栏名（verdict/issues/
  // evidence/qc）、审核身份与 runId、内审判词与编号审稿正文、用量计数一律剥离。三个出口
  // （subagent.done 帧 / completed 取件 / wakeParent 唤醒）本来共用同一 summary 变数，这里
  // 换成清洗后的版本即三处同时干净；咽喉点（sse-core.emitToSession）与唤醒路径（index.ts）
  // 复用同一纯函数做下游兜底，此处是让出口天生干净的第一层。
  const visibleSummary = qualityReviewPartial
    ? `作品已保留，质量检查尚未完成，缺少${qualityReviewMissing}；补齐这些检查后继续，当前无需重新制作。`
    : scrubSubagentPayload(summary)
  run.summary = visibleSummary
  // Durable terminal/outbox must commit before releasing the watcher or dispatching queued work.
  deleteReworkRecord(run.id) // 刀 F：终态即清持久记录（幂等；非 rework run 无记录=no-op）
  // X7/C4（2026-10-14）：自然终态（ok/error，含 soft 收尾）进入**接续窗口**——子会话刻意
  // 不 DELETE（见下方 cleanup 守卫），run 挂进 resumable 索引，父会话在窗口内发消息即可
  // 复活续跑（Y4「给已完成子代理发消息即后台续跑」）。hard stop／孤儿不设（那些 run 由
  // stopSubagentRun／recoveredWatcher 各自清理，语义不动）。
  const resumableTtl = subagentResumeTtlMs()
  // 接续窗口只对本 run 开：子会话 id 合法（否则续跑无对象）、且不是孤儿／接管 run
  // （那两类由各自路径清理，行为不动）。
  const resumeOpen = run.orphaned !== true && !run.recoveredWatcher && isOpenCodeSessionId(run.opencodeSessionId)
  run.resumeUntil = resumeOpen ? Date.now() + resumableTtl : undefined
  run.livePath = writeLiveLog(run, true) ?? run.livePath
  const durableResult = {
    status,
    summary: visibleSummary,
    error,
    finishedAt: Date.now(),
    label: run.label,
    parent: run.parentGatewaySessionId,
    researchTask: run.researchTask,
    researchRelPath: run.researchTask && !run.partialPersist ? persist.relPath : undefined,
    artifacts: run.artifacts?.length ? run.artifacts : undefined,
    // ── 协作总线新增栏位（只增不改既有键）──
    childPath: run.childPath,
    startedAt: run.startedAt,
    ...(softStop ? { reason: softStop.reason } : {}),
    artifactPath: persist.relPath,
    transcriptPath: run.livePath,
    ...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}),
    ...(resumeOpen ? { resumable: true, resumeUntil: run.resumeUntil } : {}),
    ...(run.lastCheckpoint ? { lastCheckpoint: run.lastCheckpoint } : {}),
    checkpointsCount: run.checkpoints?.length ?? 0,
    ...(run.fromCheckpoint ? { fromCheckpoint: run.fromCheckpoint } : {}),
    // CC 2.1.302 结果契约：usage 与 name/fork 进 durable/completed，status 与完成通知
    // 由同一记录取件（唯一真源，不另算一份）。
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.name ? { name: run.name } : {}),
    ...(run.isFork ? { is_fork: true } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    ...(run.variantApplied !== undefined ? { variant_applied: run.variantApplied } : {}),
  }
  try { saveDurableSubagentRun({ ...run, fullText }, durableResult) }
  catch (saveError) {
    noteDurableTerminalRetry(run.id)
    console.error("[gateway] durable subagent terminal save failed; releasing slot:", run.id, saveError)
  }
  removeFromRegistries(run)
  // CC 2.1.302 SubagentStop：终态（ok/error）唯一收尾点，fire-and-forget。
  fireSubagentHook("SubagentStop", run, {
    status,
    ...(error !== undefined ? { error: error.slice(0, 2000) } : {}),
  })
  // 接续索引登记：终态但仍在窗口内 ⇒ 子会话保留、可被 subagent_message 复活续跑。
  if (resumeOpen) {
    resumable.set(run.id, run)
    boundMap(resumable, 500)
  }
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  checkPendingResumeQueue(run.parentGatewaySessionId)
  completed.set(run.id, durableResult)
  // WP2（2026-10-14）：终态落点（finishRun 单一路径）——叫醒该 run 的长挂起 waiter。
  notify(`subagent:${run.parentGatewaySessionId}:${run.id}`)
  // CC 2.1.302 移植：目标验收 run 的终态回调（只此一处，finishRun 幂等守卫保证一次）。
  if (typeof run.goalEvaluator === "function") {
    const onTerminal = run.goalEvaluator
    run.goalEvaluator = undefined
    try {
      onTerminal({ status, text: fullText, error })
    } catch (e) {
      console.error(`[gateway] goal evaluator terminal callback failed: id=${run.id}`, e)
    }
  }
  // D7（2026-10-02）：交付事件落库——重问率＝同 (session, agent, label) 再次交付的比例。
  if (status === "ok" && (run.agent || run.researchTask) && !run.partialPersist) {
    saveDelivery({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.researchTask ? "research" : run.agent,
      label: run.label,
      relPath: persist.relPath,
      contractOk: deliveryGate ? deliveryGate.ok : undefined,
    })
  }
  const state = parentStateOf(run)
  if (state) {
    deps!.emitToSession(state, "subagent.done", {
      id: run.id,
      status,
      summary: visibleSummary,
      ...(run.name ? { name: run.name } : {}),
      ...(run.isFork ? { fork: true } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
      ...(run.variantApplied !== undefined ? { variant_applied: run.variantApplied } : {}),
      // 片 C（2026-09-15）：新增栏位，不动既有 id/status/summary 语义；ok 时不加。
      ...(deliveryGate ? { delivery_gate: deliveryGate } : {}),
      // 2026-10-02 能力片：用量计数（仅 summarizeChild 路径有值；新栏位，不动既有键）。
      ...(run.usage ? { usage: run.usage } : {}),
      // 2026-10-14 协作总线（C3）：soft 收尾的新栏位（谁请它收尾＋原因）；非 soft 时零注入。
      ...(softStop ? { soft_stopped: true, stopped_by: softStop.by, reason: softStop.reason } : {}),
    })
    appendTranscriptEnd(run, status, visibleSummary)
    // G3（2026-10-10）：用户默认面要「本路刚完成／失败」人话摘要——走 turn.status，
    // 禁止 message.delta。run 已从注册表摘除；若仍有兄弟在跑，同一帧带上剩余路数
    // （避免先写完成句再立刻被 emitRunningSubagentsStatus 覆盖而看不见）。
    emitSubagentCompletedStatus(run, status)
    // R6 异步完成唤醒：async dispatch 的终态（成功与失败皆唤）在 emit 帧之外
    // 直接续父会话 turn（轮子=deps.wakeParent）。finishRun 幂等守卫保唤醒不重复；
    // deps.wakeParent 内部再带 ackTimer 在途让位，双保险。同步模式不唤（工具还在
    // 轮询取件，唤醒反而插话）。
    // FIX-G5（2026-10-14）：本块自 HEAD 复位。工作树曾把它删掉、改托付 job-store 耐久 receipt
    // → job-delivery.ts 投递；而 job-delivery 未随本次发布（另一会话未上线功能）⇒ 会静默
    // 丢失「完成」送达。此处走回生产已验证的直接唤醒通路；耐久 receipt 仍照写（供 status/
    // resume 查询），只是不再由它负责唤醒。
    // 注：HEAD 在本函数开头有 `const asyncMode = run.asyncMode === true`（本工作树一并删除），
    // 复位时改为就地读取 run.asyncMode，保持「只改这一处」。
    if (run.asyncMode === true && run.isFork) {
      // D7：fork 的完成/失败结果回到**发起 fork 的子代理会话**（requester），不是主会话。
      // 走既有 deliverChildTurn（与 dispatchAttempt 同一条 prompt_async 轮廓），不新造通路。
      const requester = run.forkRequesterRunId ? findRunById(run.forkRequesterRunId) : undefined
      const route = forkResultDeliveryTarget(requester)
      if (route === "requester" && requester && byChildOc.get(requester.opencodeSessionId) === requester) {
        const label = userFacingSubagentLabel(run.label)
        const content =
          `【fork 完成·系统自动唤醒】你发起的 fork「${label}」（${run.id.slice(0, 8)}）已结束：status=${status}。\n\n` +
          `${visibleSummary}${error ? `\n\n错误：${error}` : ""}\n\n` +
          `这是你这条 fork 的结果，继续你手上的任务；它不是用户授权，也不代表整项任务完成。`
        void deliverChildTurn(requester, content, "fork_done", true)
        console.log(
          `[gateway] fork result delivered to requester: fork=${run.id} requester=${requester.id} child=${requester.opencodeSessionId} status=${status}`,
        )
      } else if (typeof deps!.wakeParent === "function") {
        // P1（2026-10-18）：requester 已终态/已停止/会话已回收——结果不得静默投进无人消费的
        // 旧会话（prompt_async 会起一轮没人收的 turn，且父会话永远等不到结果）。回落主会话并
        // 记录事实，主会话据此决定是否重派或继续。
        const label = userFacingSubagentLabel(run.label)
        try {
          deps!.wakeParent(state, {
            id: run.id,
            label: run.label,
            status,
            summary:
              `【fork 结果回落】发起这条 fork 的子代理已结束或不可投递（requester=${run.forkRequesterRunId ?? "-"}），结果回落到主会话。fork「${label}」（${run.id.slice(0, 8)}）status=${status}。\n\n${visibleSummary}`,
            error,
            artifacts: run.artifacts,
          })
        } catch (e) {
          console.error(`[gateway] fork fallback wake failed: id=${run.id}`, e)
        }
        console.warn(
          `[gateway] fork result fell back to parent session (requester not live): fork=${run.id} requester=${run.forkRequesterRunId ?? "-"} requester_found=${requester ? requester.status : "gone"} status=${status}`,
        )
      } else {
        console.warn(
          `[gateway] fork result not delivered (requester gone/stopped, no wakeParent): fork=${run.id} requester=${run.forkRequesterRunId ?? "-"} status=${status}`,
        )
      }
    } else if (run.asyncMode === true && run.machineCriticPass === true) {
      // 修 1（2026-10-02）：verdict（PASS 与 REJECT）一律以正常完成仪式回灌父会话——
      // PASS 不再只写 journal（实锤：判决从未送达，orchestrator 两小时后手动 read 才发现）。
      try {
        deps!.wakeParent(state, { id: run.id, label: run.label, status, summary: visibleSummary, error, artifacts: run.artifacts })
      } catch (e) {
        console.error(`[gateway] subagent wake failed: id=${run.id}`, e)
      }
      console.log(
        `[gateway] machine critic pass: verdict=${run.machineCriticRejected ? "REJECT" : "PASS"} — 回灌父会话 session=${run.parentGatewaySessionId} critic_run=${run.id}`,
      )
    } else if (run.asyncMode === true) {
      try {
        deps!.wakeParent(state, {
          id: run.id,
          label: run.label,
          status,
          summary: visibleSummary,
          error,
          artifacts: run.artifacts,
        })
      } catch (e) {
        console.error(`[gateway] subagent wake failed: id=${run.id}`, e)
      }
    }
  }
  console.log(
    `[gateway] subagent done: id=${run.id} label="${run.label}" parent=${run.parentGatewaySessionId} status=${status}`,
  )
  // 防堆积：best-effort abort（硬顶路径 turn 可能还在跑）+ DELETE 子会话。
  // E 片（2026-09-12）缺陷二防御：拼 URL 前先验 ses 前缀，不符跳过并记一行日志。
  // X7（2026-10-14）：仍在接续窗口内的 run **不** DELETE——子会话与它的完整历史要留给
  // 续跑（Y4/Y3：同一会话续跑才叫「不重派」）；到期由 livenessTick 回收。窗口外＝原行为。
  if (deps && !run.recoveredWatcher && run.resumeUntil === undefined) {
    if (isOpenCodeSessionId(run.opencodeSessionId)) {
      const abortUrl = `${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`
      void fetch(abortUrl, { method: "POST", headers: deps.openCodeHeaders(), signal: AbortSignal.timeout(5000) }).catch(
        () => {},
      )
      void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
        method: "DELETE",
        headers: deps.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    } else {
      console.error(
        `[gateway] subagent cleanup skipped: id=${run.id} label="${run.label}" reason=invalid opencode session id "${String(run.opencodeSessionId)}"`,
      )
    }
  }
}

/**
 * 片 D（2026-09-15）：交付闸门 FAIL 后的机器化重派（bounded auto-rework，上限 1 次）。
 * **轮子复用**：与 retryWithNextModel 同范式——新子会话一律走 dispatchAttempt（内部
 * 自动继承宪法头注入、modelChain 当前模型、run.agent Expert 栏），禁自造第二套派遣逻辑。
 * 注入语义：run.prompt 尾部**追加**系统性修正指令（buildReworkDirective 逐字点名缺栏），
 * 原任务内容原样带过去；agent/beastMode/asyncMode 语义全部不动。
 * 计时器：重派＝新的完整硬顶预算（拆旧装新）——不重装则长任务剩余预算≈0，重派段必然
 * 撞硬顶转 status=error，把「重派后仍未达标」的诚实标记路径抢先污染成超时错误。
 * 同步 deadlineTimer 不动：其「主会话放行转后台」语义属首轮工具侧契约，重派段沿用。
 * 投递失败：孤儿会话 best-effort 清理、run 位回旧会话、记 reworkFailure，再进 finishRun
 * 回退到片 C 标记放行（不伪称 reworked、不动 status）。
 */
async function startRework(run: SubagentRun, verdict: DeliveryGateResult, firstText: string): Promise<void> {
  if (!deps) return
  const oldChild = run.opencodeSessionId
  // D11：重派是新的完整 attempt——旧 attempt 的 usage 必须清掉，否则终态会回带首轮数字。
  run.usage = undefined
  // D6：childPath／parentSubagentId（深度来源）原样保留；重派不是「回到根层」。
  run.prompt = `${run.prompt}\n\n---\n\n${buildReworkDirective(run.agent ?? "", verdict, DELIVERY_CONTRACTS)}`
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  const hardMs = run.asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout in rework (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3：重派段逾时同样先落盘 partial。
    run.partialPersist = true
    run.reworking = false
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：重派段同样有心跳／逾时前部分交付。
  armHeartbeat(run, hardMs)
  const failure = await dispatchAttempt(run)
  if (failure) {
    run.reworking = false
    // dispatchAttempt 可能已建的新会话（prompt_async 失败路径已摘 byChildOc 映射）：
    // best-effort 删掉孤儿，再把 run 的子会话位回拨到旧会话，让收尾清理对准真身。
    if (isOpenCodeSessionId(run.opencodeSessionId) && run.opencodeSessionId !== oldChild) {
      void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
        method: "DELETE",
        headers: deps.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    run.opencodeSessionId = oldChild
    run.reworkFailure = failure
    console.error(`[gateway] delivery gate: id=${run.id} agent=${run.agent} REWORK dispatch failed: ${failure}`)
    finishRun(run, "ok", firstText)
    return
  }
  // 新会话注册成功后才摘旧映射（先立后破：run.id 在 status 端点的 byChildOc 视图无空窗）。
  if (oldChild && byChildOc.get(oldChild) === run) byChildOc.delete(oldChild)
  if (isOpenCodeSessionId(oldChild)) {
    void fetch(`${deps.openCodeUrl}/session/${oldChild}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    void fetch(`${deps.openCodeUrl}/session/${oldChild}`, {
      method: "DELETE",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  run.reworking = false
  // 刀 F（2026-09-15）：重派子会话注册成功＝孤儿风险窗口开启，落一条持久记录；终态由
  // finishRun 清除。启动扫描据 child_oc 探 opencode，判断续检还是诚实治理。
  saveReworkRecord({
    runId: run.id,
    parentGw: run.parentGatewaySessionId,
    parentOc: run.parentOpencodeSessionId,
    childOc: run.opencodeSessionId,
    agent: run.agent ?? "",
    label: run.label,
    beast: run.beastMode === true,
    asyncMode: run.asyncMode === true,
    reworkCount: run.reworkCount,
  })
  console.log(
    `[gateway] delivery gate: id=${run.id} agent=${run.agent} REWORK dispatched (attempt=1) child=${run.opencodeSessionId} missing=${verdict.missing.join(",")}`,
  )
}

/** D5（2026-10-02）：心跳与逾时前部分交付。
 *  证据：硬逾时 22 次、会话实录「40 分钟无任何存活讯号」、中止即全丢（REPORT A8）。
 *  心跳间隔（60s）无文献依据，属待调参数（MCP progress / A2A 任务状态机为机制类别依据）。
 *  心跳不得抛错、不得改变 run 状态；计时器 unref，不阻挡进程退出。
 *  F3（2026-10-10）：首跳立即发一帧（setInterval 首跳要等整段间隔）；父 turn.done
 *  清前端 turnStatus 后由 emitRunningSubagentsStatus 立刻回填，避免 async await 真空。 */
function emitSubagentHeartbeatStatus(run: SubagentRun): void {
  if (run.status !== "running" || run.stopped) return
  const state = deps?.resolveSession(run.parentGatewaySessionId) ?? deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  if (!state) return
  const elapsed = Math.round((Date.now() - run.startedAt) / 1000)
  try {
    // 2026-10-04 F4：心跳不得夹带子代理内部交付正文——契约栏名清单（verdict/issues/
    // evidence/qc）、「FAILED＋原因」、闸门核对说明会随 snippet 逐字外泄给用户。
    // 只留用户可读的状态句；标签经用户可见映射（「机器审核」→「复核」）。
    const label = userFacingSubagentLabel(run.label)
    // 2026-10-19：终端命令零输出静默时，心跳必须说人话而不是「仍在运行」——
    // 否则用户看到的就是「运行中」永动机（实测 6 分钟零输出的挂住管道）。
    const hung = oldestPendingTool(run, Date.now())
    const stuckShell = hung && isShellTool(hung.name) && hung.silentMs >= 120_000
    const text = stuckShell
      ? `子代理「${label}」的终端命令已 ${Math.round(hung!.silentMs / 1000)} 秒没有输出，可能在等输入或卡住；3 分钟没有起色会自动终止`
      : elapsed < 5
        ? `子代理「${label}」进行中…`
        : `子代理「${label}」仍在运行（已 ${elapsed}s）`
    deps?.emitToSession(state, "turn.status", { text })
  } catch {
    /* 心跳失败不影响主流程 */
  }
}

/**
 * F3（2026-10-10）：父回合 turn.done 之后，若仍有在途子代理，立刻补一帧 turn.status。
 * 前端 turn.done 会清 turnStatus；不补则 await 窗最长静默一整段心跳间隔。
 * 多路在跑时单行展示最老一路＋总数（前端 turnStatus 是单值）。
 */
export function emitRunningSubagentsStatus(parentGatewaySessionId: string): void {
  if (!parentGatewaySessionId || !deps) return
  const list = (byParent.get(parentGatewaySessionId) ?? []).filter((r) => r.status === "running" && !r.stopped)
  if (list.length === 0) return
  const oldest = list.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
  if (list.length === 1) {
    emitSubagentHeartbeatStatus(oldest)
    return
  }
  const state =
    deps.resolveSession(parentGatewaySessionId) ?? deps.findSessionByOpenCodeId(oldest.parentOpencodeSessionId)
  if (!state) return
  const elapsed = Math.round((Date.now() - oldest.startedAt) / 1000)
  const label = userFacingSubagentLabel(oldest.label)
  try {
    deps.emitToSession(state, "turn.status", {
      text: `${list.length} 个子代理仍在运行（「${label}」已 ${elapsed}s）`,
    })
  } catch {
    /* 心跳失败不影响主流程 */
  }
}

/**
 * G3（2026-10-10）：子代理终态人话摘要 → turn.status。
 * 复用既有暂态合同；不走 message.delta（对齐 turn-status-transient-row 污染根治）。
 * 调用时机：finishRun 已 emit subagent.done、且本 run 已从 byParent 摘除之后。
 * 若仍有兄弟在跑，单行合并「本路刚完成／失败」＋剩余路数，避免完成句被立刻覆盖。
 */
export function emitSubagentCompletedStatus(run: SubagentRun, status: "ok" | "error" | "stopped"): void {
  if (!deps) return
  const state =
    deps.resolveSession(run.parentGatewaySessionId) ?? deps.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  if (!state) return
  const label = userFacingSubagentLabel(run.label)
  const doneText =
    status === "ok"
      ? `本路刚完成：「${label}」`
      : status === "error"
        ? `本路失败：「${label}」`
        : `本路已停止：「${label}」`
  const list = (byParent.get(run.parentGatewaySessionId) ?? []).filter((r) => r.status === "running" && !r.stopped)
  try {
    if (list.length === 0) {
      deps.emitToSession(state, "turn.status", { text: doneText })
      return
    }
    const oldest = list.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
    const elapsed = Math.round((Date.now() - oldest.startedAt) / 1000)
    const oldestLabel = userFacingSubagentLabel(oldest.label)
    const rem =
      list.length === 1
        ? `「${oldestLabel}」仍在运行（已 ${elapsed}s）`
        : `${list.length} 个子代理仍在运行（「${oldestLabel}」已 ${elapsed}s）`
    deps.emitToSession(state, "turn.status", { text: `${doneText}；${rem}` })
  } catch {
    /* 摘要失败不影响主流程 */
  }
}

export function armHeartbeat(run: SubagentRun, hardMs: number): void {
  const hbMs = Number.parseInt(process.env.SUBAGENT_HEARTBEAT_MS || "", 10) || 60_000
  const earlyMs = Number.parseInt(process.env.SUBAGENT_EARLY_PARTIAL_MS || "", 10) || 120_000
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer)
  if (run.earlyPartialTimer) clearTimeout(run.earlyPartialTimer)
  // F3：立即一帧，再进入周期；否则派工后／turn.done 后最长空窗 = hbMs。
  emitSubagentHeartbeatStatus(run)
  run.heartbeatTimer = setInterval(() => {
    emitSubagentHeartbeatStatus(run)
  }, hbMs)
  unrefTimer(run.heartbeatTimer)
  if (hardMs > earlyMs + 30_000) {
    run.earlyPartialTimer = setTimeout(() => {
      if (run.status !== "running" || run.stopped) return
      const body = partialBodyOf(run)
      if (!body.trim()) return
      // 早于硬顶落盘快照，不改变 run 状态；run 真完成时 finishRun 以全文覆写同一档。
      persistRunOutput(run, "timeout", body, "（逾时前部分产物快照；run 仍在续跑，完成后覆写同一档）", true)
      console.warn(`[gateway] subagent early partial persisted: id=${run.id} label="${run.label}" chars=${body.length}`)
    }, hardMs - earlyMs)
    unrefTimer(run.earlyPartialTimer)
  }
}

