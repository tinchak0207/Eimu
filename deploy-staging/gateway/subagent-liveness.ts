import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { computeSubagentUsage, runMessageWindow, SubagentUsageMessage } from "./subagent-policy.ts"
import type { SubagentUsage, SubagentRun, PersistOutcome } from "./subagent-types.ts"
import { subagentToolMaxMs, subagentShellSilentMs, isShellTool, subagentStaleMs, subagentLivenessPollMs, SUBAGENT_STALE_MESSAGE, SUBAGENT_OUTPUT_REL, SUBAGENT_OUTPUT_DIR, PERSIST_TAIL, evaluateRunLiveness, safeLabelForFile, userFacingSubagentLabel, partialBodyOf, unrefTimer, isOpenCodeSessionId, lastAssistantTextWithFallback } from "./subagent-types.ts"
import { deps, byParent, byChildOc, resumable, parentStateOf } from "./subagent-runs.ts"
import { finishRun } from "./subagent-finish.ts"
import { retryWithNextModel } from "./subagent-attempt.ts"
import { pushParentNote } from "./subagent-live.ts"

// ── F8（2026-10-04）断面 B：async 子代理活性看门狗 ────────────────────────────
// 单一定时器扫全部在跑 run（刻意不用 per-run 计时器——避免与既有 timeout/heartbeat/
// earlyPartial 计时器的生命周期互相牵连）；unref，不阻挡进程退出；finishRun 的
// status 幂等守卫保证不会与硬顶/收尾路径双终态。
// 命中 stale 的处置：走既有 finishRun(error) → subagent.done + wakeParent（唤醒文案过
// 用户可见白名单 scrubSubagentPayload），父会话据此收束/重派。
let livenessTimer: ReturnType<typeof setInterval> | undefined

export function startLivenessWatch(): void {
  if (livenessTimer) return
  livenessTimer = setInterval(livenessTick, subagentLivenessPollMs())
  unrefTimer(livenessTimer)
}

/** 在途工具里最早开始、且仍在途的那一个（timeout 判断用）。 */
export function oldestPendingTool(
  run: SubagentRun,
  now: number,
): { callId: string; ageMs: number; name: string; silentMs: number } | null {
  const since = run.pendingToolSince
  if (!since || since.size === 0) return null
  let best: { callId: string; ageMs: number; name: string; silentMs: number } | null = null
  for (const [callId, at] of since) {
    if (!run.pendingTools.has(callId)) { since.delete(callId); run.pendingToolInfo?.delete(callId); continue } // 已摘除的残留
    const info = run.pendingToolInfo?.get(callId)
    const lastOut = info?.outAt || at
    const cand = { callId, ageMs: now - at, name: info?.name ?? "", silentMs: now - lastOut }
    if (!best || cand.ageMs > best.ageMs) best = cand
  }
  return best
}

function livenessTick(): void {
  const staleMs = subagentStaleMs()
  const now = Date.now()
  // 快照遍历：finishRun 会同步/异步改动 byParent，先拷贝一份防迭代期增删。
  const runs: SubagentRun[] = []
  for (const list of byParent.values()) for (const r of list) runs.push(r)
  for (const run of runs) {
    if (run.status !== "running") continue
    // 单工具挂住（2026-10-18）：有在途工具时下面的失活检测会整体放行，这里按**工具时长**
    // 补一条硬线——一条永不返回的命令不能在「正常运行」的名义下拖满 30 分钟。
    // 2026-10-19：这条对 recoveredWatcher 同样生效——重启接管重建的 run 此前整体跳过
    // 活性检查（交给 status 对账），实测「命令已结束但 part 仍是 running」时对账永远等，
    // 用户侧就是永久「终端命令 运行中」。
    const hungTool = oldestPendingTool(run, now)
    if (hungTool) {
      // 终端类：零输出静默 3 分钟即判死（有输出会刷新 silentMs，长构建/转码不受影响）。
      // 其他工具（含媒体生成）：沿用 10 分钟上限，防误杀合法长任务。
      const shellHung = isShellTool(hungTool.name) && hungTool.silentMs >= subagentShellSilentMs()
      const anyHung = hungTool.ageMs >= subagentToolMaxMs()
      if (shellHung || anyHung) {
        const why = shellHung
          ? `终端命令「${hungTool.name || "bash"}」已 ${Math.round(hungTool.silentMs / 1000)} 秒没有任何输出（可能在等输入或管道被挂住）`
          : `工具「${hungTool.name || "未知"}」已运行 ${Math.round(hungTool.ageMs / 60000)} 分钟没有返回`
        console.warn(
          `[gateway] subagent tool hung ${Math.round((shellHung ? hungTool.silentMs : hungTool.ageMs) / 1000)}s: id=${run.id} label="${run.label}" tool=${hungTool.name || run.lastToolName || "-"} call=${hungTool.callId.slice(0, 16)}`,
        )
        run.partialPersist = true
        void finishRun(run, "error", partialBodyOf(run), `${why}，已强制结束；已产出的部分已保留。`)
        continue
      }
    }
    if (run.recoveredWatcher) continue // 重建的 watcher 不做「无活动」判定（对账负责），但上面的工具硬线已生效
    const verdict = evaluateRunLiveness({
      status: run.status,
      stopped: run.stopped,
      asyncMode: run.asyncMode === true,
      reworking: run.reworking === true,
      now,
      lastActivityAt: run.lastActivityAt,
      pendingToolCount: run.pendingTools.size,
      staleMs,
    })
    if (!verdict.stale) continue
    const silentS = Math.round((now - run.lastActivityAt) / 1000)
    console.warn(
      `[gateway] subagent stale detected (no child activity ${silentS}s, no in-flight tool): id=${run.id} label="${run.label}" child=${run.opencodeSessionId}`,
    )
    // 逾时先落盘已累积的 partial（同一行为与硬顶路径一致），再 error 收尾。
    run.partialPersist = true
    void finishRun(run, "error", partialBodyOf(run), SUBAGENT_STALE_MESSAGE)
  }
  // ── 2026-10-14 协作总线：接续窗口（X7）与阻塞式提问（X5）的到期回收 ──────────────
  // 顺手做在同一个 tick 上（单一定时器，unref）：不新增计时器生命周期，不与既有
  // timeout/heartbeat/earlyPartial 互相牵连。
  for (const [id, run] of resumable) {
    if ((run.resumeUntil ?? 0) > now) continue
    // G5(a)（2026-10-14 竞态修复）：回收**删子会话之前**先看该子会话是否已被别的在途 run
    // 接手（resume 投递的 await 窗内，新 run 已认领同一 opencode 会话）。是 ⇒ 只清本 run 的
    // 接续记账，绝不 DELETE 子会话（否则新 run 永无事件 → 孤儿）。用 continue 跳过 DELETE。
    const holder = byChildOc.get(run.opencodeSessionId)
    if (holder && holder !== run) {
      resumable.delete(id)
      run.resumeUntil = undefined
      console.log(`[gateway] subagent resume window expired (session held by live run, kept): id=${run.id} label="${run.label}"`)
      continue
    }
    resumable.delete(id)
    run.resumeUntil = undefined
    // 窗口到期：子会话立即 DELETE（防堆积），与 hard stop 同款清理；已完成记录留给
    // status 查询（completed 有自身 TTL），不再可续（诚实：过窗即不可续，不假称可续）。
    if (deps && isOpenCodeSessionId(run.opencodeSessionId)) {
      void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
        method: "DELETE",
        headers: deps.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    console.log(`[gateway] subagent resume window expired: id=${run.id} label="${run.label}" — 子会话已回收`)
  }
  // G9(c)（2026-10-14 修复）：提问到期消解同时覆盖**已终态但在接续窗口内的** resumable run
  // （旧版只遍历 byParent 的在途 run → 落在终态 run 上的提问永不消解）。按 run id 去重。
  const questionRuns: SubagentRun[] = [...runs]
  const questionSeen = new Set(questionRuns.map((r) => r.id))
  for (const run of resumable.values()) {
    if (questionSeen.has(run.id)) continue
    questionSeen.add(run.id)
    questionRuns.push(run)
  }
  for (const run of questionRuns) {
    if (!run.pendingQuestions?.length) continue
    // Y2（2026-10-14）v1：**不做超时自动答**——到期只如实消解（ElicitationAbandoned 等价物），
    // 并把「问题未答」写回父会话（不伪造答案、不静默丢弃）。
    for (const q of [...run.pendingQuestions]) {
      if (q.resolve_by > now) continue
      run.pendingQuestions = run.pendingQuestions.filter((x) => x.id !== q.id)
      pushParentNote(run, "question_abandoned", `超时未答（问题已消解，未获得答案）：${q.text || q.header}`)
      const state = parentStateOf(run)
      if (state && deps) {
        try {
          deps.emitToSession(state, "subagent.note", { id: run.id, kind: "question_abandoned", text: `「${userFacingSubagentLabel(run.label)}」的提问超时未答，已消解（未获得答案，不代答）。` })
        } catch {
          /* 消解帧失败不影响主流程 */
        }
      }
    }
  }
}

export function persistRunOutput(
  run: SubagentRun,
  status: "ok" | "error" | "timeout",
  body: string,
  errorText?: string,
  forcePartial = false,
): PersistOutcome {
  const text = typeof body === "string" && body.trim().length > 0 ? body : ""
  const death = typeof errorText === "string" && errorText.trim().length > 0 ? errorText : ""
  const content = text || death || "（无正文产出，且无死因文本）"
  const fileName = `${run.id}-${safeLabelForFile(run.label)}.md`
  const rel = `${SUBAGENT_OUTPUT_REL}/${fileName}`
  try {
    mkdirSync(SUBAGENT_OUTPUT_DIR, { recursive: true })
    const model = run.modelChain[run.attempt - 1]
    // 修 3：partial 落盘时「状态」标 partial（档名规则与终态一致）。
    const effStatus = forcePartial || run.partialPersist ? "partial" : status
    const meta = [
      `# ${run.label}`,
      "",
      `- runId: \`${run.id}\``,
      `- 状态: ${effStatus}`,
      `- 模型: ${model ? `${model.providerID}/${model.modelID}` : "opencode-default"}（attempt ${run.attempt}/${Math.max(run.modelChain.length, 1)}）`,
      `- 耗时: ${Math.round((Date.now() - run.startedAt) / 1000)}s（起 ${new Date(run.startedAt).toISOString()}）`,
      `- 子代理会话: ${run.opencodeSessionId || "-"}`,
      `- 内容: ${text ? "子代理最后一条 assistant 文本全文" : "无正文产出，以下为死因事实（未伪造）"}`,
      "",
    ].join("\n")
    const abs = join(SUBAGENT_OUTPUT_DIR, fileName)
    writeFileSync(abs, `${meta}${content}\n\n---\n\n${PERSIST_TAIL}\n`, { encoding: "utf8", mode: 0o640 })
    try {
      chmodSync(abs, 0o640) // FIX-G6b（2026-10-14）：640＝属主 ubuntu rw ＋ 组 agentsvc r。父会话的 opencode 以 agentsvc 身份运行（`systemctl show opencode-server -p User`＝agentsvc），且目录 setgid 使新档继承组 agentsvc——唤醒/状态回执把 artifact_path 交给它去 read，故必须让**该读的人读得回**；旧 600 会让它 PermissionDenied（生产实测）。同时不对 world 开放，比生产原有 644 更严，安全意图不退化。
    } catch {
      /* chmod 失败不影响可读性（mode 已带） */
    }
    const pointer = run.partialPersist
      ? `[部分结果已落盘（partial）：${rel}（${content.length} 字）] `
      : `[完整结果已落盘：${rel}（${content.length} 字）] `
    return { pointer, relPath: rel, chars: content.length }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error(`[gateway] subagent persist failed: id=${run.id} label="${run.label}" reason=${reason}`)
    return { pointer: `[完整结果落盘失败：${reason}] `, chars: 0, failed: reason }
  }
}

/** 终态补 usage 用：任何收尾路径（idle/超时/上游错误）都能从子会话消息算出同一口径。
 *  失败一律 undefined（usage 不是交付闸门，绝不阻断收尾）。 */
export async function childUsageSnapshot(run: SubagentRun): Promise<SubagentUsage | undefined> {
  if (!deps || !isOpenCodeSessionId(run.opencodeSessionId)) return undefined
  try {
    const res = await fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/message`, {
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return undefined
    const msgs = (await res.json()) as SubagentUsageMessage[]
    if (!Array.isArray(msgs)) return undefined
    return computeSubagentUsage(msgs, run.startedAt, runMessageWindow(run))
  } catch {
    return undefined
  }
}

/** 子会话 idle：取最后一条 assistant 文本作 summary。 */
export async function summarizeChild(run: SubagentRun): Promise<void> {  // 片 D（2026-09-15）：重派投递在途——run 此刻仍挂在旧子会话 id 上（新会话尚未注册），
  // 旧会话残影事件（如重复 idle）不得把尚在重派链中的 run 提前收尾。
  if (run.reworking) return
  // E 片（2026-09-12）缺陷二防御：无合法子会话 id 就不拼 URL，如实收尾（死因落盘）。
  if (!isOpenCodeSessionId(run.opencodeSessionId)) {
    console.error(
      `[gateway] subagent summarize skipped: id=${run.id} label="${run.label}" reason=invalid opencode session id "${String(run.opencodeSessionId)}"`,
    )
    finishRun(run, "error", "", `子代理会话 id 非法（非 ses 前缀：「${String(run.opencodeSessionId)}」），无法取回结果`)
    return
  }
  let text = ""
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session/${run.opencodeSessionId}/message`, {
      headers: deps!.openCodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const msgs = (await res.json()) as Array<{
        info?: { role?: string; tokens?: unknown }
        parts?: Array<{ type?: string; text?: string }>
      }>
      if (Array.isArray(msgs)) {
        // 2026-10-02 能力片：语义结果＝最后一则有文字的 assistant 讯息（loop 可能停在
        // 纯 tool_use 讯息，回退到最近有文字的一则）；非「全文前 600 字」。
        // D3：统一走 run 时间窗——fork 只认 boundary 之后／创建时间严格大于的消息，
        // 父会话复制过来的旧结论绝不冒充 fork 产出；普通子会话只认 startedAt 之后。
        const window = runMessageWindow(run)
        text = lastAssistantTextWithFallback(msgs, window)
        run.usage = computeSubagentUsage(msgs, run.startedAt, window)
      }
    }
  } catch (e) {
    console.error(`[gateway] subagent summarize failed: id=${run.id}`, e)
  }
  if (text) {
    finishRun(run, "ok", text)
    return
  }
  // 09-18 修复（七路全灭实锤）：上游渠道瞬断时 opencode 吞掉 stream error、子会话以
  // 「正常 idle + 零 assistant 文本」收尾——session.error 事件根本不会出现，下面的
  // 换模重试链因此从不触发，attempt 永远停在 1/5。此处补上对称触发点：零文本且链上
  // 还有备选模型 → 视同渠道故障换模重投；耗尽才如实 finishRun error（语义不变）。
  if (!run.isFork && run.attempt < run.modelChain.length) {
    const nextAttempt = run.attempt + 1
    const oldChild = run.opencodeSessionId
    console.error(
      `[gateway] subagent empty-output (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" — 疑似上游渠道故障，换模重投`,
    )
    run.attempt = nextAttempt
    // 与 session.error 换模路径同款清理：旧子会话摘除 + best-effort DELETE + 映射重置。
    if (isOpenCodeSessionId(oldChild)) {
      byChildOc.delete(oldChild)
      void fetch(`${deps!.openCodeUrl}/session/${oldChild}`, {
        method: "DELETE",
        headers: deps!.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    run.messageRole.clear()
    run.partEmitted.clear()
    run.partKind.clear()
    run.suppressedParts.clear()
    void retryWithNextModel(run, "子代理运行结束但没有产出文本（疑似上游渠道故障）")
    return
  }
  finishRun(run, "error", "", "子代理运行结束但没有产出文本")
}

